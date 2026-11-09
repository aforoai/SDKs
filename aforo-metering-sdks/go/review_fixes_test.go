package metering

// Regression tests for the 2026-11-09 SDK review (R1, R2, R3, R6, R7, #5, #6, #12).

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// wireServer records each event of each request and answers 202.
func wireServer(t *testing.T) (*httptest.Server, func() []map[string]any) {
	var mu sync.Mutex
	var events []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var b struct{ Events []map[string]any }
		_ = json.Unmarshal(raw, &b)
		mu.Lock()
		events = append(events, b.Events...)
		mu.Unlock()
		w.WriteHeader(202)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []map[string]any { mu.Lock(); defer mu.Unlock(); return append([]map[string]any(nil), events...) }
}

func TestTrackLeavesOutOfRangeIntegersOffAndKeepsTheEvent(t *testing.T) {
	srv, got := wireServer(t)
	c := mustNewClient(t, Options{APIKey: "k", BaseURL: srv.URL, Compression: "none"})
	if err := c.Track(TrackEvent{CustomerID: "c1", MetricName: "m", StatusCode: 40000, ResponseTimeMs: 3_000_000_000}); err != nil {
		t.Fatal(err)
	}
	if err := c.Track(TrackEvent{CustomerID: "c2", MetricName: "m", StatusCode: 200, ResponseTimeMs: 12}); err != nil {
		t.Fatal(err)
	}
	flushNow(c)
	ev := got()
	if len(ev) != 2 {
		t.Fatalf("sent %d events", len(ev))
	}
	if _, ok := ev[0]["statusCode"]; ok {
		t.Error("statusCode 40000 sent")
	}
	if _, ok := ev[0]["responseTimeMs"]; ok {
		t.Error("responseTimeMs 3e9 sent")
	}
	if ev[1]["statusCode"] != float64(200) || ev[1]["responseTimeMs"] != float64(12) {
		t.Errorf("in-range values changed: %v", ev[1])
	}
}

func TestOccurredAtNeedsSecondsAndAZone(t *testing.T) {
	c := mustNewClient(t, Options{APIKey: "k", BaseURL: "http://localhost:1"})
	for _, bad := range []string{"2026-11-09T10:00Z", "2026-11-09T10:00:00", "2026-11-09 10:00:00Z", "2026-11-09T10:00:00+0530", "2026-11-09"} {
		if err := c.Track(TrackEvent{CustomerID: "c", MetricName: "m", OccurredAt: bad}); !errors.Is(err, ErrInvalidEvent) {
			t.Errorf("OccurredAt %q accepted (err %v)", bad, err)
		}
	}
	for _, good := range []string{"2026-11-09T10:00:00Z", "2026-11-09T10:00:00.5Z", "2026-11-09T10:00:00+05:30", "2026-11-09T10:00:00-00:00"} {
		if err := c.Track(TrackEvent{CustomerID: "c", MetricName: "m", OccurredAt: good}); err != nil {
			t.Errorf("OccurredAt %q refused: %v", good, err)
		}
	}
}

// Metadata is a Go map, so it is always a JSON object (or left off when nil).
func TestMetadataIsAlwaysAnObject(t *testing.T) {
	srv, got := wireServer(t)
	c := mustNewClient(t, Options{APIKey: "k", BaseURL: srv.URL, Compression: "none"})
	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "m", Metadata: map[string]any{"a": 1}})
	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "m"})
	flushNow(c)
	ev := got()
	if _, ok := ev[0]["metadata"].(map[string]any); !ok {
		t.Errorf("metadata %T", ev[0]["metadata"])
	}
	if _, ok := ev[1]["metadata"]; ok {
		t.Error("nil metadata sent")
	}
}

// Behaviour kept on purpose (Go's zero value): documented in README/USER_GUIDE.
func TestZeroQuantityIsSentAsOne(t *testing.T) {
	srv, got := wireServer(t)
	c := mustNewClient(t, Options{APIKey: "k", BaseURL: srv.URL, Compression: "none"})
	_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "m"})
	flushNow(c)
	if q := got()[0]["quantity"]; q != float64(1) {
		t.Fatalf("quantity %v", q)
	}
}

func TestExcludePathsMatchWholeSegments(t *testing.T) {
	c := mustNewClient(t, Options{APIKey: "k", BaseURL: "http://localhost:1"})
	mw, _ := NewMiddleware(c, MiddlewareOptions{CustomerResolver: func(*http.Request) string { return "cust" }})
	h := mw(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	cases := map[string]bool{ // path → metered
		"/health": false, "/health/live": false, "/metrics": false, "/favicon.ico": false, "/ready/": false,
		"/healthcare/patients/1": true, "/readyset": true, "/metrics-export": true, "/v1/widgets": true,
	}
	for p, want := range cases {
		before := c.BufferedCount()
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", p, nil))
		if metered := c.BufferedCount() > before; metered != want {
			t.Errorf("%s metered=%v, want %v", p, metered, want)
		}
	}
	mw2, _ := NewMiddleware(c, MiddlewareOptions{ExcludePaths: []string{"/internal/"}, CustomerResolver: func(*http.Request) string { return "cust" }})
	h2 := mw2(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	before := c.BufferedCount()
	h2.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/internal/x", nil))
	h2.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/internals", nil))
	if c.BufferedCount()-before != 1 {
		t.Errorf("custom exclude: %d metered, want 1 (/internals)", c.BufferedCount()-before)
	}
}

func TestPanickingResolverDropsTheEventAsInvalid(t *testing.T) {
	var reasons []DropReason
	var mu sync.Mutex
	c := mustNewClient(t, Options{APIKey: "k", BaseURL: "http://localhost:1",
		OnDrop: func(ev []TrackEvent, r DropReason) { mu.Lock(); reasons = append(reasons, r); mu.Unlock() }})
	for name, opts := range map[string]MiddlewareOptions{
		"CustomerResolver": {CustomerResolver: func(*http.Request) string { panic("auth store down") }},
		"MetricNameFunc": {CustomerResolver: func(*http.Request) string { return "c" },
			MetricNameFunc: func(*http.Request) string { panic("bad route table") }},
	} {
		mw, _ := NewMiddleware(c, opts)
		served := false
		h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { served = true }))
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("%s: panic reached the server: %v", name, r)
				}
			}()
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/v1/x", nil))
		}()
		if !served {
			t.Errorf("%s: request not served", name)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if c.DroppedCount() != 2 || len(reasons) != 2 || reasons[0] != DropInvalid || reasons[1] != DropInvalid || c.BufferedCount() != 0 {
		t.Fatalf("dropped=%d reasons=%v queued=%d", c.DroppedCount(), reasons, c.BufferedCount())
	}
}

func TestMiddlewareRecordsTheFinalStatusNotA1xx(t *testing.T) {
	srv, got := wireServer(t)
	c := mustNewClient(t, Options{APIKey: "k", BaseURL: srv.URL, Compression: "none"})
	mw, _ := NewMiddleware(c, MiddlewareOptions{CustomerResolver: func(*http.Request) string { return "c" }, ExcludeStatusCode: []int{500}})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusEarlyHints)
		w.WriteHeader(http.StatusTeapot)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/v1/x", nil))
	h500 := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusEarlyHints)
		w.WriteHeader(500)
	}))
	h500.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/v1/y", nil))
	flushNow(c)
	ev := got()
	if len(ev) != 1 || ev[0]["statusCode"] != float64(418) {
		t.Fatalf("events %v, want one with statusCode 418 (the 500 is excluded)", ev)
	}
}

func TestAforoClientGoStringHidesKey(t *testing.T) {
	c := mustNewClient(t, Options{APIKey: "sk_live_SECRET", BaseURL: "http://localhost:1"})
	for _, f := range []string{"%v", "%+v", "%#v"} {
		if s := fmt.Sprintf(f, c); strings.Contains(s, "SECRET") {
			t.Errorf("%s shows the key: %s", f, s)
		}
	}
}
