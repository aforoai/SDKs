package metering

import (
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

	opts.APIKey = "test-key"
	opts.BaseURL = ingestor.URL
	opts.ClientOptions = &Options{BaseURL: ingestor.URL, FlushCount: 1, FlushInterval: time.Minute}
	wrapped := HTTPMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}), opts)

	for _, r := range reqs {
		wrapped.ServeHTTP(httptest.NewRecorder(), r)
	}
	time.Sleep(200 * time.Millisecond)

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
	events := meteredRequests(t, MiddlewareOptions{},
		newReq("GET", "/users/42", map[string]string{"X-Customer-Id": "cust_1"}))
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].MetricName != "api_calls" || events[0].CustomerID != "cust_1" {
		t.Fatalf("unexpected event %+v", events[0])
	}
}

func TestHTTPMiddleware_NeverUsesAPIKeyAsCustomer(t *testing.T) {
	events := meteredRequests(t, MiddlewareOptions{},
		newReq("GET", "/users/42", map[string]string{"X-Api-Key": "secret"}))
	if len(events) != 0 {
		t.Fatalf("X-Api-Key must not be used as customerId; got %+v", events)
	}
}

func TestHTTPMiddleware_SkipsOptionsPreflight(t *testing.T) {
	events := meteredRequests(t, MiddlewareOptions{},
		newReq("OPTIONS", "/users/42", map[string]string{
			"X-Customer-Id":                 "cust_1",
			"Access-Control-Request-Method": "POST",
		}))
	if len(events) != 0 {
		t.Fatalf("OPTIONS must not be metered; got %+v", events)
	}
}

func TestHTTPMiddleware_MetricAndCustomerOptions(t *testing.T) {
	events := meteredRequests(t, MiddlewareOptions{MetricName: "sms_sent", CustomerIDHeader: "X-Account"},
		newReq("POST", "/send", map[string]string{"X-Account": "acct_1", "X-Customer-Id": "ignored"}))
	if len(events) != 1 || events[0].MetricName != "sms_sent" || events[0].CustomerID != "acct_1" {
		t.Fatalf("unexpected events %+v", events)
	}

	events = meteredRequests(t, MiddlewareOptions{
		MetricName:     "fallback_metric",
		MetricNameFunc: func(r *http.Request) string { return r.URL.Query().Get("m") },
		CustomerIDFunc: func(r *http.Request) string { return "cust_fn" },
	},
		newReq("GET", "/x?m=otp_delivered", nil),
		newReq("GET", "/x", nil))
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %+v", events)
	}
	if events[0].MetricName != "otp_delivered" || events[1].MetricName != "fallback_metric" {
		t.Fatalf("unexpected metric names %+v", events)
	}
	if events[0].CustomerID != "cust_fn" {
		t.Fatalf("unexpected customer %+v", events[0])
	}
}

func TestNormalizePathExported(t *testing.T) {
	if got := NormalizePath("/users/123"); got != "/users/:id" {
		t.Fatalf("NormalizePath = %q", got)
	}
}
