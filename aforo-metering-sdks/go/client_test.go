package metering

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestClient_Track(t *testing.T) {
	client := mustNewClient(t, Options{
		APIKey:        "test-key",
		BaseURL:       "http://localhost:19999",
		FlushCount:    100,
		FlushInterval: time.Minute,
		MaxRetries:    0,
	})
	defer closeNow(client)

	err := client.Track(TrackEvent{
		CustomerID: "cust_1",
		MetricName: "api_calls",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if client.BufferedCount() != 1 {
		t.Fatalf("expected 1 buffered, got %d", client.BufferedCount())
	}
}

func TestClient_AutoKeysUniquePerTrackCall(t *testing.T) {
	// No caller key = dedup opt-out. Two same-instant identical events must
	// get DISTINCT random keys (the old content-hash fallback collapsed
	// them — the H4 bug Aforo ingest fixed server-side in April 2026).
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	client := mustNewClient(t, Options{
		APIKey:        "test-key",
		BaseURL:       ts.URL,
		FlushCount:    100,
		FlushInterval: time.Minute,
	})

	same := TrackEvent{CustomerID: "cust_1", MetricName: "api_calls", Quantity: 1, OccurredAt: "2026-07-05T00:00:00Z"}
	a, b := same, same
	if err := client.Track(a); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := client.Track(b); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if client.BufferedCount() != 2 {
		t.Fatalf("expected 2 buffered events, got %d", client.BufferedCount())
	}
	flushNow(client)
	evs := srv.events()
	if len(evs) != 2 {
		t.Fatalf("expected 2 sent events, got %d", len(evs))
	}
	if evs[0]["idempotencyKey"] == evs[1]["idempotencyKey"] {
		t.Fatalf("auto keys collapsed for identical same-instant events: %v", evs[0]["idempotencyKey"])
	}
}

func TestClient_TrackAfterClose(t *testing.T) {
	client := mustNewClient(t, Options{
		APIKey:        "test-key",
		BaseURL:       "http://localhost:19999",
		FlushInterval: time.Minute,
	})
	closeNow(client)

	err := client.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	if err != ErrClientClosed {
		t.Fatalf("expected ErrClientClosed, got %v", err)
	}
}

func TestClient_FlushSendsEvents(t *testing.T) {
	var received int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&received, 1)
		w.WriteHeader(202)
	}))
	defer srv.Close()

	client := mustNewClient(t, Options{
		APIKey:        "test-key",
		BaseURL:       srv.URL,
		FlushCount:    100,
		FlushInterval: time.Minute,
		MaxRetries:    0,
	})
	defer closeNow(client)

	_ = client.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	_ = client.Track(TrackEvent{CustomerID: "cust_2", MetricName: "api_calls"})

	result := flushNow(client)
	if result.Sent != 2 {
		t.Fatalf("expected 2 sent, got %d", result.Sent)
	}
	if client.BufferedCount() != 0 {
		t.Fatalf("expected 0 buffered after flush, got %d", client.BufferedCount())
	}
}

func TestClient_DoubleCloseSafe(t *testing.T) {
	client := mustNewClient(t, Options{
		APIKey:        "test-key",
		BaseURL:       "http://localhost:19999",
		FlushInterval: time.Minute,
	})
	closeNow(client)
	closeNow(client) // Should not panic
}

// The ingestor authenticates the tenant key from X-API-Key only. A key sent as
// Authorization: Bearer is parsed as a JWT and rejected 401 -- even when
// X-API-Key is also present -- so the SDK must send X-API-Key alone.
func TestClient_SendsAPIKeyHeaderNotBearer(t *testing.T) {
	var gotKey, gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("X-API-Key")
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.WriteHeader(202)
	}))
	defer srv.Close()

	client := mustNewClient(t, Options{APIKey: "test-key", BaseURL: srv.URL, FlushCount: 100, FlushInterval: time.Minute})
	defer closeNow(client)

	_ = client.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	flushNow(client)

	if gotPath != "/v1/ingest/batch" {
		t.Errorf("path = %q, want /v1/ingest/batch", gotPath)
	}
	if gotKey != "test-key" {
		t.Errorf("X-API-Key = %q, want test-key", gotKey)
	}
	if gotAuth != "" {
		t.Errorf("Authorization must not be sent, got %q", gotAuth)
	}
}
