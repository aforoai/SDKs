package graphqlmetering

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOutcomeFromGraphQLResponse(t *testing.T) {
	cases := map[string]string{
		`{"data":{"a":1}}`:                            "SUCCESS",
		`{"data":{"a":1},"errors":null}`:              "SUCCESS",
		`{"data":{"a":1},"errors":[]}`:                "SUCCESS",
		`{"data":{"a":1},"errors":[{"message":"x"}]}`: "PARTIAL",
		`{"data":null,"errors":[{"message":"x"}]}`:    "ERROR",
		`{"errors":[{"message":"x"}]}`:                "VALIDATION_FAILED",
		`{"data":null}`:                               "SUCCESS",
		`{"data":null,"errors":[]}`:                   "SUCCESS",
		`{"errors":[]}`:                               "SUCCESS",
		`{"errors":null}`:                             "SUCCESS",
		`{"data":{"a":1},"errors":{"message":"x"}}`:   "PARTIAL",
		`{"data":{"a":1},"errors":"boom"}`:            "PARTIAL",
		`{"data":null,"errors":{}}`:                   "ERROR",
		`{"data":null,"errors":"boom"}`:               "ERROR",
		`{"errors":{"message":"x"}}`:                  "VALIDATION_FAILED",
		`{"errors":"boom"}`:                           "VALIDATION_FAILED",
		`{"errors":0}`:                                "VALIDATION_FAILED",
		`[{"data":{"a":1}}]`:                          "",
		`{"hello":"world"}`:                           "",
		`not json`:                                    "",
		``:                                            "",
	}
	for body, want := range cases {
		if got := OutcomeFromGraphQLResponse([]byte(body)); got != want {
			t.Errorf("OutcomeFromGraphQLResponse(%q) = %q, want %q", body, got, want)
		}
	}
}

func TestOutcomeFromHTTPStatus(t *testing.T) {
	cases := map[int]string{
		100: "", 200: "SUCCESS", 204: "SUCCESS", 304: "SUCCESS",
		400: "VALIDATION_FAILED", 401: "BLOCKED", 403: "BLOCKED", 404: "ERROR",
		408: "TIMEOUT", 422: "VALIDATION_FAILED", 429: "BLOCKED", 499: "CANCELLED",
		500: "ERROR", 503: "ERROR", 504: "TIMEOUT", 600: "",
	}
	for code, want := range cases {
		if got := OutcomeFromHTTPStatus(code); got != want {
			t.Errorf("OutcomeFromHTTPStatus(%d) = %q, want %q", code, got, want)
		}
	}
}

func TestRecordOmitsExecutionStatus(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)
	b.Record("cust_001", "{ a }", "", 5, true)
	waitFor(t, func() bool { return len(rec.events()) == 1 }, 2*time.Second)
	if v, present := rec.events()[0]["executionStatus"]; present {
		t.Fatalf("Record must not send executionStatus, got %v", v)
	}
}

func TestRecordWithOptionsSendsNormalizedStatus(t *testing.T) {
	cases := map[string]any{
		" partial ": "PARTIAL", "   ": nil, "": nil,
		// Unknown / over-length values would reject the event: omitted.
		"done": nil, "SUCCESSFUL_OUTCOME_XYZ": nil,
	}
	for in, want := range cases {
		rec := &recorder{}
		srv := httptest.NewServer(rec)
		b := newBilling(t, srv)
		b.RecordWithOptions("cust_001", "{ a }", "", 5, false, EventOptions{ExecutionStatus: in})
		waitFor(t, func() bool { return len(rec.events()) == 1 }, 2*time.Second)
		got, present := rec.events()[0]["executionStatus"]
		if want == nil && present {
			t.Errorf("input %q: executionStatus must be omitted, got %v", in, got)
		}
		if want != nil && got != want {
			t.Errorf("input %q: executionStatus = %v, want %v", in, got, want)
		}
		if ev := rec.events()[0]; ev["customerId"] != "cust_001" || ev["gqlOperationType"] == nil {
			t.Errorf("input %q: rest of event not sent intact: %v", in, ev)
		}
		_ = b.Shutdown()
		srv.Close()
	}
}

func runMiddleware(t *testing.T, upstream http.HandlerFunc) map[string]any {
	t.Helper()
	rec := &recorder{}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)
	req := httptest.NewRequest(http.MethodPost, "/graphql",
		bytes.NewReader([]byte(`{"query":"query Test { user { id } }","operationName":"Test"}`)))
	req.Header.Set("X-Customer-Id", "cust_mw")
	w := httptest.NewRecorder()
	b.Middleware(upstream).ServeHTTP(w, req)
	waitFor(t, func() bool { return len(rec.events()) == 1 }, 2*time.Second)
	return rec.events()[0]
}

func TestMiddlewareDerivesExecutionStatus(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"data only", 200, `{"data":{"user":{"id":1}}}`, "SUCCESS"},
		{"partial", 200, `{"data":{"user":null},"errors":[{"message":"x"}]}`, "PARTIAL"},
		{"errors no data", 200, `{"data":null,"errors":[{"message":"x"}]}`, "ERROR"},
		{"errors without data key", 400, `{"errors":[{"message":"bad"}]}`, "VALIDATION_FAILED"},
		{"body wins over status", 429, `{"data":null,"errors":[{"message":"x"}]}`, "ERROR"},
		{"status fallback timeout", 504, `gateway timeout`, "TIMEOUT"},
		{"status fallback validation", 422, ``, "VALIDATION_FAILED"},
		{"status fallback blocked", 429, `slow down`, "BLOCKED"},
		{"status fallback success", 200, `ok`, "SUCCESS"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ev := runMiddleware(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			})
			if got := ev["executionStatus"]; got != c.want {
				t.Fatalf("executionStatus = %v, want %s", got, c.want)
			}
		})
	}
}

func TestMiddlewareOversizedBodyFallsBackToStatus(t *testing.T) {
	ev := runMiddleware(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"data":null,"errors":[{"message":"`))
		_, _ = w.Write([]byte(strings.Repeat("x", maxCapturedResponseBytes)))
		_, _ = w.Write([]byte(`"}]}`))
	})
	if got := ev["executionStatus"]; got != "SUCCESS" {
		t.Fatalf("executionStatus = %v, want SUCCESS (HTTP 200 fallback)", got)
	}
}

func TestMiddlewareSetExecutionStatusOverrides(t *testing.T) {
	ev := runMiddleware(t, func(w http.ResponseWriter, r *http.Request) {
		if !SetExecutionStatus(r.Context(), " hitl_required ") {
			t.Error("SetExecutionStatus returned false inside the middleware")
		}
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"data":null,"errors":[{"message":"x"}]}`))
	})
	if got := ev["executionStatus"]; got != "HITL_REQUIRED" {
		t.Fatalf("executionStatus = %v, want HITL_REQUIRED", got)
	}
}

func TestSetExecutionStatusOutsideMiddleware(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
	if SetExecutionStatus(req.Context(), "SUCCESS") {
		t.Fatal("SetExecutionStatus must return false outside the middleware")
	}
}
