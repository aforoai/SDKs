package metering

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestClient_Track(t *testing.T) {
	client := NewClient(Options{
		APIKey:        "test-key",
		BaseURL:       "http://localhost:19999",
		FlushCount:    100,
		FlushInterval: time.Minute,
		MaxRetries:    0,
	})
	defer client.Close()

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

func TestClient_TrackAfterClose(t *testing.T) {
	client := NewClient(Options{
		APIKey:        "test-key",
		BaseURL:       "http://localhost:19999",
		FlushInterval: time.Minute,
	})
	client.Close()

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

	client := NewClient(Options{
		APIKey:        "test-key",
		BaseURL:       srv.URL,
		FlushCount:    100,
		FlushInterval: time.Minute,
		MaxRetries:    0,
	})
	defer client.Close()

	_ = client.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
	_ = client.Track(TrackEvent{CustomerID: "cust_2", MetricName: "api_calls"})

	result := client.Flush()
	if result.Sent != 2 {
		t.Fatalf("expected 2 sent, got %d", result.Sent)
	}
	if client.BufferedCount() != 0 {
		t.Fatalf("expected 0 buffered after flush, got %d", client.BufferedCount())
	}
}

func TestClient_DoubleCloseSafe(t *testing.T) {
	client := NewClient(Options{
		APIKey:        "test-key",
		BaseURL:       "http://localhost:19999",
		FlushInterval: time.Minute,
	})
	client.Close()
	client.Close() // Should not panic
}
