// Tests for graphqlmetering. Unique bits:
//   - Regex-based operation detection (QUERY / MUTATION / SUBSCRIPTION)
//   - Brace-balance complexity approximation
//   - HTTP middleware body capture path

package graphqlmetering

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

type recorder struct {
	mu       sync.Mutex
	requests []map[string]any
}

func (r *recorder) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	raw, _ := io.ReadAll(req.Body)
	req.Body.Close()
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	r.mu.Lock()
	r.requests = append(r.requests, body)
	r.mu.Unlock()
	w.WriteHeader(204)
}

func (r *recorder) events() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []map[string]any{}
	for _, b := range r.requests {
		if evs, ok := b["events"].([]any); ok {
			for _, e := range evs {
				out = append(out, e.(map[string]any))
			}
		}
	}
	return out
}

func newBilling(t *testing.T, srv *httptest.Server, opts ...func(*Config)) *Billing {
	t.Helper()
	cfg := Config{
		TenantID:      "tenant-001",
		ProductID:     "prod-gql-001",
		APIKey:        "sk_gql_abc",
		IngestorURL:   srv.URL,
		SchemaVersion: "v2.1",
		FlushCount:    1,
		FlushInterval: 100 * time.Millisecond,
	}
	for _, o := range opts {
		o(&cfg)
	}
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Shutdown() })
	return b
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
	t.Fatal("condition never true")
}

// ── Record() happy path ────────────────────────────────────────────────

func TestRecordEmitsEventShape(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)

	b.Record("cust_001", "query GetUser { user { id name } }", "GetUser", 14, false)
	waitFor(t, func() bool { return len(rec.events()) == 1 }, 2*time.Second)

	ev := rec.events()[0]
	want := map[string]any{
		"productType":         "GRAPHQL_API",
		"gqlOperationType":    "QUERY",
		"gqlOperationName":    "GetUser",
		"gqlHasErrors":        false,
		"executionDurationMs": float64(14),
		"customerId":          "cust_001",
		"metricName":          "graphql_api.operations",
	}
	for k, v := range want {
		if ev[k] != v {
			t.Errorf("event[%q] = %v, want %v", k, ev[k], v)
		}
	}
	if ev["gqlComplexity"].(float64) <= 0 {
		t.Errorf("gqlComplexity = %v, want > 0", ev["gqlComplexity"])
	}
	meta, _ := ev["metadata"].(map[string]any)
	if meta["schemaVersion"] != "v2.1" {
		t.Errorf("schemaVersion = %v", meta["schemaVersion"])
	}
}

// ── Operation type detection ──────────────────────────────────────────

func TestOperationTypeDetection(t *testing.T) {
	cases := []struct {
		query, expectType string
	}{
		{"{ user { id } }", "QUERY"},                                  // implicit query
		{"query GetUser { user { id } }", "QUERY"},                    // explicit query
		{"mutation DoThing { createUser { id } }", "MUTATION"},
		{"subscription OnNew { newUser { id } }", "SUBSCRIPTION"},
	}

	for _, c := range cases {
		rec := &recorder{}
		srv := httptest.NewServer(rec)
		b := newBilling(t, srv)
		b.Record("cust_001", c.query, "", 5, false)
		waitFor(t, func() bool { return len(rec.events()) == 1 }, 2*time.Second)

		if ev := rec.events()[0]; ev["gqlOperationType"] != c.expectType {
			t.Errorf("query=%q → type=%v, want %s", c.query, ev["gqlOperationType"], c.expectType)
		}
		srv.Close()
	}
}

// ── Silent drops ──────────────────────────────────────────────────────

func TestRecordWithoutCustomerIDIsSkipped(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)
	b.Record("", "{ a }", "", 5, false)
	time.Sleep(200 * time.Millisecond)
	if n := len(rec.events()); n != 0 {
		t.Errorf("got %d events, want 0", n)
	}
}

func TestInvalidQueryIsSkipped(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)
	b.Record("cust_001", "", "", 5, false) // empty query → skipped
	time.Sleep(200 * time.Millisecond)
	if n := len(rec.events()); n != 0 {
		t.Errorf("got %d events, want 0", n)
	}
}

// ── Anonymous operation ──────────────────────────────────────────────

func TestAnonymousOperationName(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)
	b.Record("cust_001", "{ a b c }", "", 5, false)
	waitFor(t, func() bool { return len(rec.events()) == 1 }, 2*time.Second)
	if name := rec.events()[0]["gqlOperationName"]; name != "anonymous" {
		t.Errorf("operationName = %v, want anonymous", name)
	}
}

// ── hasErrors forwarded ──────────────────────────────────────────────

func TestHasErrorsForwarded(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)
	b.Record("cust_001", "{ a }", "", 5, true)
	waitFor(t, func() bool { return len(rec.events()) == 1 }, 2*time.Second)
	if v := rec.events()[0]["gqlHasErrors"]; v != true {
		t.Errorf("gqlHasErrors = %v, want true", v)
	}
}

// ── idempotencyKey format ────────────────────────────────────────────

func TestIdempotencyKeyFormat(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)
	b.Record("cust_001", "query MyOp { a }", "MyOp", 5, false)
	waitFor(t, func() bool { return len(rec.events()) == 1 }, 2*time.Second)

	key := rec.events()[0]["idempotencyKey"].(string)
	re := regexp.MustCompile(`^gql:tenant-001:prod-gql-001:MyOp:\d+:[a-z0-9]{8}$`)
	if !re.MatchString(key) {
		t.Errorf("idempotencyKey=%q does not match expected format", key)
	}
}

// ── HTTP middleware ──────────────────────────────────────────────────

func TestMiddlewareCapturesGraphQLPost(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)

	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Upstream server should still see the body
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "query Test") {
			t.Errorf("upstream missing body: %s", body)
		}
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"data":{"a":1}}`))
	})

	handler := b.Middleware(upstream)
	req := httptest.NewRequest(http.MethodPost, "/graphql",
		bytes.NewReader([]byte(`{"query":"query Test { user { id } }","operationName":"Test"}`)))
	req.Header.Set("X-Customer-Id", "cust_from_middleware")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	waitFor(t, func() bool { return len(rec.events()) == 1 }, 2*time.Second)
	ev := rec.events()[0]
	if ev["customerId"] != "cust_from_middleware" {
		t.Errorf("customerId = %v", ev["customerId"])
	}
	if ev["gqlOperationName"] != "Test" {
		t.Errorf("operationName = %v", ev["gqlOperationName"])
	}
}

func TestMiddlewarePassesThroughNonGraphQLPaths(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)

	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})

	handler := b.Middleware(upstream)
	req := httptest.NewRequest(http.MethodGet, "/graphql", nil)  // GET not POST
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	time.Sleep(200 * time.Millisecond)
	if n := len(rec.events()); n != 0 {
		t.Errorf("got %d events on GET, want 0", n)
	}
}
