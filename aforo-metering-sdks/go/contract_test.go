// Ingest-contract guard (A+ delivery-guarantee prompt 7).
//
// Validates the OBSERVED wire request (endpoint path + body shape) against
// the shared, checked-in contract fixture at contract/ingest-contract.json —
// derived from the REAL usage-ingestor controllers/DTOs, never from this
// SDK's own constants. A test that asserts the SDK against the SDK's own
// endpoint constant has zero contract coverage (the 2026-07-05 D1 incident:
// 16 variant SDKs posted a batch body to a single-event endpoint, every
// flush 400'd, and green suites hid 100% event loss).
package metering

import (
	"encoding/json"
	"errors"
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

const contractModuleKey = "go"

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

	client := NewClient(Options{
		APIKey:        "test-key",
		BaseURL:       srv.URL,
		FlushCount:    100,
		FlushInterval: time.Minute,
		MaxRetries:    0,
	})
	if err := client.Track(TrackEvent{CustomerID: "cust_contract", MetricName: "api_calls", Quantity: 1}); err != nil {
		t.Fatalf("Track: %v", err)
	}
	client.Flush()
	client.Close()

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

func TestIngestContract_ExecutionStatusSentOnlyWhenSet(t *testing.T) {
	fixture := loadContractFixture(t)
	entry := fixture.SDKs[contractModuleKey]
	spec := fixture.Endpoints[entry.Endpoint]
	statusSpec, ok := spec.EventOptionalFields["executionStatus"]
	if !ok {
		t.Fatal("fixture must declare executionStatus under eventOptionalFields")
	}

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

	client := NewClient(Options{
		APIKey:        "test-key",
		BaseURL:       srv.URL,
		FlushCount:    100,
		FlushInterval: time.Minute,
		MaxRetries:    0,
	})
	for _, ev := range []TrackEvent{
		{CustomerID: "cust_contract", MetricName: "api_calls", ExecutionStatus: " timeout "},
		{CustomerID: "cust_contract", MetricName: "api_calls"},
		{CustomerID: "cust_contract", MetricName: "api_calls", ExecutionStatus: "   "},
		// Unknown and over-length values are omitted so the batch is accepted.
		{CustomerID: "cust_contract", MetricName: "api_calls", ExecutionStatus: "done"},
		{CustomerID: "cust_contract", MetricName: "api_calls", ExecutionStatus: "SUCCESSFUL_OUTCOME_XYZ"},
	} {
		if err := client.Track(ev); err != nil {
			t.Fatalf("Track: %v", err)
		}
	}
	client.Flush()
	client.Close()

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
	if len(body.Events) != 5 {
		t.Fatalf("expected 5 events, got %d", len(body.Events))
	}
	got, _ := body.Events[0]["executionStatus"].(string)
	if got != "TIMEOUT" {
		t.Fatalf("executionStatus = %q, want TIMEOUT", got)
	}
	allowed := false
	for _, v := range statusSpec.Values {
		if v == got {
			allowed = true
		}
	}
	if !allowed || len(got) > statusSpec.MaxLength {
		t.Fatalf("executionStatus %q not within contract (values=%v, maxLength=%d)", got, statusSpec.Values, statusSpec.MaxLength)
	}
	for i := 1; i < 5; i++ {
		if _, present := body.Events[i]["executionStatus"]; present {
			t.Fatalf("event %d must omit executionStatus when unset/blank/unknown", i)
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

// ── Wire assertions carried over from the public repo ───────────────────────

// captureServer records every JSON body POSTed to it.
type captureServer struct {
	mu     sync.Mutex
	paths  []string
	apiKey []string
	auth   []string
	bodies []map[string]any
	status int
	reply  string
}

func (s *captureServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	s.mu.Lock()
	s.paths = append(s.paths, r.URL.Path)
	s.apiKey = append(s.apiKey, r.Header.Get("X-API-Key"))
	s.auth = append(s.auth, r.Header.Get("Authorization"))
	s.bodies = append(s.bodies, body)
	status, reply := s.status, s.reply
	s.mu.Unlock()
	if status == 0 {
		status = 202
	}
	w.WriteHeader(status)
	_, _ = w.Write([]byte(reply))
}

func (s *captureServer) events() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []map[string]any
	for _, b := range s.bodies {
		evs, _ := b["events"].([]any)
		for _, e := range evs {
			out = append(out, e.(map[string]any))
		}
	}
	return out
}

func newTestClient(t *testing.T, url string, mutate ...func(*Options)) *AforoClient {
	t.Helper()
	opts := Options{APIKey: "sk_test_abc", BaseURL: url, FlushCount: 100, FlushInterval: time.Minute, MaxRetries: 1, RetryBase: time.Millisecond}
	for _, m := range mutate {
		m(&opts)
	}
	c := NewClient(opts)
	t.Cleanup(c.Close)
	return c
}

func TestOptions_DefaultBaseURLAndProductType(t *testing.T) {
	o := Options{}
	o.defaults()
	if o.BaseURL != "https://api.aforo.ai" {
		t.Errorf("BaseURL = %q, want https://api.aforo.ai", o.BaseURL)
	}
	if o.ProductType != "API" {
		t.Errorf("ProductType = %q, want API", o.ProductType)
	}
	if got := formatURL(o.BaseURL); got != "https://api.aforo.ai/v1/ingest/batch" {
		t.Errorf("formatURL = %q", got)
	}
}

func TestOptions_FlushCountClampedToBatchLimit(t *testing.T) {
	o := Options{FlushCount: 5000}
	o.defaults()
	if o.FlushCount != 1000 {
		t.Errorf("FlushCount = %d, want 1000", o.FlushCount)
	}
}

func TestTrack_SerializesRequiredFieldsAndDefaultProductType(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	c := newTestClient(t, ts.URL)

	if err := c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"}); err != nil {
		t.Fatal(err)
	}
	if r := c.Flush(); r.Sent != 1 {
		t.Fatalf("Sent = %d", r.Sent)
	}
	if srv.paths[0] != "/v1/ingest/batch" {
		t.Errorf("path = %s, want /v1/ingest/batch", srv.paths[0])
	}
	if srv.apiKey[0] != "sk_test_abc" || srv.auth[0] != "" {
		t.Errorf("X-API-Key = %q, Authorization = %q; want key in X-API-Key only", srv.apiKey[0], srv.auth[0])
	}
	ev := srv.events()[0]
	for _, k := range []string{"customerId", "metricName", "quantity", "occurredAt", "idempotencyKey", "productType"} {
		if _, ok := ev[k]; !ok {
			t.Errorf("missing field %q in %v", k, ev)
		}
	}
	if ev["productType"] != "API" {
		t.Errorf("productType = %v, want API", ev["productType"])
	}
	if q, _ := ev["quantity"].(float64); q <= 0 {
		t.Errorf("quantity = %v, want > 0", ev["quantity"])
	}
	occ, _ := ev["occurredAt"].(string)
	ts2, err := time.Parse(time.RFC3339Nano, occ)
	if err != nil || ts2.Location() != time.UTC || occ[len(occ)-1] != 'Z' {
		t.Errorf("occurredAt = %q, want RFC 3339 UTC (Z)", occ)
	}
}

func TestTrack_ProductTypeClientOptionAndPerEventOverride(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	c := newTestClient(t, ts.URL, func(o *Options) { o.ProductType = "agentic_api" })

	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "m"})
	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "m", ProductType: "mcp_server", Quantity: 2})
	c.Flush()

	evs := srv.events()
	if len(evs) != 2 {
		t.Fatalf("got %d events", len(evs))
	}
	if evs[0]["productType"] != "AGENTIC_API" {
		t.Errorf("client default productType = %v, want AGENTIC_API", evs[0]["productType"])
	}
	if evs[1]["productType"] != "MCP_SERVER" {
		t.Errorf("per-event productType = %v, want MCP_SERVER", evs[1]["productType"])
	}
}

func TestTrack_OccurredAtNormalizedToUTC(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	c := newTestClient(t, ts.URL)

	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "m", OccurredAt: "2026-09-22T12:00:00+02:00"})
	c.Flush()
	if got := srv.events()[0]["occurredAt"]; got != "2026-09-22T10:00:00Z" {
		t.Errorf("occurredAt = %v, want 2026-09-22T10:00:00Z", got)
	}
}

// An invalid event is not buffered or sent: Track returns ErrInvalidEvent and
// the event goes through drop observability (DroppedCount + OnDrop/DropInvalid).
func TestTrack_RejectsInvalidEvents(t *testing.T) {
	var mu sync.Mutex
	var dropped []TrackEvent
	var reasons []DropReason
	c := newTestClient(t, "http://localhost:19999", func(o *Options) {
		o.OnDrop = func(events []TrackEvent, reason DropReason) {
			mu.Lock()
			defer mu.Unlock()
			dropped = append(dropped, events...)
			reasons = append(reasons, reason)
		}
	})
	cases := []TrackEvent{
		{MetricName: "m"},
		{CustomerID: "   ", MetricName: "m"},
		{CustomerID: "c"},
		{CustomerID: "c", MetricName: " "},
		{CustomerID: "c", MetricName: "m", Quantity: -1},
		{CustomerID: "c", MetricName: "m", OccurredAt: "yesterday"},
		{CustomerID: strings.Repeat("c", 65), MetricName: "m"},
	}
	for i, ev := range cases {
		if err := c.Track(ev); !errors.Is(err, ErrInvalidEvent) {
			t.Errorf("case %d: err = %v, want ErrInvalidEvent", i, err)
		}
	}
	if c.BufferedCount() != 0 {
		t.Errorf("invalid events were buffered: %d", c.BufferedCount())
	}
	if got := c.DroppedCount(); got != int64(len(cases)) {
		t.Errorf("DroppedCount = %d, want %d", got, len(cases))
	}
	mu.Lock()
	defer mu.Unlock()
	if len(dropped) != len(cases) {
		t.Fatalf("OnDrop saw %d events, want %d", len(dropped), len(cases))
	}
	for i, r := range reasons {
		if r != DropInvalid {
			t.Errorf("reason[%d] = %q, want %q", i, r, DropInvalid)
		}
		if dropped[i].IdempotencyKey == "" {
			t.Errorf("dropped event %d lost its idempotency key", i)
		}
	}
}

// A 2xx partial failure drops only the events the ingestor named, reason rejected.
func TestFlush_PartialFailureDropsOnlyNamedEvents(t *testing.T) {
	srv := &captureServer{reply: `{"success":true,"data":{"accepted":1,"duplicates":0,"failed":1,"errors":[{"index":1,"message":"unknown metric"}]}}`}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	var mu sync.Mutex
	var dropped []TrackEvent
	var reasons []DropReason
	c := newTestClient(t, ts.URL, func(o *Options) {
		o.OnDrop = func(events []TrackEvent, reason DropReason) {
			mu.Lock()
			defer mu.Unlock()
			dropped = append(dropped, events...)
			reasons = append(reasons, reason)
		}
	})
	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "m"})
	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "x", IdempotencyKey: "key-x"})
	c.Flush()
	mu.Lock()
	defer mu.Unlock()
	if c.DroppedCount() != 1 || len(dropped) != 1 || dropped[0].IdempotencyKey != "key-x" {
		t.Fatalf("DroppedCount=%d dropped=%+v, want only the event at index 1", c.DroppedCount(), dropped)
	}
	if reasons[0] != DropRejected {
		t.Errorf("reason = %q, want %q", reasons[0], DropRejected)
	}
}

// Without errors[].index the SDK counts the failures but names no event.
func TestFlush_PartialFailureWithoutIndexesCountsOnly(t *testing.T) {
	srv := &captureServer{reply: `{"accepted":1,"duplicates":0,"failed":1}`}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	calls := 0
	c := newTestClient(t, ts.URL, func(o *Options) {
		o.OnDrop = func([]TrackEvent, DropReason) { calls++ }
	})
	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "m"})
	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "x"})
	c.Flush()
	if c.DroppedCount() != 1 || calls != 0 {
		t.Errorf("DroppedCount=%d OnDrop calls=%d, want 1 and 0", c.DroppedCount(), calls)
	}
}

func TestFlush_PartialFailureCounted(t *testing.T) {
	srv := &captureServer{reply: `{"accepted":1,"duplicates":0,"failed":1,"errors":[{"index":1,"message":"unknown metric"}]}`}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	c := newTestClient(t, ts.URL)
	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "m"})
	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "x"})
	r := c.Flush()
	if r.Sent != 1 || r.Failed != 1 {
		t.Errorf("FlushResult = %+v, want Sent=1 Failed=1", r)
	}
}

func TestHTTPMiddleware_SendsHTTPContextAndProductType(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	h := HTTPMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
	}), MiddlewareOptions{
		APIKey:        "k",
		ProductType:   "agentic_api",
		ClientOptions: &Options{BaseURL: ts.URL, FlushCount: 1, FlushInterval: time.Minute},
	})
	req := httptest.NewRequest("POST", "/v1/orders/42?expand=items", nil)
	req.Header.Set("X-Customer-Id", "cust_9")
	h.ServeHTTP(httptest.NewRecorder(), req)

	deadline := time.Now().Add(2 * time.Second)
	for len(srv.events()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	evs := srv.events()
	if len(evs) != 1 {
		t.Fatalf("got %d events", len(evs))
	}
	ev := evs[0]
	want := map[string]any{
		"customerId":   "cust_9",
		"metricName":   "api_calls",
		"productType":  "AGENTIC_API",
		"endpointPath": "/v1/orders/:id",
		"httpMethod":   "POST",
		"statusCode":   float64(201),
	}
	for k, v := range want {
		if ev[k] != v {
			t.Errorf("%s = %v, want %v", k, ev[k], v)
		}
	}
}

func TestChiMiddleware_SkipsWithoutCustomerID(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	mw := ChiMiddleware(MiddlewareOptions{
		APIKey:        "k",
		ClientOptions: &Options{BaseURL: ts.URL, FlushCount: 1, FlushInterval: 50 * time.Millisecond},
	})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	req := httptest.NewRequest("GET", "/v1/data", nil)
	req.Header.Set("X-Customer-Id", "   ")
	h.ServeHTTP(httptest.NewRecorder(), req)
	time.Sleep(150 * time.Millisecond)
	if n := len(srv.events()); n != 0 {
		t.Errorf("got %d events without a customer id, want 0", n)
	}
}
