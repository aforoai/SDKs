package metering

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func dropTestOptions(baseURL string) Options {
	return Options{
		APIKey:          "test-key",
		BaseURL:         baseURL,
		FlushCount:      100,
		FlushInterval:   time.Minute, // tests flush explicitly
		MaxRetries:      1,
		Timeout:         time.Second,
		ShutdownTimeout: time.Second,
		hooks:           fastHooks(),
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

	c := mustNewClient(t, opts)

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

// An outage no longer loses the batch: it stays queued with its keys. When
// Close's deadline passes with the ingestor still down, the events are
// reported as DropShutdown — keys intact, so a replay is dedup-safe.
func TestOutageKeepsEventsThenCloseReportsShutdownWithKeys(t *testing.T) {
	rec := &dropRecorder{}
	opts := dropTestOptions("http://localhost:1") // connection refused
	opts.OnDrop = rec.hook
	opts.ShutdownTimeout = 200 * time.Millisecond

	c, err := NewClient(opts)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls", IdempotencyKey: "k1"})
	_ = c.Track(TrackEvent{CustomerID: "cust_2", MetricName: "api_calls", IdempotencyKey: "k2"})

	result, err := c.Flush(context.Background())
	if !errors.Is(err, ErrIngestUnavailable) || result.Pending != 2 {
		t.Fatalf("Flush() = %+v, %v; want Pending=2 and ErrIngestUnavailable", result, err)
	}
	if got := c.DroppedCount(); got != 0 {
		t.Fatalf("DroppedCount = %d during an outage, want 0", got)
	}
	if err := c.Close(context.Background()); !errors.Is(err, ErrShutdownIncomplete) {
		t.Fatalf("Close = %v, want ErrShutdownIncomplete", err)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.reasons) != 1 || rec.reasons[0] != DropShutdown {
		t.Fatalf("reasons = %v, want [shutdown]", rec.reasons)
	}
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

	c := mustNewClient(t, opts)
	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	result := flushNow(c)

	if result.Rejected != 1 {
		t.Fatalf("Flush().Rejected = %d, want 1", result.Rejected)
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

func TestDefaultNoHookOutageKeepsEventQueued(t *testing.T) {
	c := mustNewClient(t, dropTestOptions("http://localhost:1"))

	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	result := flushNow(c)

	if result.Sent != 0 || result.Pending != 1 {
		t.Fatalf("Flush() = %+v, want Sent=0 Pending=1", result)
	}
	if got := c.DroppedCount(); got != 0 {
		t.Fatalf("DroppedCount = %d, want 0", got)
	}
}

func TestPanickingHookNeverBreaksFlush(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
	}))
	defer srv.Close()
	opts := dropTestOptions(srv.URL)
	opts.OnDrop = func(events []TrackEvent, reason DropReason) {
		panic("hook bug")
	}

	c := mustNewClient(t, opts)
	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	result := flushNow(c) // must not panic

	if result.Rejected != 1 {
		t.Fatalf("Flush().Rejected = %d, want 1", result.Rejected)
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

	c := mustNewClient(t, opts)
	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	result := flushNow(c)

	if result.Sent != 1 || result.Rejected != 0 || result.Pending != 0 {
		t.Fatalf("Flush() = %+v, want Sent=1", result)
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

// Track after Close does not panic: it returns ErrClientClosed and reports
// the event as DropClosed (counted, key kept).
func TestTrackAfterCloseReportsClosed(t *testing.T) {
	rec := &dropRecorder{}
	opts := dropTestOptions("http://localhost:1")
	opts.OnDrop = rec.hook
	c := mustNewClient(t, opts)
	closeNow(c)
	if err := c.Track(TrackEvent{CustomerID: "c", MetricName: "m", IdempotencyKey: "late"}); err != ErrClientClosed {
		t.Fatalf("Track after Close = %v, want ErrClientClosed", err)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.reasons) != 1 || rec.reasons[0] != DropClosed || rec.events[0].IdempotencyKey != "late" {
		t.Fatalf("drops = %v %v, want one DropClosed with key late", rec.reasons, rec.events)
	}
	if c.DroppedCount() != 1 {
		t.Fatalf("DroppedCount = %d", c.DroppedCount())
	}
}
