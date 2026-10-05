package mqttmetering

import (
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Merged-behaviour tests: the transport rules (no retry on a non-retryable
// 4xx, per-event rejection in a 2xx partial response) and client-side
// validation all report through the drop-observability shape
// (DroppedCount + OnDrop with a reason).

type dropSink struct {
	mu      sync.Mutex
	events  []map[string]any
	reasons []DropReason
}

func (d *dropSink) hook(events []map[string]any, reason DropReason) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.events = append(d.events, events...)
	d.reasons = append(d.reasons, reason)
}

func (d *dropSink) snapshot() ([]map[string]any, []DropReason) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]map[string]any(nil), d.events...), append([]DropReason(nil), d.reasons...)
}

func TestMergedNonRetryable4xxDropsBatchAsRejected(t *testing.T) {
	srv := &scriptedServer{replies: []scriptedReply{{status: 400, body: `{"errors":[{"index":0,"message":"unknown metric"}]}`}}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	drops := &dropSink{}
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.OnDrop = drops.hook; c.FlushCount = 100 })
	emit(b)
	_ = shutdown(b)

	if n := srv.callCount(); n != 1 {
		t.Errorf("attempts = %d, want 1 (a 400 is not retried)", n)
	}
	evs, reasons := drops.snapshot()
	if b.DroppedCount() != 1 || len(evs) != 1 || len(reasons) != 1 || reasons[0] != DropRejected {
		t.Fatalf("DroppedCount=%d events=%d reasons=%v, want 1 / 1 / [rejected]", b.DroppedCount(), len(evs), reasons)
	}
	if k, _ := evs[0]["idempotencyKey"].(string); k == "" {
		t.Error("dropped event lost its idempotency key")
	}
}

func TestMergedRetryableFailureDropsAsRetryExhausted(t *testing.T) {
	srv := &scriptedServer{replies: []scriptedReply{{status: 503}}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	drops := &dropSink{}
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.OnDrop = drops.hook; c.FlushCount = 100 })
	b.retryBackoffBase = time.Millisecond
	emit(b)
	_ = shutdown(b)

	if n := srv.callCount(); n != maxSendAttempts {
		t.Errorf("attempts = %d, want %d", n, maxSendAttempts)
	}
	_, reasons := drops.snapshot()
	if b.DroppedCount() != 1 || len(reasons) != 1 || reasons[0] != DropRetryExhausted {
		t.Fatalf("DroppedCount=%d reasons=%v, want 1 / [retry_exhausted]", b.DroppedCount(), reasons)
	}
}

// Retries re-send the body marshalled once: every attempt carries the same key.
func TestMergedRetriesReuseIdempotencyKeys(t *testing.T) {
	srv := &scriptedServer{replies: []scriptedReply{{status: 503}, {status: 202}}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100 })
	b.retryBackoffBase = time.Millisecond
	emit(b)
	_ = shutdown(b)

	evs := srv.events()
	if len(evs) != 2 {
		t.Fatalf("server saw %d event deliveries, want 2 (one retry)", len(evs))
	}
	if evs[0]["idempotencyKey"] != evs[1]["idempotencyKey"] || evs[0]["idempotencyKey"] == "" {
		t.Errorf("retry changed the idempotency key: %v vs %v", evs[0]["idempotencyKey"], evs[1]["idempotencyKey"])
	}
	if b.DroppedCount() != 0 {
		t.Errorf("DroppedCount = %d, want 0", b.DroppedCount())
	}
}

func TestMergedPartialFailureDropsOnlyNamedEvents(t *testing.T) {
	srv := &scriptedServer{replies: []scriptedReply{{
		status: 202,
		body:   `{"accepted":2,"duplicates":0,"failed":1,"errors":[{"index":1,"message":"unknown metric"}]}`,
	}}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	drops := &dropSink{}
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.OnDrop = drops.hook; c.FlushCount = 100 })
	emit(b)
	emit(b)
	emit(b)
	_ = shutdown(b)

	sent := srv.events()
	if len(sent) != 3 {
		t.Fatalf("server saw %d events, want 3", len(sent))
	}
	evs, reasons := drops.snapshot()
	if b.DroppedCount() != 1 || len(evs) != 1 || reasons[0] != DropRejected {
		t.Fatalf("DroppedCount=%d events=%d reasons=%v, want 1 / 1 / [rejected]", b.DroppedCount(), len(evs), reasons)
	}
	if evs[0]["idempotencyKey"] != sent[1]["idempotencyKey"] {
		t.Errorf("dropped event is not the one at index 1")
	}
}

func TestMergedPartialFailureWithoutIndexCountsOnly(t *testing.T) {
	srv := &scriptedServer{replies: []scriptedReply{{status: 202, body: `{"accepted":1,"duplicates":0,"failed":1,"errors":[]}`}}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	drops := &dropSink{}
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.OnDrop = drops.hook; c.FlushCount = 100 })
	emit(b)
	emit(b)
	_ = shutdown(b)

	evs, _ := drops.snapshot()
	if b.DroppedCount() != 1 || len(evs) != 0 {
		t.Fatalf("DroppedCount=%d OnDrop events=%d, want 1 / 0 (the SDK does not guess which event failed)", b.DroppedCount(), len(evs))
	}
}

func TestMergedInvalidEventIsDroppedNotSent(t *testing.T) {
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	drops := &dropSink{}
	sink := &errSink{}
	b := newContractBilling(t, ts.URL, sink, func(c *Config) { c.OnDrop = drops.hook; c.FlushCount = 100 })
	emitInvalid(b)
	_ = shutdown(b)

	if n := len(srv.events()); n != 0 {
		t.Errorf("server saw %d events, want 0", n)
	}
	evs, reasons := drops.snapshot()
	if b.DroppedCount() != 4 || len(evs) != 4 {
		t.Fatalf("DroppedCount=%d OnDrop events=%d, want 4 / 4", b.DroppedCount(), len(evs))
	}
	for i, r := range reasons {
		if r != DropInvalid {
			t.Errorf("reason[%d] = %q, want %q", i, r, DropInvalid)
		}
	}
	if !strings.Contains(sink.joined(), "invalid event dropped") {
		t.Errorf("OnError did not report the invalid event: %q", sink.joined())
	}
}

func TestMergedLengthLimitsCountCharactersNotBytes(t *testing.T) {
	if msg := tooLong("customerId", strings.Repeat("é", 64), maxCustomerIDLen); msg != "" {
		t.Errorf("64 multi-byte characters must be accepted, got %q", msg)
	}
	if msg := tooLong("customerId", strings.Repeat("é", 65), maxCustomerIDLen); !strings.Contains(msg, "customerId") || !strings.Contains(msg, "64") {
		t.Errorf("65 characters must be refused with a message naming the field and limit, got %q", msg)
	}
}

func TestMergedExecutionStatusAndProductTypeInOneOption(t *testing.T) {
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100 })
	emit(b, EventOptions{ProductType: " agentic_api ", ExecutionStatus: " partial "})
	emit(b, EventOptions{ExecutionStatus: "not-a-status"})
	_ = shutdown(b)

	evs := srv.events()
	if len(evs) != 2 {
		t.Fatalf("server saw %d events, want 2 (an unknown status never drops the event)", len(evs))
	}
	if evs[0]["productType"] != "AGENTIC_API" || evs[0]["executionStatus"] != "PARTIAL" {
		t.Errorf("event 0 productType=%v executionStatus=%v, want AGENTIC_API / PARTIAL", evs[0]["productType"], evs[0]["executionStatus"])
	}
	if evs[1]["executionStatus"] == "NOT-A-STATUS" {
		t.Errorf("unknown executionStatus was sent")
	}
}

// Whitespace topic, over-long customer id (twice). Over-long topics and client
// ids are truncated and sent, not invalid; see labels_test.go.
func emitInvalid(b *Billing) {
	b.RecordPublish("cust_1", "client-1", "   ", 1, false, 1)
	b.RecordPublish(strings.Repeat("c", 65), "client-1", "a/b", 1, false, 1)
	b.RecordSubscribe(strings.Repeat("c", 65), "client-1", "a/b", 1)
	b.RecordConnect(strings.Repeat("c", 65), "client-1")
}
