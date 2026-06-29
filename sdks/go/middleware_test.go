package metering

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPMiddleware_CapturesEvents(t *testing.T) {
	var received int32
	ingestor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&received, 1)
		w.WriteHeader(202)
	}))
	defer ingestor.Close()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte("ok"))
	})

	wrapped := HTTPMiddleware(handler, MiddlewareOptions{
		APIKey:  "test-key",
		BaseURL: ingestor.URL,
		ClientOptions: &Options{
			APIKey:        "test-key",
			BaseURL:       ingestor.URL,
			FlushCount:    1,
			FlushInterval: time.Minute,
			MaxRetries:    0,
		},
	})

	req := httptest.NewRequest("GET", "/api/v1/data", nil)
	req.Header.Set("X-Customer-Id", "cust_123")
	w := httptest.NewRecorder()

	wrapped.ServeHTTP(w, req)

	// Give async flush time
	time.Sleep(200 * time.Millisecond)

	if atomic.LoadInt32(&received) < 1 {
		t.Fatal("expected at least 1 request to ingestor")
	}
}

func TestHTTPMiddleware_ExcludesHealthPaths(t *testing.T) {
	var received int32
	ingestor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&received, 1)
		w.WriteHeader(202)
	}))
	defer ingestor.Close()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})

	wrapped := HTTPMiddleware(handler, MiddlewareOptions{
		APIKey:  "test-key",
		BaseURL: ingestor.URL,
		ClientOptions: &Options{
			APIKey:        "test-key",
			BaseURL:       ingestor.URL,
			FlushCount:    1,
			FlushInterval: time.Minute,
		},
	})

	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("X-Customer-Id", "cust_123")
	w := httptest.NewRecorder()

	wrapped.ServeHTTP(w, req)
	time.Sleep(100 * time.Millisecond)

	if atomic.LoadInt32(&received) != 0 {
		t.Fatal("expected no requests for excluded path")
	}
}

func TestHTTPMiddleware_SkipsWithoutCustomerID(t *testing.T) {
	var received int32
	ingestor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&received, 1)
		w.WriteHeader(202)
	}))
	defer ingestor.Close()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})

	wrapped := HTTPMiddleware(handler, MiddlewareOptions{
		APIKey:  "test-key",
		BaseURL: ingestor.URL,
		ClientOptions: &Options{
			APIKey:        "test-key",
			BaseURL:       ingestor.URL,
			FlushCount:    1,
			FlushInterval: time.Minute,
		},
	})

	req := httptest.NewRequest("GET", "/api/data", nil)
	// No customer ID header
	w := httptest.NewRecorder()

	wrapped.ServeHTTP(w, req)
	time.Sleep(100 * time.Millisecond)

	if atomic.LoadInt32(&received) != 0 {
		t.Fatal("expected no requests without customer ID")
	}
}

func TestNormalizePath(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"/users/42", "/users/:id"},
		{"/api/v1/users", "/api/v1/users"},
		{"/", "/"},
		{"/users/550e8400-e29b-41d4-a716-446655440000", "/users/:id"},
		{"/orders/123/items/456", "/orders/:id/items/:id"},
	}

	for _, tt := range tests {
		result := normalizePath(tt.input)
		if result != tt.expected {
			t.Errorf("normalizePath(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestChiMiddleware(t *testing.T) {
	mw := ChiMiddleware(MiddlewareOptions{APIKey: "test-key"})
	if mw == nil {
		t.Fatal("expected non-nil middleware")
	}
}
