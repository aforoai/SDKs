package ingest

// Regression tests for the 2026-11-09 SDK review (R3, R4, R5, #5, #11).

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAPIKeyIsTrimmedAndRefusedWithWhitespaceOrControlChars(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("X-API-Key")
		w.WriteHeader(202)
	}))
	defer srv.Close()
	c, _ := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) { cfg.APIKey = "  sk_live_abc\n" })
	_ = c.Enqueue(ev("k1"))
	if _, err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got != "sk_live_abc" {
		t.Fatalf("sent key %q, want the trimmed key", got)
	}
	for _, bad := range []string{"sk_live abc", "sk_live\tabc", "sk_live\nabc", "sk_live\x00abc", "sk_live\x7fabc", "sk abc"} {
		_, err := New(Config{BaseURL: srv.URL, APIKey: bad})
		if err == nil {
			t.Errorf("key %q accepted", bad)
			continue
		}
		if strings.Contains(err.Error(), "abc") || strings.Contains(err.Error(), "sk_") {
			t.Errorf("error shows the key: %v", err)
		}
	}
}

// net/http refuses a header value with a control character without echoing
// it, and scrubKey removes the key even in its %q-escaped form.
func TestInvalidHeaderErrorsNeverCarryTheKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	key := "sk_live_SECRET\nX"
	req, _ := http.NewRequest("POST", srv.URL, nil)
	req.Header.Set("X-API-Key", key)
	_, err := http.DefaultClient.Do(req)
	if err == nil || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("net/http error shows the key: %v", err)
	}
	quoted := fmt.Errorf("value %q refused", key)
	if s := scrubKey(quoted, key).Error(); strings.Contains(s, "SECRET") {
		t.Fatalf("scrubKey left the escaped key: %s", s)
	}
}

func TestFitIntFieldsLeavesOutOfRangeFieldsOff(t *testing.T) {
	var logs []string
	var mu sync.Mutex
	c, _ := newTestClient(t, "http://localhost:1", newFakeHooks(0), func(cfg *Config) {
		cfg.Logf = func(f string, a ...any) { mu.Lock(); logs = append(logs, fmt.Sprintf(f, a...)); mu.Unlock() }
	})
	ev := map[string]any{"executionDurationMs": int64(2_160_000_000), "statusCode": 40000, "messageCount": 7,
		"dataBytes": int64(5_000_000_000_000), "mqttQos": 1, "responseTimeMs": float64(3e9), "customerId": "c"}
	removed := c.FitIntFields(ev)
	if want := []string{"executionDurationMs", "responseTimeMs", "statusCode"}; !reflect.DeepEqual(removed, want) {
		t.Fatalf("removed %v, want %v", removed, want)
	}
	for _, k := range []string{"messageCount", "dataBytes", "mqttQos", "customerId"} {
		if _, ok := ev[k]; !ok {
			t.Errorf("%s removed", k)
		}
	}
	c.FitIntFields(map[string]any{"statusCode": 99999})
	mu.Lock()
	defer mu.Unlock()
	n := 0
	for _, l := range logs {
		if strings.Contains(l, "statusCode") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("statusCode WARN logged %d times, want once: %v", n, logs)
	}
	if !IntFits("statusCode", 32767) || IntFits("statusCode", 32768) || !IntFits("executionDurationMs", 2147483647) || IntFits("executionDurationMs", 2147483648) {
		t.Fatal("range bounds wrong")
	}
}

func TestRateLimit429SplitsTheBatchInOrder(t *testing.T) {
	s := &server{handle: func(w http.ResponseWriter, keys []string, n int) {
		if len(keys) > 2 {
			w.Header().Set("X-RateLimit-Limit", "2")
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(429)
			return
		}
		w.WriteHeader(202)
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, d := newTestClient(t, srv.URL, newFakeHooks(0))
	for i := 1; i <= 5; i++ {
		_ = c.Enqueue(ev(fmt.Sprintf("k%d", i)))
	}
	_, _ = c.Flush(context.Background()) // 429: split and held
	if _, err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	sizes := []int{}
	for _, b := range s.batches {
		sizes = append(sizes, len(b))
	}
	if !reflect.DeepEqual(sizes, []int{5, 2, 2, 1}) {
		t.Fatalf("request sizes %v, want [5 2 2 1]", sizes)
	}
	if got := strings.Join(s.allKeys()[5:], ","); got != "k1,k2,k3,k4,k5" {
		t.Fatalf("parts out of order: %s", got)
	}
	if c.Len() != 0 || len(d.events) != 0 {
		t.Fatalf("queued %d, dropped %d", c.Len(), len(d.events))
	}
	// Later batches are full size again.
	for i := 6; i <= 7; i++ {
		_ = c.Enqueue(ev(fmt.Sprintf("k%d", i)))
	}
	_, _ = c.Flush(context.Background())
	if last := s.batches[len(s.batches)-1]; len(last) != 2 {
		t.Fatalf("after the split: batch of %d, want 2", len(last))
	}
}

func TestRateLimit429WithoutLimitHeaderIsRetriedWhole(t *testing.T) {
	s := &server{handle: func(w http.ResponseWriter, keys []string, n int) {
		if n == 1 {
			w.WriteHeader(429)
			return
		}
		w.WriteHeader(202)
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	c, _ := newTestClient(t, srv.URL, newFakeHooks(0))
	for i := 1; i <= 4; i++ {
		_ = c.Enqueue(ev(fmt.Sprintf("k%d", i)))
	}
	_, _ = c.Flush(context.Background())
	if len(s.batches) != 2 || len(s.batches[1]) != 4 {
		t.Fatalf("batches %v, want the same 4 events retried", s.batches)
	}
}

func TestOnErrorHearsEveryTrackAfterClose(t *testing.T) {
	var mu sync.Mutex
	n := 0
	c, _ := newTestClient(t, "http://localhost:1", newFakeHooks(0), func(cfg *Config) {
		cfg.OnError = func(e *TransportError) {
			if e.Kind == KindClosed {
				mu.Lock()
				n++
				mu.Unlock()
			}
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_ = c.Close(ctx)
	for i := 0; i < 3; i++ {
		if err := c.Enqueue(ev(fmt.Sprint(i))); !errors.Is(err, ErrClosed) {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if n != 3 {
		t.Fatalf("OnError(KindClosed) called %d times, want 3", n)
	}
}

func TestClientGoStringHidesKey(t *testing.T) {
	c, _ := newTestClient(t, "http://localhost:1", newFakeHooks(0))
	if s := fmt.Sprintf("%#v", c); strings.Contains(s, "sk_secret_key_123") {
		t.Fatalf("%%#v shows the key: %s", s)
	}
}

func TestTryEnqueueHandsBackEvictedWithoutReporting(t *testing.T) {
	c, d := newTestClient(t, "http://localhost:1", newFakeHooks(0), func(cfg *Config) { cfg.MaxQueueSize = 1 })
	if ev1, err := c.TryEnqueue(ev("a")); err != nil || len(ev1) != 0 {
		t.Fatal(ev1, err)
	}
	evicted, err := c.TryEnqueue(ev("b"))
	if err != nil || len(evicted) != 1 || evicted[0].Key != "a" {
		t.Fatalf("evicted %v err %v", evicted, err)
	}
	if len(d.events) != 0 {
		t.Fatal("TryEnqueue reported a drop")
	}
}
