package ingest

// One test per row of contract/TRANSPORT-SPEC.md "Edge cases every core
// handles the same way". Clock, sleep and random source are the fake hooks
// from client_test.go; the only wall-clock waits are request deadlines of a
// few hundred milliseconds against servers that stall on purpose.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Rule: the request deadline covers reading the response body. A 202 whose
// body stalls (or drips) is cut off at Timeout and the batch is retried with
// its keys, not counted as delivered.
func TestEdgeDeadlineCoversResponseBody(t *testing.T) {
	for _, mode := range []string{"stall", "drip"} {
		t.Run(mode, func(t *testing.T) {
			release := make(chan struct{})
			s := &server{handle: func(w http.ResponseWriter, _ []string, n int) {
				if n > 1 {
					w.WriteHeader(202)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(202)
				fmt.Fprint(w, `{"success":tr`)
				w.(http.Flusher).Flush()
				if mode == "stall" {
					<-release
					return
				}
				for i := 0; i < 1000; i++ { // one byte every 50 ms: no single read stalls long
					select {
					case <-release:
						return
					case <-time.After(50 * time.Millisecond):
					}
					if _, err := fmt.Fprint(w, " "); err != nil {
						return
					}
					w.(http.Flusher).Flush()
				}
			}}
			srv := httptest.NewServer(s)
			defer srv.Close()
			defer close(release)
			c, _ := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) {
				cfg.Timeout = 300 * time.Millisecond
				cfg.MaxRetries = -1
			})
			_ = c.Enqueue(ev("a"))
			start := time.Now()
			res, err := c.Flush(context.Background())
			if took := time.Since(start); took > 3*time.Second {
				t.Fatalf("Flush took %v; the 300 ms deadline did not cover the body", took)
			}
			if !errors.Is(err, ErrIngestUnavailable) || res.Sent != 0 || c.Len() != 1 {
				t.Fatalf("res=%+v err=%v len=%d; want the cut-off batch requeued, not counted as sent", res, err, c.Len())
			}
			if keys := c.QueuedKeys(); keys[0] != "a" {
				t.Fatalf("key changed: %v", keys)
			}
		})
	}
}

// Rule: redirects are never followed, with the core's own client or a
// caller-supplied one. A 3xx is an outage logged at ERROR with the target
// host; the batch is requeued and the breaker opens.
func TestEdgeRedirectIsNeverFollowed(t *testing.T) {
	for _, own := range []bool{true, false} {
		t.Run(fmt.Sprintf("ownClient=%v", own), func(t *testing.T) {
			var targetHits atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				targetHits.Add(1)
				w.WriteHeader(202)
			}))
			defer target.Close()
			s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) {
				w.Header().Set("Location", target.URL+"/v1/ingest/batch")
				w.WriteHeader(307)
			}}
			srv := httptest.NewServer(s)
			defer srv.Close()
			var mu sync.Mutex
			var logs []string
			c, d := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) {
				if !own {
					cfg.HTTPClient = &http.Client{}
				}
				cfg.Logf = func(f string, a ...any) { mu.Lock(); logs = append(logs, fmt.Sprintf(f, a...)); mu.Unlock() }
			})
			_ = c.Enqueue(ev("a"))
			_, err := c.Flush(context.Background())
			if targetHits.Load() != 0 {
				t.Fatal("the redirect was followed: the API key reached another host")
			}
			if !errors.Is(err, ErrIngestUnavailable) || c.Len() != 1 || !c.Stats().BreakerOpen || len(d.events) != 0 {
				t.Fatalf("err=%v len=%d breaker=%v drops=%d; want an outage with the event kept", err, c.Len(), c.Stats().BreakerOpen, len(d.events))
			}
			if s.calls.Load() != 1 {
				t.Fatalf("a 3xx must not be retried within a flush: %d calls", s.calls.Load())
			}
			mu.Lock()
			defer mu.Unlock()
			host := strings.TrimPrefix(target.URL, "http://")
			found := false
			for _, l := range logs {
				if strings.Contains(l, "ERROR") && strings.Contains(l, host) {
					found = true
				}
				if strings.Contains(l, "sk_secret_key_123") {
					t.Fatalf("key logged: %q", l)
				}
			}
			if !found {
				t.Fatalf("no ERROR line naming %s: %v", host, logs)
			}
		})
	}
}

// Rule: every 5xx is retried, not only 500/502/503/504.
func TestEdgeEvery5xxIsRetried(t *testing.T) {
	for _, code := range []int{501, 505, 507, 599} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			s := &server{handle: func(w http.ResponseWriter, _ []string, n int) {
				if n == 1 {
					w.WriteHeader(code)
					return
				}
				w.WriteHeader(202)
			}}
			srv := httptest.NewServer(s)
			defer srv.Close()
			c, d := newTestClient(t, srv.URL, newFakeHooks(0))
			_ = c.Enqueue(ev("a"))
			res, err := c.Flush(context.Background())
			if err != nil || res.Sent != 1 || len(d.events) != 0 || s.calls.Load() != 2 {
				t.Fatalf("HTTP %d: res=%+v err=%v drops=%d calls=%d; want a retry then success", code, res, err, len(d.events), s.calls.Load())
			}
		})
	}
}

// Rule: a per-event retryable in a 2xx is resent after the jittered backoff,
// at most MaxRetries times, then treated as an outage. It never loops.
func TestEdgePerEventRetryableIsCappedThenOutage(t *testing.T) {
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) {
		w.WriteHeader(202)
		fmt.Fprint(w, `{"data":{"accepted":0,"failed":1,"errors":[{"index":0,"message":"busy","retryable":true}]}}`)
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	h := newFakeHooks(0.5)
	c, d := newTestClient(t, srv.URL, h, func(cfg *Config) { cfg.MaxRetries = 2 })
	_ = c.Enqueue(ev("r"))
	for i := 1; i <= 2; i++ {
		if _, err := c.Flush(context.Background()); err != nil {
			t.Fatalf("flush %d: %v", i, err)
		}
		if s.calls.Load() != int32(i) {
			t.Fatalf("flush %d sent %d requests; a per-event retry must wait for the backoff, not loop", i, s.calls.Load())
		}
		if c.Stats().BreakerOpen {
			t.Fatalf("breaker opened after %d resend(s); MaxRetries is 2", i)
		}
	}
	_, err := c.Flush(context.Background())
	if !errors.Is(err, ErrIngestUnavailable) || !c.Stats().BreakerOpen || c.Len() != 1 || len(d.events) != 0 {
		t.Fatalf("after the cap: err=%v breaker=%v len=%d drops=%d; want an outage with the event kept", err, c.Stats().BreakerOpen, c.Len(), len(d.events))
	}
	if c.QueuedKeys()[0] != "r" {
		t.Fatal("key changed")
	}
}

// Rule: breaker cooldown is max(250 ms, random(0, ceiling)), ceiling 5 s·2^n
// capped at 5 min.
func TestEdgeBreakerCooldownFormula(t *testing.T) {
	cases := []struct {
		rnd  float64
		n    int
		want time.Duration
	}{
		{0, 0, 250 * time.Millisecond},
		{0.01, 0, 250 * time.Millisecond},
		{0.5, 0, 2500 * time.Millisecond},
		{0.5, 1, 5 * time.Second},
		{0.999, 20, time.Duration(0.999 * float64(5*time.Minute))},
	}
	for _, tc := range cases {
		cfg := Config{Hooks: Hooks{Rand: func() float64 { return tc.rnd }}}
		cfg.applyDefaults()
		c := &Client{cfg: cfg}
		if got := c.breakerCooldown(tc.n); got != tc.want {
			t.Errorf("rand=%v n=%d: cooldown %v, want %v", tc.rnd, tc.n, got, tc.want)
		}
	}
}

// Rule: one successful send resets the breaker count; a per-event retry cap
// reached right after a 2xx does not.
func TestEdgePerEventCapDoesNotResetBreakerCount(t *testing.T) {
	var phase atomic.Int32
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) {
		switch phase.Load() {
		case 0:
			w.WriteHeader(503)
		case 1:
			w.WriteHeader(202)
			fmt.Fprint(w, `{"data":{"failed":1,"errors":[{"index":0,"retryable":true}]}}`)
		default:
			w.WriteHeader(202)
		}
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, _ := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) { cfg.MaxRetries = -1 })
	_ = c.Enqueue(ev("a"))
	_, _ = c.Flush(context.Background()) // 503 → outage #1
	phase.Store(1)
	_, _ = c.Flush(context.Background()) // 2xx asking again, cap 0 → outage #2
	if c.outages != 2 {
		t.Fatalf("outage count %d after a capped per-event retry, want 2 (not reset by the 2xx)", c.outages)
	}
	phase.Store(2)
	if _, err := c.Flush(context.Background()); err != nil || c.outages != 0 || c.Stats().BreakerOpen {
		t.Fatalf("a clean 2xx must reset the count: err=%v outages=%d", err, c.outages)
	}
}

// Rule: an explicit Flush while the breaker is open makes one attempt now;
// an outage reopens the breaker.
func TestEdgeFlushWhileBreakerOpenAttemptsOnce(t *testing.T) {
	var down atomic.Bool
	down.Store(true)
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) {
		if down.Load() {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(202)
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, _ := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) { cfg.MaxRetries = -1 })
	_ = c.Enqueue(ev("a"))
	_, _ = c.Flush(context.Background())
	if !c.Stats().BreakerOpen {
		t.Fatal("breaker did not open")
	}
	_, err := c.Flush(context.Background())
	if s.calls.Load() != 2 || !errors.Is(err, ErrIngestUnavailable) || !c.Stats().BreakerOpen {
		t.Fatalf("calls=%d err=%v breaker=%v; want one attempt that reopens the breaker", s.calls.Load(), err, c.Stats().BreakerOpen)
	}
	down.Store(false)
	if res, err := c.Flush(context.Background()); err != nil || res.Sent != 1 {
		t.Fatalf("recovery flush: %+v %v", res, err)
	}
}

// Rule: shutdown after an outage keeps retrying with backoff until the
// deadline instead of stopping at the first outage.
func TestEdgeShutdownKeepsRetryingAfterOutage(t *testing.T) {
	s := &server{handle: func(w http.ResponseWriter, _ []string, n int) {
		if n <= 5 {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(202)
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, d := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) { cfg.MaxRetries = 1 })
	for i := 0; i < 3; i++ {
		_ = c.Enqueue(ev(fmt.Sprintf("k%d", i)))
	}
	if err := c.Close(context.Background()); err != nil {
		t.Fatalf("Close = %v; the ingestor recovered before the deadline", err)
	}
	if len(d.byReason(DropShutdown)) != 0 {
		t.Fatalf("events reported as shutdown although the ingestor recovered: %v", d.byReason(DropShutdown))
	}
}

// Rule: every event of a batch taken off the queue is accounted for exactly
// once — sent, requeued or reported — including the unsent half of a 413
// split and a request cut off by Close. Pending Flush callers complete.
func TestEdgeSplitBatchInFlightAtShutdownIsAccounted(t *testing.T) {
	hang := make(chan struct{})
	s := &server{handle: func(w http.ResponseWriter, keys []string, _ int) {
		if len(keys) > 2 {
			w.WriteHeader(413)
			return
		}
		if keys[0] == "k0" {
			w.WriteHeader(202)
			return
		}
		<-hang // the second half never answers
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	defer close(hang)
	c, d := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) {
		cfg.Timeout = 10 * time.Second
		cfg.ShutdownTimeout = 300 * time.Millisecond
	})
	for i := 0; i < 4; i++ {
		_ = c.Enqueue(ev(fmt.Sprintf("k%d", i)))
	}
	flushed := make(chan FlushResult, 1)
	go func() { r, _ := c.Flush(context.Background()); flushed <- r }()
	waitFor(t, func() bool { return s.calls.Load() >= 3 }) // 413, first half, hanging second half
	err := c.Close(context.Background())
	if !errors.Is(err, ErrShutdownIncomplete) {
		t.Fatalf("Close = %v", err)
	}
	select {
	case <-flushed:
	case <-time.After(3 * time.Second):
		t.Fatal("the pending Flush never completed")
	}
	sent := map[string]bool{"k0": true, "k1": true}
	reported := map[string]int{}
	for _, e := range d.byReason(DropShutdown) {
		reported[e.Key]++
	}
	for i := 0; i < 4; i++ {
		k := fmt.Sprintf("k%d", i)
		if sent[k] == (reported[k] > 0) || reported[k] > 1 {
			t.Fatalf("%s: sent=%v reported %d time(s); want exactly one outcome (%v)", k, sent[k], reported[k], reported)
		}
	}
}

// Rule: callbacks may call Flush or Close without deadlocking.
func TestEdgeCallbacksMayCallFlushAndClose(t *testing.T) {
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) { w.WriteHeader(400) }}
	srv := httptest.NewServer(s)
	defer srv.Close()
	var c *Client
	var calls atomic.Int32
	c, _ = newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) {
		cfg.OnDrop = func(_ []Event, r DropReason) {
			if r == DropRejected && calls.Add(1) == 1 {
				_, _ = c.Flush(context.Background())
				_ = c.Close(context.Background())
				_ = c.Close(context.Background())
			}
		}
	})
	_ = c.Enqueue(ev("a"))
	done := make(chan struct{})
	go func() { _, _ = c.Flush(context.Background()); _ = c.Close(context.Background()); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Flush/Close called from OnDrop deadlocked the sender")
	}
	if !c.Closed() {
		t.Fatal("Close from the callback did not close the client")
	}
}

// Rule: errors[] is authoritative when `failed` is missing or 0, and a
// retryable event is never counted as sent.
func TestEdgeErrorsArrayIsAuthoritative(t *testing.T) {
	cases := []struct {
		name, body             string
		sent, rejected, queued int
	}{
		{"failed missing", `{"data":{"accepted":1,"errors":[{"index":0,"message":"bad","retryable":false}]}}`, 1, 1, 0},
		{"failed zero", `{"data":{"accepted":1,"failed":0,"errors":[{"index":1,"retryable":true}]}}`, 1, 0, 1},
		{"failed too small", `{"data":{"failed":1,"errors":[{"index":0,"retryable":true},{"index":1,"retryable":false}]}}`, 0, 1, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &server{handle: func(w http.ResponseWriter, _ []string, n int) {
				w.WriteHeader(202)
				if n == 1 {
					fmt.Fprint(w, tc.body)
				}
			}}
			srv := httptest.NewServer(s)
			defer srv.Close()
			c, d := newTestClient(t, srv.URL, newFakeHooks(0))
			_ = c.Enqueue(ev("e0"))
			_ = c.Enqueue(ev("e1"))
			res, _ := c.Flush(context.Background())
			if res.Sent != tc.sent || res.Rejected != tc.rejected || c.Len() != tc.queued || len(d.byReason(DropRejected)) != tc.rejected {
				t.Fatalf("res=%+v queued=%d rejectedDrops=%d; want sent %d rejected %d queued %d",
					res, c.Len(), len(d.byReason(DropRejected)), tc.sent, tc.rejected, tc.queued)
			}
		})
	}
}

// Rule: Retry-After delta-seconds may be fractional; a past HTTP-date is 0.
func TestEdgeRetryAfterFractional(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for v, want := range map[string]time.Duration{"1.5": 1500 * time.Millisecond, "0.25": 250 * time.Millisecond, "2": 2 * time.Second} {
		if d, ok := ParseRetryAfter(v, now); !ok || d != want {
			t.Errorf("%q = %v %v, want %v", v, d, ok, want)
		}
	}
	for _, v := range []string{"-1", "1e3", "NaN", "Inf", "0x10", ".5", "1."} {
		if _, ok := ParseRetryAfter(v, now); ok {
			t.Errorf("%q accepted", v)
		}
	}
	if d, ok := ParseRetryAfter(now.Add(-time.Minute).Format(http.TimeFormat), now); !ok || d != 0 {
		t.Errorf("past date = %v %v, want 0", d, ok)
	}
}

// Rule: a second Close returns the first one's result and runs no second
// drain, also when the first Close was clean.
func TestEdgeSecondCloseReturnsFirstResult(t *testing.T) {
	s := &server{}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, _ := newTestClient(t, srv.URL, newFakeHooks(0))
	_ = c.Enqueue(ev("a"))
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	calls := s.calls.Load()
	if err := c.Close(context.Background()); err != nil || s.calls.Load() != calls {
		t.Fatalf("second Close = %v, calls %d→%d", err, calls, s.calls.Load())
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met within 5s")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
