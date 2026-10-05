package mqttmetering

import (
	"net/http/httptest"
	"testing"
)

func TestMQTTExecutionStatusExplicitOnly(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.FlushCount = 100; c.EmitDeliverEvents = true })

	b.RecordPublish("cust_001", "c1", "t/1", 0, false, 1)
	b.RecordPublishWithOptions("cust_001", "c1", "t/1", 0, false, 1, EventOptions{ExecutionStatus: " error "})
	b.RecordDeliverWithOptions("cust_001", "c1", "t/1", 0, false, 1, EventOptions{ExecutionStatus: "success"})
	b.RecordSubscribeWithOptions("cust_001", "c1", "t/#", 1, EventOptions{ExecutionStatus: "blocked"})
	b.RecordUnsubscribeWithOptions("cust_001", "c1", "t/#", EventOptions{ExecutionStatus: "   "})
	b.RecordConnectWithOptions("cust_001", "c1", EventOptions{ExecutionStatus: "timeout"})
	b.RecordDisconnectWithOptions("cust_001", "c1", EventOptions{ExecutionStatus: "cancelled"})
	b.RecordConnectWithOptions("", "c1", EventOptions{ExecutionStatus: "SUCCESS"}) // no customer → no event, no panic
	_ = b.Shutdown()

	evs := r.events()
	want := []any{nil, "ERROR", "SUCCESS", "BLOCKED", nil, "TIMEOUT", "CANCELLED"}
	if len(evs) != len(want) {
		t.Fatalf("got %d events, want %d", len(evs), len(want))
	}
	for i, w := range want {
		got, present := evs[i]["executionStatus"]
		if w == nil && present {
			t.Errorf("event %d: executionStatus must be omitted, got %v", i, got)
		}
		if w != nil && got != w {
			t.Errorf("event %d: executionStatus = %v, want %v", i, got, w)
		}
	}
}

func TestRecordDeliverWithOptionsSkippedByDefault(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.FlushCount = 100 })
	b.RecordDeliverWithOptions("cust_001", "c1", "t/1", 0, false, 1, EventOptions{ExecutionStatus: "SUCCESS"})
	_ = b.Shutdown()
	if n := len(r.events()); n != 0 {
		t.Fatalf("got %d events, want 0 (DELIVER off by default)", n)
	}
}

func TestUnknownExecutionStatusOmittedEventStillSent(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.FlushCount = 100 })
	b.RecordPublishWithOptions("cust_001", "c1", "t/1", 0, false, 1, EventOptions{ExecutionStatus: "done"})
	b.RecordPublishWithOptions("cust_001", "c1", "t/2", 0, false, 1, EventOptions{ExecutionStatus: "SUCCESSFUL_OUTCOME_XYZ"})
	b.RecordPublishWithOptions("cust_001", "c1", "t/3", 0, false, 1, EventOptions{ExecutionStatus: "partial"})
	_ = b.Shutdown()

	evs := r.events()
	want := []any{nil, nil, "PARTIAL"}
	if len(evs) != len(want) {
		t.Fatalf("got %d events, want %d (unknown status must not drop the event)", len(evs), len(want))
	}
	for i, w := range want {
		got, present := evs[i]["executionStatus"]
		if w == nil && present {
			t.Errorf("event %d: unknown executionStatus must be omitted, got %v", i, got)
		}
		if w != nil && got != w {
			t.Errorf("event %d: executionStatus = %v, want %v", i, got, w)
		}
		if evs[i]["customerId"] != "cust_001" {
			t.Errorf("event %d: rest of event not sent intact: %v", i, evs[i])
		}
	}
}
