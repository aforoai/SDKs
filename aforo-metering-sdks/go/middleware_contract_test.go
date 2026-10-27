package metering

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type capturedEvent struct {
	CustomerID string  `json:"customerId"`
	MetricName string  `json:"metricName"`
	Quantity   float64 `json:"quantity"`
}

// meteredRequests runs each request through HTTPMiddleware against a fake
// ingestor and returns the events the ingestor received.
func meteredRequests(t *testing.T, opts MiddlewareOptions, reqs ...*http.Request) []capturedEvent {
	t.Helper()
	var mu sync.Mutex
	var events []capturedEvent
	ingestor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Events []capturedEvent `json:"events"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		events = append(events, body.Events...)
		mu.Unlock()
		w.WriteHeader(202)
	}))
	defer ingestor.Close()

	client := mustNewClient(t, Options{APIKey: "test-key", BaseURL: ingestor.URL, FlushCount: 100, FlushInterval: time.Minute})
	wrapped, err := HTTPMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}), client, opts)
	if err != nil {
		t.Fatal(err)
	}

	for _, r := range reqs {
		wrapped.ServeHTTP(httptest.NewRecorder(), r)
	}
	flushNow(client)

	mu.Lock()
	defer mu.Unlock()
	return append([]capturedEvent(nil), events...)
}

func newReq(method, path string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestHTTPMiddleware_DefaultMetricIsCatalogName(t *testing.T) {
	events := meteredRequests(t, MiddlewareOptions{TrustCustomerHeader: true},
		newReq("GET", "/users/42", map[string]string{"X-Customer-Id": "cust_1"}))
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].MetricName != "api_calls" || events[0].CustomerID != "cust_1" {
		t.Fatalf("unexpected event %+v", events[0])
	}
}

func TestHTTPMiddleware_NeverUsesAPIKeyAsCustomer(t *testing.T) {
	events := meteredRequests(t, MiddlewareOptions{TrustCustomerHeader: true},
		newReq("GET", "/users/42", map[string]string{"X-Api-Key": "secret"}))
	if len(events) != 0 {
		t.Fatalf("X-Api-Key must not be used as customerId; got %+v", events)
	}
}

func TestHTTPMiddleware_SkipsOptionsPreflight(t *testing.T) {
	events := meteredRequests(t, MiddlewareOptions{TrustCustomerHeader: true},
		newReq("OPTIONS", "/users/42", map[string]string{
			"X-Customer-Id":                 "cust_1",
			"Access-Control-Request-Method": "POST",
		}))
	if len(events) != 0 {
		t.Fatalf("OPTIONS must not be metered; got %+v", events)
	}
}

func TestHTTPMiddleware_MetricAndCustomerOptions(t *testing.T) {
	events := meteredRequests(t, MiddlewareOptions{MetricName: "sms_sent", TrustCustomerHeader: true, CustomerIDHeader: "X-Account"},
		newReq("POST", "/send", map[string]string{"X-Account": "acct_1", "X-Customer-Id": "ignored"}))
	if len(events) != 1 || events[0].MetricName != "sms_sent" || events[0].CustomerID != "acct_1" {
		t.Fatalf("unexpected events %+v", events)
	}

	events = meteredRequests(t, MiddlewareOptions{
		MetricName:       "fallback_metric",
		MetricNameFunc:   func(r *http.Request) string { return r.URL.Query().Get("m") },
		CustomerResolver: func(r *http.Request) string { return "cust_fn" },
	},
		newReq("GET", "/x?m=otp_delivered", nil),
		newReq("GET", "/x", nil))
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %+v", events)
	}
	metrics := map[string]bool{}
	for _, e := range events {
		metrics[e.MetricName] = true
		if e.CustomerID != "cust_fn" {
			t.Fatalf("unexpected customer %+v", e)
		}
	}
	if !metrics["otp_delivered"] || !metrics["fallback_metric"] {
		t.Fatalf("unexpected metric names %+v", events)
	}
}

func TestNormalizePathExported(t *testing.T) {
	if got := NormalizePath("/users/123"); got != "/users/:id" {
		t.Fatalf("NormalizePath = %q", got)
	}
}

// G265: with neither a CustomerResolver nor TrustCustomerHeader the middleware
// refuses to build — it never silently bills the caller-controlled header.
func TestNewMiddleware_RequiresResolverOrExplicitTrust(t *testing.T) {
	client := mustNewClient(t, Options{APIKey: "k", BaseURL: "http://127.0.0.1:1", FlushInterval: time.Hour})
	if _, err := NewMiddleware(client, MiddlewareOptions{}); err != ErrNoCustomerResolver {
		t.Fatalf("err = %v, want ErrNoCustomerResolver", err)
	}
	if _, err := NewMiddleware(nil, MiddlewareOptions{TrustCustomerHeader: true}); err == nil {
		t.Fatal("a nil client must be refused")
	}
	if _, err := NewMiddleware(client, MiddlewareOptions{TrustCustomerHeader: true}); err != nil {
		t.Fatalf("explicit trust refused: %v", err)
	}
}

// The resolver wins over the header, even when the header is set.
func TestHTTPMiddleware_ResolverIgnoresCustomerHeader(t *testing.T) {
	events := meteredRequests(t, MiddlewareOptions{
		CustomerResolver: func(r *http.Request) string { return "cust_from_session" },
	}, newReq("GET", "/x", map[string]string{"X-Customer-Id": "attacker_chosen"}))
	if len(events) != 1 || events[0].CustomerID != "cust_from_session" {
		t.Fatalf("events = %+v, want the resolver's customer", events)
	}
}

// G272: every handler wrapped by one middleware shares the caller's client,
// and Close on that client sends what the handlers recorded.
func TestChiMiddleware_SharesOneCallerOwnedClient(t *testing.T) {
	var mu sync.Mutex
	var got []capturedEvent
	ingestor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Events []capturedEvent `json:"events"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		got = append(got, body.Events...)
		mu.Unlock()
		w.WriteHeader(202)
	}))
	defer ingestor.Close()
	client, err := NewClient(Options{APIKey: "k", BaseURL: ingestor.URL, FlushInterval: time.Hour, hooks: fastHooks()})
	if err != nil {
		t.Fatal(err)
	}
	mw, err := ChiMiddleware(client, MiddlewareOptions{CustomerResolver: func(*http.Request) string { return "cust_1" }})
	if err != nil {
		t.Fatal(err)
	}
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	for i := 0; i < 3; i++ { // three routes, one middleware
		mw(ok).ServeHTTP(httptest.NewRecorder(), newReq("GET", "/r", nil))
	}
	if client.BufferedCount() != 3 {
		t.Fatalf("BufferedCount = %d, want 3 on the shared client", client.BufferedCount())
	}
	if err := client.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 3 {
		t.Fatalf("ingestor got %d events after Close, want 3", len(got))
	}
}
