// Tests for wsmetering. Unique bits:
//   - Open → RecordFrame → Close lifecycle
//   - PerFrameEvents flag (off by default)
//   - Close-code → enum mapping

package wsmetering

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type rec struct {
	mu       sync.Mutex
	requests []map[string]any
	paths    []string
	headers  []http.Header
}

func (r *rec) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	raw, _ := io.ReadAll(req.Body)
	req.Body.Close()
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	r.mu.Lock()
	r.requests = append(r.requests, body)
	r.paths = append(r.paths, req.URL.Path)
	r.headers = append(r.headers, req.Header.Clone())
	r.mu.Unlock()
	w.WriteHeader(204)
}

func (r *rec) events() []map[string]any {
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
		ProductID:     "prod-ws-001",
		APIKey:        "sk_ws_abc",
		IngestorURL:   srv.URL,
		FlushCount:    100,
		FlushInterval: 60 * time.Second,
	}
	for _, o := range opts {
		o(&cfg)
	}
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// ── Open → Close lifecycle ─────────────────────────────────────────────

func TestOpenEmitsConnectionOpened(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.FlushCount = 1 })

	connID := b.Open("cust_001", map[string]any{"region": "us-east-1"})
	if connID == "" {
		t.Fatal("expected non-empty connID")
	}
	// Wait for flush
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(r.events()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	_ = b.Shutdown()

	ev := r.events()[0]
	if ev["productType"] != "WEBSOCKET_API" {
		t.Errorf("productType = %v", ev["productType"])
	}
	if ev["wsFrameType"] != "PING" {
		t.Errorf("wsFrameType = %v, want PING (lifecycle marker)", ev["wsFrameType"])
	}
	meta := ev["metadata"].(map[string]any)
	if meta["event"] != "CONNECTION_OPENED" {
		t.Errorf("metadata.event = %v", meta["event"])
	}
	if meta["region"] != "us-east-1" {
		t.Errorf("metadata.region = %v", meta["region"])
	}
}

func TestCloseAggregatesCounters(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv)

	connID := b.Open("cust_001", nil)
	b.RecordFrame(connID, "CLIENT_TO_SERVER", "TEXT", 3)
	b.RecordFrame(connID, "CLIENT_TO_SERVER", "TEXT", 4)
	b.RecordFrame(connID, "SERVER_TO_CLIENT", "TEXT", 5)
	b.Close(connID, 1000)
	_ = b.Shutdown()

	var closes []map[string]any
	for _, e := range r.events() {
		if e["wsFrameType"] == "CLOSE" {
			closes = append(closes, e)
		}
	}
	if len(closes) != 1 {
		t.Fatalf("CLOSE events = %d, want 1", len(closes))
	}
	ev := closes[0]
	if ev["wsCloseReason"] != "NORMAL_CLOSURE" {
		t.Errorf("wsCloseReason = %v", ev["wsCloseReason"])
	}
	if ev["messageCount"].(float64) != 3 {
		t.Errorf("messageCount = %v, want 3", ev["messageCount"])
	}
	if ev["dataBytes"].(float64) != 12 {
		t.Errorf("dataBytes = %v, want 12", ev["dataBytes"])
	}
	if ev["metricName"] != "websocket_api.connection_closed" {
		t.Errorf("metricName = %v", ev["metricName"])
	}
}

// ── PerFrameEvents off (default) ───────────────────────────────────────

func TestPerFrameEventsOff(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv)

	connID := b.Open("cust_001", nil)
	for i := 0; i < 5; i++ {
		b.RecordFrame(connID, "CLIENT_TO_SERVER", "TEXT", 10)
	}
	b.Close(connID, 1000)
	_ = b.Shutdown()

	// Only OPEN + CLOSE (2 events), no per-frame MESSAGE events
	var frames int
	for _, e := range r.events() {
		if t := e["wsFrameType"]; t == "TEXT" || t == "BINARY" {
			frames++
		}
	}
	if frames != 0 {
		t.Errorf("per-frame events = %d, want 0 (default off)", frames)
	}
}

// ── PerFrameEvents on ──────────────────────────────────────────────────

func TestPerFrameEventsOn(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.PerFrameEvents = true })

	connID := b.Open("cust_001", nil)
	b.RecordFrame(connID, "CLIENT_TO_SERVER", "TEXT", 10)
	b.RecordFrame(connID, "SERVER_TO_CLIENT", "BINARY", 20)
	b.Close(connID, 1000)
	_ = b.Shutdown()

	var frames []map[string]any
	for _, e := range r.events() {
		if t := e["wsFrameType"]; t == "TEXT" || t == "BINARY" {
			frames = append(frames, e)
		}
	}
	if len(frames) != 2 {
		t.Fatalf("per-frame events = %d, want 2", len(frames))
	}
	if frames[0]["metricName"] != "websocket_api.message" {
		t.Errorf("metricName = %v", frames[0]["metricName"])
	}
}

// ── Close-code mapping ─────────────────────────────────────────────────

func TestCloseCodeMapping(t *testing.T) {
	cases := []struct {
		code   int
		reason string
	}{
		{1000, "NORMAL_CLOSURE"},
		{1001, "GOING_AWAY"},
		{1002, "PROTOCOL_ERROR"},
		{1003, "UNSUPPORTED_DATA"},
		{1006, "ABNORMAL_CLOSURE"},
		{1008, "POLICY_VIOLATION"},
		{1009, "MESSAGE_TOO_BIG"},
		{1011, "INTERNAL_ERROR"},
		{4000, "IDLE_TIMEOUT"},
	}

	for _, c := range cases {
		r := &rec{}
		srv := httptest.NewServer(r)
		b := newBilling(t, srv)
		connID := b.Open("cust_001", nil)
		b.Close(connID, c.code)
		_ = b.Shutdown()

		var got string
		for _, e := range r.events() {
			if e["wsFrameType"] == "CLOSE" {
				got = e["wsCloseReason"].(string)
			}
		}
		if got != c.reason {
			t.Errorf("code %d: got %s, want %s", c.code, got, c.reason)
		}
		srv.Close()
	}
}

// ── Unknown connection is a no-op ──────────────────────────────────────

func TestRecordFrameUnknownConnection(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv)

	b.RecordFrame("nonexistent", "CLIENT_TO_SERVER", "TEXT", 10)
	b.Close("nonexistent", 1000)
	_ = b.Shutdown()

	if n := len(r.events()); n != 0 {
		t.Errorf("got %d events, want 0", n)
	}
}

// ── Empty customerId is rejected ───────────────────────────────────────

func TestOpenRejectsEmptyCustomer(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv)

	connID := b.Open("", nil)
	if connID != "" {
		t.Errorf("expected empty connID for empty customer, got %q", connID)
	}
	_ = b.Shutdown()
	if n := len(r.events()); n != 0 {
		t.Errorf("got %d events, want 0", n)
	}
}

// ── Wire contract: POST /v1/ingest/batch ─────────────────────────────

func TestBatchWireContract(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.PerFrameEvents = true })

	id := b.Open("cust_001", nil)
	b.RecordFrame(id, "client_to_server", "text", 128)
	b.RecordFrame(id, "sideways", "blob", 1)
	b.Close(id, 1000)
	_ = b.Shutdown()

	r.mu.Lock()
	path, hdr, body := r.paths[0], r.headers[0], r.requests[0]
	r.mu.Unlock()
	if path != "/v1/ingest/batch" {
		t.Errorf("path = %s, want /v1/ingest/batch", path)
	}
	if hdr.Get("X-API-Key") != "sk_ws_abc" {
		t.Errorf("X-API-Key = %q", hdr.Get("X-API-Key"))
	}
	if _, ok := body["apiKey"]; ok {
		t.Error("apiKey must not be in the body")
	}
	evs := r.events()
	if len(evs) != 4 {
		t.Fatalf("events = %d, want 4", len(evs))
	}
	for _, ev := range evs {
		if _, ok := ev["apiKey"]; ok {
			t.Error("apiKey must not be in an event")
		}
		if _, ok := ev["durationMs"]; ok {
			t.Error("durationMs is not a DTO field; use executionDurationMs")
		}
		for _, k := range []string{"customerId", "metricName", "quantity", "occurredAt", "idempotencyKey", "productType", "wsConnectionId", "executionDurationMs", "dataBytes", "messageCount"} {
			if _, ok := ev[k]; !ok {
				t.Errorf("event missing %q: %v", k, ev)
			}
		}
		if _, err := time.Parse(time.RFC3339Nano, ev["occurredAt"].(string)); err != nil {
			t.Errorf("occurredAt not RFC3339: %v", err)
		}
	}
	// Lower-case enums are normalised; values outside the enum are omitted.
	if evs[1]["wsDirection"] != "CLIENT_TO_SERVER" || evs[1]["wsFrameType"] != "TEXT" {
		t.Errorf("frame enums = %v / %v", evs[1]["wsDirection"], evs[1]["wsFrameType"])
	}
	if _, ok := evs[2]["wsDirection"]; ok {
		t.Errorf("invalid wsDirection should be omitted: %v", evs[2]["wsDirection"])
	}
	if _, ok := evs[2]["wsFrameType"]; ok {
		t.Errorf("invalid wsFrameType should be omitted: %v", evs[2]["wsFrameType"])
	}
}

func TestLargeBufferSplitsIntoBatchesOf1000(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.FlushCount = 100000; c.PerFrameEvents = true })

	id := b.Open("cust_001", nil) // 1 event
	for i := 0; i < 2498; i++ {
		b.RecordFrame(id, "SERVER_TO_CLIENT", "TEXT", 10)
	}
	b.Close(id, 1000) // 1 event → 2500 total
	_ = b.Shutdown()

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.requests) != 3 {
		t.Fatalf("requests = %d, want 3", len(r.requests))
	}
	total := 0
	for _, body := range r.requests {
		n := len(body["events"].([]any))
		if n == 0 || n > 1000 {
			t.Errorf("batch size = %d, want 1..1000", n)
		}
		total += n
	}
	if total != 2500 {
		t.Errorf("total = %d, want 2500", total)
	}
}
