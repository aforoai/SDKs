package metering

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// newIngestorAndClient starts a fake ingestor counting requests and a client
// pointing at it.
func newIngestorAndClient(t *testing.T) (*AforoClient, *int32) {
	t.Helper()
	var received int32
	ingestor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&received, 1)
		w.WriteHeader(202)
	}))
	t.Cleanup(ingestor.Close)
	client := mustNewClient(t, Options{APIKey: "test-key", BaseURL: ingestor.URL, FlushCount: 100, FlushInterval: time.Minute})
	return client, &received
}

func TestHTTPMiddleware_CapturesEvents(t *testing.T) {
	client, received := newIngestorAndClient(t)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	})
	wrapped, err := HTTPMiddleware(handler, client, MiddlewareOptions{TrustCustomerHeader: true})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/api/v1/data", nil)
	req.Header.Set("X-Customer-Id", "cust_123")
	wrapped.ServeHTTP(httptest.NewRecorder(), req)
	flushNow(client)

	if atomic.LoadInt32(received) < 1 {
		t.Fatal("expected at least 1 request to ingestor")
	}
}

func TestHTTPMiddleware_ExcludesHealthPaths(t *testing.T) {
	client, received := newIngestorAndClient(t)
	wrapped, err := HTTPMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}), client, MiddlewareOptions{TrustCustomerHeader: true})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("X-Customer-Id", "cust_123")
	wrapped.ServeHTTP(httptest.NewRecorder(), req)
	flushNow(client)

	if atomic.LoadInt32(received) != 0 {
		t.Fatal("expected no requests for excluded path")
	}
	if client.DroppedCount() != 0 {
		t.Fatal("an excluded path is not a drop")
	}
}

func TestHTTPMiddleware_SkipsWithoutCustomerID(t *testing.T) {
	client, received := newIngestorAndClient(t)
	wrapped, err := HTTPMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}), client, MiddlewareOptions{TrustCustomerHeader: true})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, httptest.NewRequest("GET", "/api/data", nil)) // no customer header
	flushNow(client)

	if atomic.LoadInt32(received) != 0 {
		t.Fatal("expected no requests without customer ID")
	}
	if rec.Code != 200 {
		t.Fatalf("the request was blocked: %d", rec.Code)
	}
	if client.DroppedCount() != 1 {
		t.Fatalf("DroppedCount = %d, want 1 (no customer → DropInvalid)", client.DroppedCount())
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
		if result := normalizePath(tt.input); result != tt.expected {
			t.Errorf("normalizePath(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestChiMiddleware(t *testing.T) {
	client, _ := newIngestorAndClient(t)
	mw, err := ChiMiddleware(client, MiddlewareOptions{CustomerResolver: func(*http.Request) string { return "c" }})
	if err != nil || mw == nil {
		t.Fatalf("ChiMiddleware: nil=%v err=%v", mw == nil, err)
	}
}

// G275: SSE handlers flush and WebSocket handlers hijack through the wrapper.
func TestStatusWriter_FlushHijackUnwrap(t *testing.T) {
	var sw http.ResponseWriter = &statusWriter{ResponseWriter: httptest.NewRecorder(), statusCode: 200}
	if _, ok := sw.(http.Flusher); !ok {
		t.Fatal("statusWriter must implement http.Flusher")
	}
	if _, ok := sw.(http.Hijacker); !ok {
		t.Fatal("statusWriter must implement http.Hijacker")
	}
	if u, ok := sw.(interface{ Unwrap() http.ResponseWriter }); !ok || u.Unwrap() == nil {
		t.Fatal("statusWriter must implement Unwrap")
	}
	rec := httptest.NewRecorder()
	(&statusWriter{ResponseWriter: rec, statusCode: 200}).Flush()
	if !rec.Flushed {
		t.Fatal("Flush did not reach the wrapped writer")
	}
	if err := http.NewResponseController(sw).Flush(); err != nil {
		t.Fatalf("ResponseController.Flush through the wrapper: %v", err)
	}
}

type hijackRecorder struct {
	*httptest.ResponseRecorder
	hijacked bool
}

func (h *hijackRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h.hijacked = true
	c1, c2 := net.Pipe()
	_ = c2.Close()
	return c1, bufio.NewReadWriter(bufio.NewReader(c1), bufio.NewWriter(c1)), nil
}

func TestStatusWriter_HijackRecords101(t *testing.T) {
	hr := &hijackRecorder{ResponseRecorder: httptest.NewRecorder()}
	sw := &statusWriter{ResponseWriter: hr, statusCode: 200}
	conn, _, err := sw.Hijack()
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if !hr.hijacked || sw.statusCode != http.StatusSwitchingProtocols {
		t.Fatalf("hijacked=%v status=%d", hr.hijacked, sw.statusCode)
	}
	// A writer that cannot hijack reports http.ErrNotSupported.
	if _, _, err := (&statusWriter{ResponseWriter: httptest.NewRecorder()}).Hijack(); err == nil {
		t.Fatal("want an error from a writer that cannot hijack")
	}
}
