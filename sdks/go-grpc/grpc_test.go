// Tests for grpcmetering — validates the buffer/flush/retry pattern
// shared across all 4 Go SDKs (go-grpc, go-graphql, go-ws, go-mqtt).
//
// These tests intentionally DON'T bring up a gRPC server — we exercise
// Record() directly and verify the HTTP contract against an httptest
// server. Interceptor wiring is covered by a lighter smoke check.

package grpcmetering

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/codes"
)

// ── Helper: collect HTTP requests against a test server ─────────────────

type captured struct {
	method  string
	path    string
	headers http.Header
	body    map[string]any
}

type recorder struct {
	mu       sync.Mutex
	requests []captured
	status   int32
}

func (r *recorder) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	raw, _ := io.ReadAll(req.Body)
	req.Body.Close()
	var body map[string]any
	_ = json.Unmarshal(raw, &body)

	r.mu.Lock()
	r.requests = append(r.requests, captured{
		method:  req.Method,
		path:    req.URL.Path,
		headers: req.Header.Clone(),
		body:    body,
	})
	r.mu.Unlock()

	w.WriteHeader(int(atomic.LoadInt32(&r.status)))
}

func (r *recorder) got() []captured {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]captured, len(r.requests))
	copy(out, r.requests)
	return out
}

func newBilling(t *testing.T, server *httptest.Server, opts ...func(*Config)) *Billing {
	t.Helper()
	cfg := Config{
		TenantID:      "tenant-001",
		ProductID:     "prod-001",
		APIKey:        "sk_test_abc",
		IngestorURL:   server.URL + "/",   // trailing slash stripped by SDK
		ServiceName:   "acme.v1.UserService",
		FlushCount:    1,                  // flush on first event
		FlushInterval: 100 * time.Millisecond,
	}
	for _, o := range opts {
		o(&cfg)
	}
	b, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = b.Shutdown(context.Background()) })
	return b
}

func ctxWith(md metadata.MD) context.Context {
	return metadata.NewIncomingContext(context.Background(), md)
}

func waitFor(t *testing.T, cond func() bool, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition never true within %s", timeout)
}

// ── Constructor validation ──────────────────────────────────────────────

func TestNewRequiresAllCoreFields(t *testing.T) {
	cases := []Config{
		{ProductID: "p", APIKey: "k", IngestorURL: "u", ServiceName: "s"},
		{TenantID: "t", APIKey: "k", IngestorURL: "u", ServiceName: "s"},
		{TenantID: "t", ProductID: "p", IngestorURL: "u", ServiceName: "s"},
		{TenantID: "t", ProductID: "p", APIKey: "k", ServiceName: "s"},
		{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "u"},
	}
	for i, c := range cases {
		if _, err := New(c); err == nil {
			t.Errorf("case %d: expected error for missing field, got nil", i)
		}
	}
}

// ── Record() happy path ────────────────────────────────────────────────

func TestRecordEmitsEventWithCorrectShape(t *testing.T) {
	rec := &recorder{status: 204}
	srv := httptest.NewServer(rec)
	defer srv.Close()

	b := newBilling(t, srv)
	ctx := ctxWith(metadata.Pairs("x-customer-id", "cust_001"))

	b.Record(ctx, "GetUser", "UNARY", 1, nil, 42)

	waitFor(t, func() bool { return len(rec.got()) == 1 }, 2*time.Second)

	req := rec.got()[0]
	if req.method != http.MethodPost {
		t.Errorf("method = %s, want POST", req.method)
	}
	if req.path != "/v1/ingest/events" {
		t.Errorf("path = %s, want /v1/ingest/events (trailing slash stripped)", req.path)
	}
	if req.headers.Get("Authorization") != "Bearer sk_test_abc" {
		t.Errorf("auth header = %q", req.headers.Get("Authorization"))
	}
	if req.headers.Get("X-Tenant-Id") != "tenant-001" {
		t.Errorf("tenant header = %q", req.headers.Get("X-Tenant-Id"))
	}

	events, _ := req.body["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("events len = %d, want 1", len(events))
	}
	ev := events[0].(map[string]any)
	want := map[string]any{
		"productType":    "GRPC_API",
		"grpcService":    "acme.v1.UserService",
		"grpcMethod":     "GetUser",
		"grpcStatusCode": "OK",
		"grpcCallType":   "UNARY",
		"metricName":     "grpc_api.rpc_calls",
		"customerId":     "cust_001",
	}
	for k, v := range want {
		if ev[k] != v {
			t.Errorf("event[%q] = %v, want %v", k, ev[k], v)
		}
	}
	if ev["executionDurationMs"].(float64) != 42 {
		t.Errorf("executionDurationMs = %v, want 42", ev["executionDurationMs"])
	}
	// idempotencyKey shape: grpc:<tenant>:<service>:<method>:<millis>:<8-hex>
	if key, _ := ev["idempotencyKey"].(string); !strings.HasPrefix(key, "grpc:tenant-001:acme.v1.UserService:GetUser:") {
		t.Errorf("idempotencyKey prefix wrong: %s", key)
	}
}

func TestRecordMapsGrpcErrorToStatusLabel(t *testing.T) {
	rec := &recorder{status: 204}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)

	ctx := ctxWith(metadata.Pairs("x-customer-id", "cust_001"))
	err := status.Error(codes.NotFound, "no user")
	b.Record(ctx, "GetUser", "UNARY", 1, err, 10)

	waitFor(t, func() bool { return len(rec.got()) == 1 }, 2*time.Second)
	events, _ := rec.got()[0].body["events"].([]any)
	ev := events[0].(map[string]any)
	if ev["grpcStatusCode"] != "NotFound" {
		t.Errorf("status label = %v, want NotFound (from status.Code().String())", ev["grpcStatusCode"])
	}
}

func TestRecordWithoutCustomerIDIsSkipped(t *testing.T) {
	rec := &recorder{status: 204}
	srv := httptest.NewServer(rec)
	defer srv.Close()

	b := newBilling(t, srv)
	// No incoming metadata → default extractor returns ""
	b.Record(context.Background(), "Health", "UNARY", 1, nil, 1)

	// Wait past the flush interval to prove no event was enqueued
	time.Sleep(250 * time.Millisecond)
	if n := len(rec.got()); n != 0 {
		t.Errorf("requests = %d, want 0", n)
	}
}

// ── Buffer batching ─────────────────────────────────────────────────────

func TestFlushCountTriggersBatch(t *testing.T) {
	rec := &recorder{status: 204}
	srv := httptest.NewServer(rec)
	defer srv.Close()

	b := newBilling(t, srv, func(c *Config) {
		c.FlushCount = 3
		c.FlushInterval = 60 * time.Second // don't let timer fire
	})
	ctx := ctxWith(metadata.Pairs("x-customer-id", "cust_001"))

	b.Record(ctx, "M", "UNARY", 1, nil, 1)
	b.Record(ctx, "M", "UNARY", 1, nil, 1)
	time.Sleep(100 * time.Millisecond)
	if n := len(rec.got()); n != 0 {
		t.Fatalf("premature flush: got %d requests", n)
	}

	b.Record(ctx, "M", "UNARY", 1, nil, 1)
	waitFor(t, func() bool { return len(rec.got()) == 1 }, 2*time.Second)

	events, _ := rec.got()[0].body["events"].([]any)
	if len(events) != 3 {
		t.Errorf("batched events = %d, want 3", len(events))
	}
}

func TestShutdownFlushesRemaining(t *testing.T) {
	rec := &recorder{status: 204}
	srv := httptest.NewServer(rec)
	defer srv.Close()

	cfg := Config{
		TenantID: "tenant-001", ProductID: "prod-001", APIKey: "k",
		IngestorURL: srv.URL, ServiceName: "svc",
		FlushCount:    100,
		FlushInterval: 60 * time.Second,
	}
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx := ctxWith(metadata.Pairs("x-customer-id", "cust_001"))
	b.Record(ctx, "M", "UNARY", 1, nil, 1)
	b.Record(ctx, "M", "UNARY", 1, nil, 1)

	time.Sleep(50 * time.Millisecond)
	if n := len(rec.got()); n != 0 {
		t.Fatalf("pre-shutdown flush = %d, want 0", n)
	}

	if err := b.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if n := len(rec.got()); n != 1 {
		t.Fatalf("post-shutdown requests = %d, want 1", n)
	}
	events, _ := rec.got()[0].body["events"].([]any)
	if len(events) != 2 {
		t.Errorf("drained events = %d, want 2", len(events))
	}
}

func TestIdempotencyKeysUnique(t *testing.T) {
	rec := &recorder{status: 204}
	srv := httptest.NewServer(rec)
	defer srv.Close()

	b := newBilling(t, srv, func(c *Config) { c.FlushCount = 5 })
	ctx := ctxWith(metadata.Pairs("x-customer-id", "cust_001"))
	for i := 0; i < 5; i++ {
		b.Record(ctx, "M", "UNARY", 1, nil, 1)
	}
	waitFor(t, func() bool { return len(rec.got()) == 1 }, 2*time.Second)

	events, _ := rec.got()[0].body["events"].([]any)
	seen := make(map[string]bool, len(events))
	for _, e := range events {
		key := e.(map[string]any)["idempotencyKey"].(string)
		if seen[key] {
			t.Fatalf("duplicate idempotencyKey: %s", key)
		}
		seen[key] = true
	}
}

// ── Retry behaviour ────────────────────────────────────────────────────

func TestRetryUntilOnErrorFires(t *testing.T) {
	rec := &recorder{status: 500}
	srv := httptest.NewServer(rec)
	defer srv.Close()

	var errs []error
	var errMu sync.Mutex
	b := newBilling(t, srv, func(c *Config) {
		c.OnError = func(err error) {
			errMu.Lock()
			errs = append(errs, err)
			errMu.Unlock()
		}
	})
	ctx := ctxWith(metadata.Pairs("x-customer-id", "cust_001"))
	b.Record(ctx, "M", "UNARY", 1, nil, 1)

	// 3 retries × up to 4s backoff (1s+2s+4s) — give 8s
	waitFor(t, func() bool {
		errMu.Lock()
		defer errMu.Unlock()
		return len(errs) >= 1
	}, 10*time.Second)

	if got := len(rec.got()); got != 3 {
		t.Errorf("attempts = %d, want 3", got)
	}
	errMu.Lock()
	if len(errs) != 1 || !strings.Contains(errs[0].Error(), "exhausted") {
		t.Errorf("onError invocations = %v", errs)
	}
	errMu.Unlock()
}

func TestSuccessfulFirstAttemptNoRetry(t *testing.T) {
	rec := &recorder{status: 204}
	srv := httptest.NewServer(rec)
	defer srv.Close()

	errCalls := atomic.Int32{}
	b := newBilling(t, srv, func(c *Config) {
		c.OnError = func(error) { errCalls.Add(1) }
	})
	ctx := ctxWith(metadata.Pairs("x-customer-id", "cust_001"))
	b.Record(ctx, "M", "UNARY", 1, nil, 1)

	waitFor(t, func() bool { return len(rec.got()) == 1 }, 2*time.Second)
	if n := errCalls.Load(); n != 0 {
		t.Errorf("onError called %d times, want 0", n)
	}
}

// ── Interceptors: smoke ─────────────────────────────────────────────────

func TestInterceptorsAreConstructable(t *testing.T) {
	rec := &recorder{status: 204}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)
	if b.UnaryInterceptor() == nil {
		t.Error("UnaryInterceptor() returned nil")
	}
	if b.StreamInterceptor() == nil {
		t.Error("StreamInterceptor() returned nil")
	}
}
