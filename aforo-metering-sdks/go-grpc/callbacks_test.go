package grpcmetering

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"sync"
	"testing"
)

// OnError delivers sending problems as *TransportError (errors.As, branch on
// Kind) carrying the events; OnAccepted receives the unwrapped 2xx body.
func TestCallbacksTypedErrorAndAccepted(t *testing.T) {
	srv := &scriptedServer{replies: []scriptedReply{
		{status: 503},
		{status: 202, body: `{"success":true,"data":{"accepted":1,"killedSessionIds":["s1"]}}`},
	}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	var mu sync.Mutex
	var typed []*TransportError
	var accepted json.RawMessage
	var acceptedEvents int
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) {
		c.MaxRetries = -1
		c.FlushCount = 100 // send only on the explicit Flush calls below
		c.OnError = func(err error) {
			var te *TransportError
			if errors.As(err, &te) {
				mu.Lock()
				typed = append(typed, te)
				mu.Unlock()
			}
		}
		c.OnAccepted = func(body json.RawMessage, events []map[string]any) {
			mu.Lock()
			accepted, acceptedEvents = body, len(events)
			mu.Unlock()
		}
	})
	emit(b)
	if err := b.Flush(context.Background()); !errors.Is(err, ErrIngestUnavailable) {
		t.Fatalf("first Flush = %v, want ErrIngestUnavailable", err)
	}
	if err := b.Flush(context.Background()); err != nil {
		t.Fatalf("second Flush = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(typed) != 1 || typed[0].Kind != KindOutage || typed[0].Status != 503 || len(typed[0].Events) != 1 {
		t.Fatalf("typed errors = %+v, want one outage with the event", typed)
	}
	if k, _ := typed[0].Events[0]["idempotencyKey"].(string); k == "" {
		t.Fatal("event in the error lost its key")
	}
	if !errors.Is(typed[0], ErrIngestUnavailable) {
		t.Fatal("errors.Is(outage, ErrIngestUnavailable) = false")
	}
	var data struct {
		Killed []string `json:"killedSessionIds"`
	}
	if json.Unmarshal(accepted, &data) != nil || len(data.Killed) != 1 || acceptedEvents != 1 {
		t.Fatalf("OnAccepted body %s events %d", accepted, acceptedEvents)
	}
}
