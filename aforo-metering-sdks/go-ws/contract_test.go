// Contract tests: top-level productType (config default + per-event
// override), errors[].message surfacing, no retry on non-retryable 4xx, and
// Retry-After on 429.
package wsmetering

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

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
		body:   `{"accepted":0,"duplicates":0,"failed":1,"errors":[{"index":0,"message":"unknown metric"}]}`,
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
