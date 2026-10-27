package metering

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// OnError receives a typed *TransportError (Kind + the events) and may call
// Close without deadlocking the sender.
func TestOptionsOnErrorIsTypedAndMayClose(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
	defer srv.Close()
	var mu sync.Mutex
	var got []*TransportError
	var c *AforoClient
	c = mustNewClient(t, Options{
		APIKey: "k", BaseURL: srv.URL, FlushInterval: time.Hour, MaxRetries: -1,
		ShutdownTimeout: 200 * time.Millisecond,
		OnError: func(e *TransportError) {
			mu.Lock()
			got = append(got, e)
			first := len(got) == 1
			mu.Unlock()
			if first {
				_ = c.Close(context.Background())
			}
		},
	})
	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls", IdempotencyKey: "k1"})
	done := make(chan error, 1)
	go func() { _, err := c.Flush(context.Background()); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrIngestUnavailable) {
			t.Fatalf("Flush = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close from OnError deadlocked")
	}
	waitClosed := time.Now().Add(5 * time.Second)
	for !c.IsClosed() && time.Now().Before(waitClosed) {
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) == 0 || got[0].Kind != KindOutage || got[0].Status != 503 || len(got[0].Events) != 1 || got[0].Events[0].IdempotencyKey != "k1" {
		t.Fatalf("OnError got %+v", got)
	}
	if !errors.Is(got[0], ErrIngestUnavailable) {
		t.Fatal("errors.Is(outage, ErrIngestUnavailable) = false")
	}
}

// OnAccepted gets the envelope-unwrapped body so callers can read fields
// such as killedSessionIds.
func TestOptionsOnAccepted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(202)
		fmt.Fprint(w, `{"success":true,"data":{"accepted":1,"killedSessionIds":["sess_9"]}}`)
	}))
	defer srv.Close()
	var body json.RawMessage
	var events []TrackEvent
	c := mustNewClient(t, Options{APIKey: "k", BaseURL: srv.URL, FlushInterval: time.Hour,
		OnAccepted: func(b json.RawMessage, e []TrackEvent) { body, events = b, e }})
	_ = c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	if _, err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	var data struct {
		Killed []string `json:"killedSessionIds"`
	}
	if json.Unmarshal(body, &data) != nil || len(data.Killed) != 1 || data.Killed[0] != "sess_9" || len(events) != 1 {
		t.Fatalf("body %s events %d", body, len(events))
	}
}

// An event that cannot be serialized is refused at Track (invalid), counted,
// and never reaches a batch.
func TestUnserializableEventRejectedAtTrack(t *testing.T) {
	var drops []DropReason
	c := mustNewClient(t, Options{APIKey: "k", BaseURL: "http://127.0.0.1:1", FlushInterval: time.Hour,
		OnDrop: func(_ []TrackEvent, r DropReason) { drops = append(drops, r) }})
	for _, v := range []any{math.NaN(), math.Inf(1), func() {}, make(chan int)} {
		err := c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "m", Metadata: map[string]interface{}{"x": v}})
		if !errors.Is(err, ErrInvalidEvent) {
			t.Fatalf("%T: err = %v, want ErrInvalidEvent", v, err)
		}
	}
	if c.BufferedCount() != 0 || c.DroppedCount() != 4 || len(drops) != 4 || drops[0] != DropInvalid {
		t.Fatalf("buffered=%d dropped=%d drops=%v", c.BufferedCount(), c.DroppedCount(), drops)
	}
}
