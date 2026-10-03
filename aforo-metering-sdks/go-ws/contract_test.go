// Ingest-contract guard (A+ delivery-guarantee prompt 7).
//
// Validates the OBSERVED wire request (endpoint path + body shape) against
// the shared, checked-in contract fixture at contract/ingest-contract.json —
// derived from the REAL usage-ingestor controllers/DTOs, never from this
// SDK's own constants. The 2026-07-05 D1 incident shipped this very SDK
// posting a batch body to a single-event endpoint; its own green suite hid
// 100% event loss because it asserted the SDK's own (wrong) constant.
package wsmetering

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const contractModuleKey = "go-ws"

type contractSpec struct {
	Cardinality           string   `json:"cardinality"`
	BatchKey              string   `json:"batchKey"`
	MaxEvents             int      `json:"maxEvents"`
	RequiredFields        []string `json:"requiredFields"`
	EventRequiredFields   []string `json:"eventRequiredFields"`
	ForbiddenTopLevelKeys []string `json:"forbiddenTopLevelKeys"`
	EventOptionalFields   map[string]struct {
		MaxLength int      `json:"maxLength"`
		Values    []string `json:"values"`
	} `json:"eventOptionalFields"`
}

type contractFixture struct {
	Endpoints map[string]contractSpec `json:"endpoints"`
	SDKs      map[string]struct {
		Endpoint string `json:"endpoint"`
	} `json:"sdks"`
}

func loadContractFixture(t *testing.T) contractFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "contract", "ingest-contract.json"))
	if err != nil {
		t.Fatalf("cannot read shared contract fixture: %v", err)
	}
	var f contractFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("cannot parse shared contract fixture: %v", err)
	}
	return f
}

func assertContractRequired(t *testing.T, obj map[string]any, field string) {
	t.Helper()
	v, ok := obj[field]
	if !ok || v == nil {
		t.Fatalf("required field %q missing/null in wire body", field)
	}
	if s, isStr := v.(string); isStr && strings.TrimSpace(s) == "" {
		t.Fatalf("required field %q is blank in wire body", field)
	}
}

// Same assertion shape in every SDK suite (all languages).
func assertBodyMatchesContract(t *testing.T, spec contractSpec, raw []byte) {
	t.Helper()
	switch spec.Cardinality {
	case "batch-wrapped":
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			// A bare array here is the /v1/ingest/async-batch shape — wrong for this endpoint.
			t.Fatalf("batch body must be a JSON object (not a bare array): %v", err)
		}
		eventsAny, ok := body[spec.BatchKey].([]any)
		if !ok || len(eventsAny) == 0 {
			t.Fatalf("batch body must carry non-empty %q array", spec.BatchKey)
		}
		if len(eventsAny) > spec.MaxEvents {
			t.Fatalf("batch exceeds contract max of %d events", spec.MaxEvents)
		}
		for _, evAny := range eventsAny {
			ev, ok := evAny.(map[string]any)
			if !ok {
				t.Fatalf("batch element is not an object")
			}
			for _, field := range spec.EventRequiredFields {
				assertContractRequired(t, ev, field)
			}
		}
	case "single":
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("single-event body must be a JSON object: %v", err)
		}
		for _, key := range spec.ForbiddenTopLevelKeys {
			if _, present := body[key]; present {
				t.Fatalf("single-event body must not carry %q", key)
			}
		}
		for _, field := range spec.RequiredFields {
			assertContractRequired(t, body, field)
		}
	default:
		t.Fatalf("unhandled cardinality in fixture: %q", spec.Cardinality)
	}
}

func TestIngestContract(t *testing.T) {
	fixture := loadContractFixture(t)
	entry, ok := fixture.SDKs[contractModuleKey]
	if !ok {
		t.Fatal("module must be registered in the fixture")
	}
	spec, ok := fixture.Endpoints[entry.Endpoint]
	if !ok {
		t.Fatalf("fixture has no endpoint spec for %q", entry.Endpoint)
	}

	var mu sync.Mutex
	var paths []string
	var bodies [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		paths = append(paths, r.URL.Path)
		bodies = append(bodies, b)
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	b, err := New(Config{
		TenantID:      "tenant-001",
		ProductID:     "prod-ws-001",
		APIKey:        "sk_ws_abc",
		IngestorURL:   srv.URL,
		FlushCount:    100, // buffer only — Shutdown's final drain does the synchronous flush (no async race)
		FlushInterval: time.Minute,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	connID := b.Open("cust_contract", nil)
	b.RecordFrame(connID, "SERVER_TO_CLIENT", "TEXT", 42)
	_ = b.Shutdown()

	mu.Lock()
	defer mu.Unlock()
	if len(paths) == 0 {
		t.Fatal("no wire request observed")
	}
	if paths[0] != entry.Endpoint {
		t.Fatalf("SDK posted to %q but the contract endpoint is %q", paths[0], entry.Endpoint)
	}
	assertBodyMatchesContract(t, spec, bodies[0])
}

// Every executionStatus value this SDK can derive or send must be one the
// ingestor accepts — asserted against the shared fixture, not our own table.
// Blank values must be omitted from the wire body.
func TestIngestContract_ExecutionStatusValues(t *testing.T) {
	fixture := loadContractFixture(t)
	entry := fixture.SDKs[contractModuleKey]
	spec := fixture.Endpoints[entry.Endpoint]
	statusSpec, ok := spec.EventOptionalFields["executionStatus"]
	if !ok {
		t.Fatal("fixture must declare executionStatus under eventOptionalFields")
	}
	allowed := map[string]bool{}
	for _, v := range statusSpec.Values {
		allowed[v] = true
	}
	inContract := func(v string) bool { return allowed[v] && len(v) <= statusSpec.MaxLength }

	// Nothing is derived for WebSocket events; only explicit values are sent.

	var mu sync.Mutex
	var bodies [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, b)
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	b, err := New(Config{
		TenantID:       "tenant-001",
		ProductID:      "prod-ws-001",
		APIKey:         "sk_ws_abc",
		IngestorURL:    srv.URL,
		PerFrameEvents: true,
		FlushCount:     100,
		FlushInterval:  time.Minute,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	connID := b.OpenWithOptions("cust_contract", nil, EventOptions{ExecutionStatus: " success "})
	b.RecordFrameWithOptions(connID, "CLIENT_TO_SERVER", "TEXT", 3, EventOptions{ExecutionStatus: "partial"})
	b.RecordFrame(connID, "CLIENT_TO_SERVER", "TEXT", 3)
	b.CloseWithOptions(connID, 1011, EventOptions{ExecutionStatus: "   "})
	_ = b.Shutdown()

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) == 0 {
		t.Fatal("no wire request observed")
	}
	assertBodyMatchesContract(t, spec, bodies[0])
	var body struct {
		Events []map[string]any `json:"events"`
	}
	if err := json.Unmarshal(bodies[0], &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	want := []string{"SUCCESS", "PARTIAL", "", ""}
	if len(body.Events) != len(want) {
		t.Fatalf("expected %d events, got %d", len(want), len(body.Events))
	}
	for i, w := range want {
		v, present := body.Events[i]["executionStatus"]
		if w == "" {
			if present {
				t.Errorf("event %d must omit executionStatus, got %v", i, v)
			}
			continue
		}
		got, _ := v.(string)
		if got != w || !inContract(got) {
			t.Errorf("event %d executionStatus = %q, want %q (in contract)", i, got, w)
		}
	}
}

// The SDK's executionStatus allow-list must match the contract exactly: a
// value the SDK accepts but the ingestor does not would reject the event.
func TestIngestContract_ExecutionStatusAllowListParity(t *testing.T) {
	fixture := loadContractFixture(t)
	spec := fixture.Endpoints[fixture.SDKs[contractModuleKey].Endpoint]
	statusSpec, ok := spec.EventOptionalFields["executionStatus"]
	if !ok || len(statusSpec.Values) == 0 {
		t.Fatal("fixture must declare executionStatus values under eventOptionalFields")
	}
	if statusSpec.MaxLength != maxExecutionStatusLength {
		t.Errorf("maxExecutionStatusLength = %d, contract maxLength = %d", maxExecutionStatusLength, statusSpec.MaxLength)
	}
	if len(canonicalExecutionStatuses) != len(statusSpec.Values) {
		t.Errorf("SDK allows %d statuses, contract lists %d (%v)", len(canonicalExecutionStatuses), len(statusSpec.Values), statusSpec.Values)
	}
	for _, v := range statusSpec.Values {
		if _, ok := canonicalExecutionStatuses[v]; !ok {
			t.Errorf("contract status %q missing from SDK allow-list", v)
		}
		if got := normalizeExecutionStatus(strings.ToLower(v)); got != v {
			t.Errorf("normalizeExecutionStatus(%q) = %q, want %q", strings.ToLower(v), got, v)
		}
	}
}

// ── Wire assertions carried over from the public repo: top-level productType
// (config default + per-event override), X-API-Key, errors[].message
// surfacing, no retry on non-retryable 4xx, Retry-After on 429. ──

type scriptedReply struct {
	status  int
	body    string
	headers map[string]string
}

// scriptedServer answers each POST with the next scripted reply (the last one
// repeats) and records every event it receives.
type scriptedServer struct {
	mu      sync.Mutex
	replies []scriptedReply
	calls   int
	apiKeys []string
	auths   []string
	evs     []map[string]any
}

func (s *scriptedServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var body struct {
		Events []map[string]any `json:"events"`
	}
	_ = json.Unmarshal(raw, &body)
	s.mu.Lock()
	reply := scriptedReply{status: 202, body: `{"accepted":1,"duplicates":0,"failed":0,"errors":[]}`}
	if len(s.replies) > 0 {
		i := s.calls
		if i >= len(s.replies) {
			i = len(s.replies) - 1
		}
		reply = s.replies[i]
	}
	s.calls++
	s.apiKeys = append(s.apiKeys, r.Header.Get("X-API-Key"))
	s.auths = append(s.auths, r.Header.Get("Authorization"))
	s.evs = append(s.evs, body.Events...)
	s.mu.Unlock()
	for k, v := range reply.headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(reply.status)
	_, _ = w.Write([]byte(reply.body))
}

func (s *scriptedServer) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func (s *scriptedServer) events() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.evs...)
}

type errSink struct {
	mu   sync.Mutex
	errs []string
}

func (e *errSink) add(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.errs = append(e.errs, err.Error())
}

func (e *errSink) joined() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return strings.Join(e.errs, "\n")
}

func newContractBilling(t *testing.T, url string, sink *errSink, mutate ...func(*Config)) *Billing {
	t.Helper()
	cfg := Config{
		TenantID:      "tenant-001",
		ProductID:     "prod-001",
		APIKey:        "sk_contract",
		IngestorURL:   url,
		FlushCount:    1,
		FlushInterval: time.Minute,
		OnError:       sink.add,
	}
	for _, m := range mutate {
		m(&cfg)
	}
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func eventually(t *testing.T, cond func() bool, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", d)
}

func emit(b *Billing, opts ...EventOptions) {
	b.Open("cust_1", nil, opts...)
}

func shutdown(b *Billing) error { return b.Shutdown() }

func TestContractDefaultProductType(t *testing.T) {
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	b := newContractBilling(t, ts.URL, &errSink{})
	emit(b)
	eventually(t, func() bool { return len(srv.events()) == 1 }, 2*time.Second)
	_ = shutdown(b)

	if got := srv.events()[0]["productType"]; got != DefaultProductType || DefaultProductType != "WEBSOCKET_API" {
		t.Errorf("productType = %v, want WEBSOCKET_API", got)
	}
	if srv.apiKeys[0] != "sk_contract" || srv.auths[0] != "" {
		t.Errorf("X-API-Key = %q, Authorization = %q; want key in X-API-Key only", srv.apiKeys[0], srv.auths[0])
	}
}

func TestContractProductTypeConfigAndPerEventOverride(t *testing.T) {
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.ProductType = "  agentic_api " })
	emit(b)
	eventually(t, func() bool { return len(srv.events()) == 1 }, 2*time.Second)
	emit(b, EventOptions{ProductType: "custom_type"})
	eventually(t, func() bool { return len(srv.events()) == 2 }, 2*time.Second)
	_ = shutdown(b)

	evs := srv.events()
	if evs[0]["productType"] != "AGENTIC_API" {
		t.Errorf("config productType = %v, want AGENTIC_API", evs[0]["productType"])
	}
	if evs[1]["productType"] != "CUSTOM_TYPE" {
		t.Errorf("per-event productType = %v, want CUSTOM_TYPE (unknown values pass through)", evs[1]["productType"])
	}
}

func TestContractNonRetryable4xxReportsErrorsMessage(t *testing.T) {
	srv := &scriptedServer{replies: []scriptedReply{{
		status: 400,
		body:   `{"success":true,"data":{"accepted":0,"duplicates":0,"failed":1,"errors":[{"index":0,"message":"unknown metric"}]}}`,
	}}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	sink := &errSink{}
	b := newContractBilling(t, ts.URL, sink)
	emit(b)
	eventually(t, func() bool { return strings.Contains(sink.joined(), "unknown metric") }, 2*time.Second)
	time.Sleep(1200 * time.Millisecond) // longer than the first retry backoff
	_ = shutdown(b)
	if n := srv.callCount(); n != 1 {
		t.Errorf("400 was attempted %d times, want 1 (no retry)", n)
	}
}

func TestContract429HonoursRetryAfter(t *testing.T) {
	srv := &scriptedServer{replies: []scriptedReply{
		{status: 429, headers: map[string]string{"Retry-After": "0"}},
		{status: 202, body: `{"accepted":1,"duplicates":0,"failed":0,"errors":[]}`},
	}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	sink := &errSink{}
	b := newContractBilling(t, ts.URL, sink)
	start := time.Now()
	emit(b)
	// Retry-After: 0 replaces the 1s exponential backoff.
	eventually(t, func() bool { return srv.callCount() == 2 }, 900*time.Millisecond)
	if time.Since(start) > 900*time.Millisecond {
		t.Errorf("Retry-After not honoured")
	}
	_ = shutdown(b)
	if s := sink.joined(); s != "" {
		t.Errorf("unexpected errors: %s", s)
	}
}

func TestContractPartialFailureSurfacesErrorsMessage(t *testing.T) {
	srv := &scriptedServer{replies: []scriptedReply{{
		status: 202,
		body:   `{"accepted":0,"duplicates":0,"failed":1,"errors":[{"index":0,"message":"quantity must be > 0"}]}`,
	}}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	sink := &errSink{}
	b := newContractBilling(t, ts.URL, sink)
	emit(b)
	eventually(t, func() bool { return strings.Contains(sink.joined(), "[0] quantity must be > 0") }, 2*time.Second)
	_ = shutdown(b)
	if n := srv.callCount(); n != 1 {
		t.Errorf("attempts = %d, want 1", n)
	}
}
