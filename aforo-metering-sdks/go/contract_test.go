package metering

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

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

func TestTrack_RejectsInvalidEvents(t *testing.T) {
	c := newTestClient(t, "http://localhost:19999")
	cases := []TrackEvent{
		{MetricName: "m"},
		{CustomerID: "   ", MetricName: "m"},
		{CustomerID: "c"},
		{CustomerID: "c", MetricName: " "},
		{CustomerID: "c", MetricName: "m", Quantity: -1},
		{CustomerID: "c", MetricName: "m", OccurredAt: "yesterday"},
	}
	for i, ev := range cases {
		if err := c.Track(ev); !errors.Is(err, ErrInvalidEvent) {
			t.Errorf("case %d: err = %v, want ErrInvalidEvent", i, err)
		}
	}
	if c.BufferedCount() != 0 {
		t.Errorf("invalid events were buffered: %d", c.BufferedCount())
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

func TestHTTPMiddleware_EndpointPathCappedAt512(t *testing.T) {
	long := "/" + strings.Repeat("a", 600)
	if got := truncateUTF8(long, maxEndpointPathLen); len(got) != 512 {
		t.Errorf("len = %d, want 512", len(got))
	}
	if got := truncateUTF8("/"+strings.Repeat("é", 300), 512); !utf8.ValidString(got) || len(got) > 512 {
		t.Errorf("truncation split a rune or overflowed: len=%d", len(got))
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
