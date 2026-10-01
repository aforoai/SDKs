package metering

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func dropTestOptions(baseURL string) Options {
	return Options{
		APIKey:        "test-key",
		BaseURL:       baseURL,
		FlushCount:    100,
		FlushInterval: time.Minute, // long — control flushing manually
		MaxRetries:    1,           // defaults() floors 0 to 3; keep the retry envelope tiny
		RetryBase:     time.Millisecond,
		Timeout:       time.Second,
	}
}

type dropRecorder struct {
	mu      sync.Mutex
	events  []TrackEvent
	reasons []DropReason
}

func (r *dropRecorder) hook(events []TrackEvent, reason DropReason) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, events...)
	r.reasons = append(r.reasons, reason)
}

func TestOverflowEvictsOldestCountsAndFiresHook(t *testing.T) {
	rec := &dropRecorder{}
	opts := dropTestOptions("http://localhost:1") // never reached in this test
	opts.MaxQueueSize = 2
	opts.OnDrop = rec.hook

	c := NewClient(opts)
	defer func() { c.closed = true }() // avoid network flush on Close

	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls", IdempotencyKey: "k1"})
	_ = c.Track(TrackEvent{CustomerID: "cust_2", MetricName: "api_calls", IdempotencyKey: "k2"})
	_ = c.Track(TrackEvent{CustomerID: "cust_3", MetricName: "api_calls", IdempotencyKey: "k3"})

	if got := c.DroppedCount(); got != 1 {
		t.Fatalf("DroppedCount = %d, want 1", got)
	}
	if got := c.BufferedCount(); got != 2 {
		t.Fatalf("BufferedCount = %d, want 2", got)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.reasons) != 1 || rec.reasons[0] != DropOverflow {
		t.Fatalf("reasons = %v, want [overflow]", rec.reasons)
	}
	if len(rec.events) != 1 || rec.events[0].IdempotencyKey != "k1" {
		t.Fatalf("dropped events = %v, want the oldest (k1)", rec.events)
	}
}

func TestSendFailureDropsBatchCountsAndFiresHook(t *testing.T) {
	rec := &dropRecorder{}
	opts := dropTestOptions("http://localhost:1") // connection refused
	opts.OnDrop = rec.hook

	c := NewClient(opts)
	defer func() { c.closed = true }()

	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls", IdempotencyKey: "k1"})
	_ = c.Track(TrackEvent{CustomerID: "cust_2", MetricName: "api_calls", IdempotencyKey: "k2"})

	result := c.Flush()
	if result.Failed != 2 {
		t.Fatalf("Flush().Failed = %d, want 2", result.Failed)
	}
	if got := c.DroppedCount(); got != 2 {
		t.Fatalf("DroppedCount = %d, want 2", got)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.reasons) != 1 || rec.reasons[0] != DropRetryExhausted {
		t.Fatalf("reasons = %v, want [retry_exhausted]", rec.reasons)
	}
	// Events keep their keys — dedup-safe replay via Track() is possible
	if len(rec.events) != 2 || rec.events[0].IdempotencyKey != "k1" || rec.events[1].IdempotencyKey != "k2" {
		t.Fatalf("dropped events = %v, want [k1 k2]", rec.events)
	}
}

func TestRejected4xxFiresHookWithRejectedReason(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	rec := &dropRecorder{}
	opts := dropTestOptions(srv.URL)
	opts.OnDrop = rec.hook

	c := NewClient(opts)
	defer func() { c.closed = true }()

	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	result := c.Flush()

	if result.Failed != 1 {
		t.Fatalf("Flush().Failed = %d, want 1", result.Failed)
	}
	if got := c.DroppedCount(); got != 1 {
		t.Fatalf("DroppedCount = %d, want 1", got)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.reasons) != 1 || rec.reasons[0] != DropRejected {
		t.Fatalf("reasons = %v, want [rejected]", rec.reasons)
	}
}

func TestDefaultNoHookCountsDropsAndResultUnchanged(t *testing.T) {
	c := NewClient(dropTestOptions("http://localhost:1"))
	defer func() { c.closed = true }()

	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	result := c.Flush()

	// Same result values as before the hardening
	if result.Sent != 0 || result.Failed != 1 {
		t.Fatalf("Flush() = %+v, want Sent=0 Failed=1", result)
	}
	if got := c.DroppedCount(); got != 1 {
		t.Fatalf("DroppedCount = %d, want 1", got)
	}
}

func TestPanickingHookNeverBreaksFlush(t *testing.T) {
	opts := dropTestOptions("http://localhost:1")
	opts.OnDrop = func(events []TrackEvent, reason DropReason) {
		panic("hook bug")
	}

	c := NewClient(opts)
	defer func() { c.closed = true }()

	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	result := c.Flush() // must not panic

	if result.Failed != 1 {
		t.Fatalf("Flush().Failed = %d, want 1", result.Failed)
	}
	if got := c.DroppedCount(); got != 1 {
		t.Fatalf("DroppedCount = %d, want 1", got)
	}
}

func TestHappyPathUnchangedNoDrops(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	rec := &dropRecorder{}
	opts := dropTestOptions(srv.URL)
	opts.OnDrop = rec.hook

	c := NewClient(opts)
	defer c.Close()

	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	result := c.Flush()

	if result.Sent != 1 || result.Failed != 0 {
		t.Fatalf("Flush() = %+v, want Sent=1 Failed=0", result)
	}
	if got := c.DroppedCount(); got != 0 {
		t.Fatalf("DroppedCount = %d, want 0", got)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.reasons) != 0 {
		t.Fatalf("hook fired on happy path: %v", rec.reasons)
	}
}
