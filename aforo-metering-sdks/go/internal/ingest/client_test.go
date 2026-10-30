package ingest

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeHooks never waits on the wall clock: Sleep records the delay and returns
// at once, After never fires (tests drive the flusher with Flush), Now is fixed.
type fakeHooks struct {
	mu     sync.Mutex
	sleeps []time.Duration
	now    time.Time
	rnd    float64
}

func newFakeHooks(rnd float64) *fakeHooks {
	return &fakeHooks{now: time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC), rnd: rnd}
}

func (f *fakeHooks) hooks() Hooks {
	return Hooks{
		Now: func() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.now },
		Sleep: func(ctx context.Context, d time.Duration) error {
			f.mu.Lock()
			f.sleeps = append(f.sleeps, d)
			f.mu.Unlock()
			return ctx.Err()
		},
		After: func(time.Duration) (<-chan time.Time, func() bool) {
			return make(chan time.Time), func() bool { return true }
		},
		Rand: func() float64 { return f.rnd },
	}
}

func (f *fakeHooks) recorded() []time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]time.Duration(nil), f.sleeps...)
}

type drops struct {
	mu      sync.Mutex
	events  []Event
	reasons []DropReason
}

func (d *drops) hook(events []Event, reason DropReason) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.events = append(d.events, events...)
	for range events {
		d.reasons = append(d.reasons, reason)
	}
}

func (d *drops) byReason(r DropReason) []Event {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []Event
	for i, e := range d.events {
		if d.reasons[i] == r {
			out = append(out, e)
		}
	}
	return out
}

type server struct {
	encodings []string // Content-Encoding of each request ("" when none)
	wire      [][]byte // each request body as sent
	mu        sync.Mutex
	inFlight  int
	maxIn     int
	batches   [][]string // idempotency keys per request
	handle    func(w http.ResponseWriter, keys []string, n int)
	calls     atomic.Int32
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.inFlight++
	if s.inFlight > s.maxIn {
		s.maxIn = s.inFlight
	}
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.inFlight--; s.mu.Unlock() }()
	var body struct {
		Events []struct {
			Key string `json:"idempotencyKey"`
		} `json:"events"`
	}
	raw, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.encodings = append(s.encodings, r.Header.Get("Content-Encoding"))
	s.wire = append(s.wire, raw)
	s.mu.Unlock()
	if r.Header.Get("Content-Encoding") == "gzip" {
		// Decoded like usage-ingestor's GzipRequestFilter (wave 8).
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		raw, _ = io.ReadAll(zr)
	}
	_ = json.Unmarshal(raw, &body)
	keys := make([]string, len(body.Events))
	for i, e := range body.Events {
		keys[i] = e.Key
	}
	n := int(s.calls.Add(1))
	s.mu.Lock()
	s.batches = append(s.batches, keys)
	s.mu.Unlock()
	if s.handle != nil {
		s.handle(w, keys, n)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *server) allKeys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, b := range s.batches {
		out = append(out, b...)
	}
	return out
}

func ev(key string) Event {
	return Event{Key: key, Body: json.RawMessage(fmt.Sprintf(`{"idempotencyKey":%q}`, key)), Ref: key}
}

func newTestClient(t *testing.T, url string, h *fakeHooks, mutate ...func(*Config)) (*Client, *drops) {
	t.Helper()
	d := &drops{}
	cfg := Config{
		BaseURL:         url,
		APIKey:          "sk_secret_key_123",
		FlushCount:      100,
		FlushInterval:   time.Hour,
		ShutdownTimeout: 2 * time.Second,
		Timeout:         2 * time.Second,
		OnDrop:          d.hook,
		Logf:            func(string, ...any) {},
		Hooks:           h.hooks(),
	}
	for _, m := range mutate {
		m(&cfg)
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// Shutdown keeps retrying until its deadline; tests whose server is down
	// on purpose must not wait out the full ShutdownTimeout at cleanup.
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		_ = c.Close(ctx)
	})
	return c, d
}

func TestEnqueueStartsNoGoroutinesAndOneFlusherSends(t *testing.T) {
	gate := make(chan struct{})
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) {
		<-gate
		w.WriteHeader(202)
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, _ := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) { cfg.FlushCount = 10 })

	before := runtime.NumGoroutine()
	for i := 0; i < 1000; i++ { // 100× over the threshold
		if err := c.Enqueue(ev(fmt.Sprintf("k%d", i))); err != nil {
			t.Fatal(err)
		}
	}
	// One request in flight at most; the old core spawned `go Flush()` per Track.
	if extra := runtime.NumGoroutine() - before; extra > 8 {
		t.Fatalf("Enqueue started %d goroutines; want none beyond the flusher's request", extra)
	}
	close(gate)
	if _, err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.maxIn != 1 {
		t.Fatalf("max concurrent requests = %d, want 1 (single flusher)", s.maxIn)
	}
}

func TestDefaultsFollowTransportPolicy(t *testing.T) {
	cfg := Config{}
	cfg.applyDefaults()
	if cfg.FlushCount != 500 || cfg.MaxQueueSize != 10_000 || cfg.RetryBase != 500*time.Millisecond ||
		cfg.MaxRetryDelay != 30*time.Second || cfg.MaxRetryAfter != 60*time.Second ||
		cfg.ShutdownTimeout != 5*time.Second || cfg.Timeout != 10*time.Second || cfg.MaxRetries != 3 ||
		cfg.TargetBodyBytes != 4<<20 || cfg.BreakerInitial != 5*time.Second || cfg.BreakerMax != 5*time.Minute {
		t.Fatalf("defaults drifted from transportPolicy: %+v", cfg)
	}
	cfg = Config{FlushCount: 5000}
	cfg.applyDefaults()
	if cfg.FlushCount != 1000 {
		t.Fatalf("FlushCount clamp = %d, want 1000", cfg.FlushCount)
	}
}

func TestFullJitterBackoff(t *testing.T) {
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) { w.WriteHeader(503) }}
	srv := httptest.NewServer(s)
	defer srv.Close()
	h := newFakeHooks(0.5)
	c, _ := newTestClient(t, srv.URL, h, func(cfg *Config) { cfg.MaxRetries = 3 })
	_ = c.Enqueue(ev("a"))
	if _, err := c.Flush(context.Background()); !errors.Is(err, ErrIngestUnavailable) {
		t.Fatalf("err = %v, want ErrIngestUnavailable", err)
	}
	want := []time.Duration{250 * time.Millisecond, 500 * time.Millisecond, time.Second}
	got := h.recorded()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("sleeps = %v, want %v (0.5 × min(30s, 500ms·2^n))", got, want)
	}
	if s.calls.Load() != 4 {
		t.Fatalf("attempts = %d, want 4", s.calls.Load())
	}
}

func TestRetryAfterBothFormsAndCap(t *testing.T) {
	h := newFakeHooks(0)
	cases := []struct {
		header string
		want   time.Duration
	}{
		{"2", 2 * time.Second},
		{h.now.Add(3 * time.Second).Format(http.TimeFormat), 3 * time.Second},
		{"600", 60 * time.Second},
		{"soon", 0},
	}
	for _, tc := range cases {
		t.Run(tc.header, func(t *testing.T) {
			hh := newFakeHooks(0)
			hh.now = h.now
			s := &server{handle: func(w http.ResponseWriter, _ []string, n int) {
				if n == 1 {
					w.Header().Set("Retry-After", tc.header)
					w.WriteHeader(429)
					return
				}
				w.WriteHeader(202)
			}}
			srv := httptest.NewServer(s)
			defer srv.Close()
			c, _ := newTestClient(t, srv.URL, hh)
			_ = c.Enqueue(ev("a"))
			if _, err := c.Flush(context.Background()); err != nil {
				t.Fatal(err)
			}
			if got := hh.recorded(); len(got) != 1 || got[0] != tc.want {
				t.Fatalf("sleeps = %v, want [%v]", got, tc.want)
			}
		})
	}
}

func TestOutageRequeuesWithSameKeysThenRecovers(t *testing.T) {
	var down atomic.Bool
	down.Store(true)
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) {
		if down.Load() {
			w.WriteHeader(502)
			return
		}
		w.WriteHeader(202)
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, d := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) { cfg.MaxRetries = 1 })
	for i := 0; i < 5; i++ {
		_ = c.Enqueue(ev(fmt.Sprintf("k%d", i)))
	}
	if res, err := c.Flush(context.Background()); !errors.Is(err, ErrIngestUnavailable) || res.Pending != 5 {
		t.Fatalf("res = %+v err = %v, want Pending=5", res, err)
	}
	if c.Len() != 5 || c.Dropped() != 0 || !c.Stats().BreakerOpen {
		t.Fatalf("after outage: len=%d dropped=%d breaker=%v; want 5, 0, open", c.Len(), c.Dropped(), c.Stats().BreakerOpen)
	}
	down.Store(false)
	res, err := c.Flush(context.Background())
	if err != nil || res.Sent != 5 || c.Stats().BreakerOpen {
		t.Fatalf("recovery: res=%+v err=%v breaker=%v", res, err, c.Stats().BreakerOpen)
	}
	keys := s.allKeys()
	if strings.Join(keys[len(keys)-5:], ",") != "k0,k1,k2,k3,k4" || strings.Join(keys[:5], ",") != "k0,k1,k2,k3,k4" {
		t.Fatalf("keys changed across the outage: %v", keys)
	}
	if len(d.byReason(DropRetryExhausted)) != 0 {
		t.Fatal("no event may be dropped during an outage")
	}
}

func TestAuthFailureIsAnOutageNotADrop(t *testing.T) {
	var logs []string
	var mu sync.Mutex
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) { w.WriteHeader(401) }}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, _ := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) {
		cfg.Logf = func(f string, a ...any) { mu.Lock(); logs = append(logs, fmt.Sprintf(f, a...)); mu.Unlock() }
	})
	_ = c.Enqueue(ev("a"))
	_, _ = c.Flush(context.Background())
	_, _ = c.Flush(context.Background())
	if s.calls.Load() != 2 {
		t.Fatalf("401 must not be retried within a flush: %d calls", s.calls.Load())
	}
	if c.Len() != 1 || c.Dropped() != 0 {
		t.Fatalf("401 must keep the event: len=%d dropped=%d", c.Len(), c.Dropped())
	}
	mu.Lock()
	defer mu.Unlock()
	errLines := 0
	for _, l := range logs {
		if strings.Contains(l, "ERROR") && strings.Contains(l, "401") {
			errLines++
		}
		if strings.Contains(l, "sk_secret_key_123") {
			t.Fatalf("API key leaked into a log line: %q", l)
		}
	}
	if errLines != 1 {
		t.Fatalf("want one ERROR line per breaker opening, got %d: %v", errLines, logs)
	}
}

func Test413SplitsAndRejectsASingleOversizedEvent(t *testing.T) {
	s := &server{handle: func(w http.ResponseWriter, keys []string, _ int) {
		hasBig := false
		for _, k := range keys {
			hasBig = hasBig || k == "big"
		}
		if len(keys) > 2 || hasBig {
			w.WriteHeader(413)
			return
		}
		w.WriteHeader(202)
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, d := newTestClient(t, srv.URL, newFakeHooks(0))
	for _, k := range []string{"a", "b", "c", "d", "big"} {
		_ = c.Enqueue(ev(k))
	}
	res, err := c.Flush(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Sent != 4 || res.Rejected != 1 {
		t.Fatalf("res = %+v, want 4 sent and 1 rejected", res)
	}
	if r := d.byReason(DropRejected); len(r) != 1 || r[0].Key != "big" {
		t.Fatalf("rejected = %v", r)
	}
}

func TestPerEventRetryableIsRequeuedAndOthersRejected(t *testing.T) {
	s := &server{handle: func(w http.ResponseWriter, keys []string, n int) {
		w.WriteHeader(202)
		if n == 1 {
			fmt.Fprint(w, `{"success":true,"data":{"accepted":1,"failed":2,"errors":[{"index":0,"message":"db busy","retryable":true},{"index":1,"message":"unknown metric","retryable":false}]}}`)
		}
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, d := newTestClient(t, srv.URL, newFakeHooks(0))
	for _, k := range []string{"r", "x", "ok"} {
		_ = c.Enqueue(ev(k))
	}
	res, _ := c.Flush(context.Background())
	if res.Sent != 1 || res.Rejected != 1 || c.Len() != 1 {
		t.Fatalf("res=%+v len=%d", res, c.Len())
	}
	if r := d.byReason(DropRejected); len(r) != 1 || r[0].Key != "x" {
		t.Fatalf("rejected = %v", r)
	}
	if _, err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	keys := s.allKeys()
	if keys[len(keys)-1] != "r" || c.Len() != 0 {
		t.Fatalf("retryable event not resent with its key: %v", keys)
	}
}

func TestOther4xxRejectsWithoutRetry(t *testing.T) {
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) {
		w.WriteHeader(400)
		fmt.Fprint(w, `{"detail":"bad"}`)
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, d := newTestClient(t, srv.URL, newFakeHooks(0))
	_ = c.Enqueue(ev("a"))
	res, _ := c.Flush(context.Background())
	if res.Rejected != 1 || s.calls.Load() != 1 || len(d.byReason(DropRejected)) != 1 {
		t.Fatalf("res=%+v calls=%d", res, s.calls.Load())
	}
}

func TestCloseIsBoundedByDeadlineAndReportsLeftovers(t *testing.T) {
	hang := make(chan struct{})
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) { <-hang }}
	srv := httptest.NewServer(s)
	defer srv.Close()
	defer close(hang) // runs before srv.Close, which waits for handlers
	c, d := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) {
		cfg.Timeout = 10 * time.Second
		cfg.ShutdownTimeout = 200 * time.Millisecond
	})
	for i := 0; i < 3; i++ {
		_ = c.Enqueue(ev(fmt.Sprintf("k%d", i)))
	}
	start := time.Now()
	err := c.Close(context.Background())
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("Close took %v; the 200 ms shutdown deadline was not honoured", took)
	}
	if !errors.Is(err, ErrShutdownIncomplete) {
		t.Fatalf("err = %v, want ErrShutdownIncomplete", err)
	}
	if got := d.byReason(DropShutdown); len(got) != 3 || got[0].Key != "k0" {
		t.Fatalf("shutdown leftovers = %v", got)
	}
	if err := c.Enqueue(ev("late")); !errors.Is(err, ErrClosed) {
		t.Fatalf("Enqueue after Close = %v, want ErrClosed", err)
	}
	if got := d.byReason(DropClosed); len(got) != 1 {
		t.Fatalf("closed drops = %v", got)
	}
	// A second Close returns the first one's result and runs no second drain.
	if err2 := c.Close(context.Background()); err2 != err {
		t.Fatalf("second Close = %v, want the first result %v", err2, err)
	}
}

func TestCloseHonoursCallerContextDeadline(t *testing.T) {
	hang := make(chan struct{})
	srv := httptest.NewServer(&server{handle: func(w http.ResponseWriter, _ []string, _ int) { <-hang }})
	defer srv.Close()
	defer close(hang)
	c, _ := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) { cfg.ShutdownTimeout = time.Minute })
	_ = c.Enqueue(ev("a"))
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_ = c.Close(ctx)
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("Close ignored the caller deadline: %v", took)
	}
}

func TestOverflowEvictsOldest(t *testing.T) {
	c, d := newTestClient(t, "http://127.0.0.1:1", newFakeHooks(0), func(cfg *Config) { cfg.MaxQueueSize = 2 })
	for _, k := range []string{"k1", "k2", "k3"} {
		_ = c.Enqueue(ev(k))
	}
	if got := d.byReason(DropOverflow); len(got) != 1 || got[0].Key != "k1" {
		t.Fatalf("overflow = %v", got)
	}
	if c.Len() != 2 {
		t.Fatalf("len = %d", c.Len())
	}
}

func TestBatchSplitByTargetBodyBytes(t *testing.T) {
	s := &server{}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, _ := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) { cfg.TargetBodyBytes = 70 })
	for i := 0; i < 4; i++ {
		_ = c.Enqueue(ev(fmt.Sprintf("k%d", i))) // each body is 23 bytes
	}
	if _, err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.calls.Load() != 2 {
		t.Fatalf("requests = %d, want 2 (two events fit under 70 bytes)", s.calls.Load())
	}
}

func TestWakeDuringBreakerDoesNotSend(t *testing.T) {
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) { w.WriteHeader(503) }}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, _ := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) { cfg.FlushCount = 1; cfg.MaxRetries = -1 })
	_ = c.Enqueue(ev("a")) // wakes the flusher → one request → breaker opens
	deadline := time.Now().Add(2 * time.Second)
	for !c.Stats().BreakerOpen && time.Now().Before(deadline) {
		runtime.Gosched()
	}
	if !c.Stats().BreakerOpen {
		t.Fatal("breaker did not open")
	}
	calls := s.calls.Load()
	for i := 0; i < 50; i++ {
		_ = c.Enqueue(ev(fmt.Sprintf("w%d", i)))
	}
	// The flusher is holding for the (fake, never-firing) cooldown.
	time.Sleep(50 * time.Millisecond)
	if s.calls.Load() != calls {
		t.Fatalf("a wake during the breaker cooldown sent a request (%d → %d)", calls, s.calls.Load())
	}
}

func TestBaseURLMustBeHTTPS(t *testing.T) {
	for _, u := range []string{"http://api.example.com", "ftp://x", "not a url"} {
		if _, err := New(Config{BaseURL: u, APIKey: "k"}); err == nil {
			t.Fatalf("%q accepted", u)
		}
	}
	for _, u := range []string{"https://api.example.com", "http://localhost:8080", "http://127.0.0.1:1", "http://[::1]:9"} {
		c, err := New(Config{BaseURL: u, APIKey: "k", Logf: func(string, ...any) {}})
		if err != nil {
			t.Fatalf("%q refused: %v", u, err)
		}
		_ = c.Close(context.Background())
	}
	c, err := New(Config{BaseURL: "http://api.example.com", APIKey: "k", AllowInsecureHTTP: true})
	if err != nil {
		t.Fatalf("AllowInsecureHTTP ignored: %v", err)
	}
	_ = c.Close(context.Background())
}

func TestAPIKeyNeverPrinted(t *testing.T) {
	cfg := Config{BaseURL: "https://x", APIKey: "sk_secret_key_123"}
	for _, s := range []string{fmt.Sprint(cfg), fmt.Sprintf("%+v", cfg), fmt.Sprintf("%#v", cfg)} {
		if strings.Contains(s, "sk_secret_key_123") {
			t.Fatalf("key printed: %s", s)
		}
	}
	c, err := New(Config{BaseURL: "https://x", APIKey: "sk_secret_key_123"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	if strings.Contains(fmt.Sprint(c), "sk_secret_key_123") || strings.Contains(fmt.Sprintf("%+v", c), "sk_secret_key_123") {
		t.Fatal("client String() printed the key")
	}
}

func TestPanickingOnDropIsRecovered(t *testing.T) {
	c, _ := newTestClient(t, "http://127.0.0.1:1", newFakeHooks(0), func(cfg *Config) {
		cfg.MaxQueueSize = 1
		cfg.OnDrop = func([]Event, DropReason) { panic("boom") }
	})
	_ = c.Enqueue(ev("a"))
	_ = c.Enqueue(ev("b")) // overflow → hook panics → must not escape
	if c.Dropped() != 1 {
		t.Fatalf("dropped = %d", c.Dropped())
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if d, ok := ParseRetryAfter("-1", now); ok || d != 0 {
		t.Fatal("negative accepted")
	}
	if d, ok := ParseRetryAfter(now.Add(-time.Hour).Format(http.TimeFormat), now); !ok || d != 0 {
		t.Fatalf("past date = %v %v", d, ok)
	}
}
