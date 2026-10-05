package wsmetering

import (
	"net/http/httptest"
	"testing"
)

func TestWebSocketExecutionStatusExplicitOnly(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.PerFrameEvents = true })

	plain := b.Open("cust_001", nil)
	b.RecordFrame(plain, "CLIENT_TO_SERVER", "TEXT", 3)
	b.Close(plain, 1006) // abnormal close — still no derived status

	withOpts := b.OpenWithOptions("cust_001", nil, EventOptions{ExecutionStatus: " success "})
	b.RecordFrameWithOptions(withOpts, "CLIENT_TO_SERVER", "TEXT", 3, EventOptions{ExecutionStatus: "   "})
	b.CloseWithOptions(withOpts, 1000, EventOptions{ExecutionStatus: "cancelled"})
	_ = b.Shutdown()

	evs := r.events()
	want := []any{nil, nil, nil, "SUCCESS", nil, "CANCELLED"}
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

func TestRecordFrameWithOptionsNoEventWhenPerFrameOff(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv)
	id := b.Open("cust_001", nil)
	b.RecordFrameWithOptions(id, "CLIENT_TO_SERVER", "TEXT", 3, EventOptions{ExecutionStatus: "ERROR"})
	_ = b.Shutdown()
	if n := len(r.events()); n != 1 {
		t.Fatalf("got %d events, want only CONNECTION_OPENED", n)
	}
}

func TestUnknownExecutionStatusOmittedEventStillSent(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv)
	id := b.OpenWithOptions("cust_001", nil, EventOptions{ExecutionStatus: "done"})
	b.CloseWithOptions(id, 1000, EventOptions{ExecutionStatus: "SUCCESSFUL_OUTCOME_XYZ"})
	_ = b.Shutdown()

	evs := r.events()
	if len(evs) != 2 {
		t.Fatalf("got %d events, want 2 (unknown status must not drop the event)", len(evs))
	}
	for i, ev := range evs {
		if v, present := ev["executionStatus"]; present {
			t.Errorf("event %d: unknown executionStatus must be omitted, got %v", i, v)
		}
		if ev["customerId"] != "cust_001" {
			t.Errorf("event %d: rest of event not sent intact: %v", i, ev)
		}
	}
}
