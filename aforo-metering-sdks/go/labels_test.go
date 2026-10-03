package metering

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &buf
}

func TestTruncateUTF16(t *testing.T) {
	if got := truncateUTF16("abc", 3); got != "abc" {
		t.Errorf("value at the limit changed: %q", got)
	}
	if got := truncateUTF16(strings.Repeat("é", 600), 512); utf16Len(got) != 512 || !utf8.ValidString(got) {
		t.Errorf("multi-byte: %d units, valid=%v; want 512 units", utf16Len(got), utf8.ValidString(got))
	}
	// 3 BMP units + emoji (2 units each). A cut at 4 would split the first pair.
	got := truncateUTF16("abc"+strings.Repeat("😀", 5), 4)
	if got != "abc" {
		t.Errorf("cut inside a surrogate pair: %q, want %q", got, "abc")
	}
	if got := truncateUTF16("abc"+strings.Repeat("😀", 5), 5); got != "abc😀" {
		t.Errorf("got %q, want abc + one emoji", got)
	}
}

func newLabelMiddleware(t *testing.T, url string) http.Handler {
	t.Helper()
	return HTTPMiddleware(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }),
		MiddlewareOptions{
			APIKey:        "k",
			ClientOptions: &Options{BaseURL: url, FlushCount: 1, FlushInterval: 50 * time.Millisecond, MaxRetries: 1, RetryBase: time.Millisecond},
		})
}

func waitEvents(t *testing.T, srv *captureServer, n int) []map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if evs := srv.events(); len(evs) >= n {
			return evs
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("got %d events, want %d", len(srv.events()), n)
	return nil
}

func TestHTTPMiddleware_OverLongPathAndMethodAreTruncatedAndSent(t *testing.T) {
	logs := captureLog(t)
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	h := newLabelMiddleware(t, ts.URL)

	// 510 BMP units, then emoji: a cut at 512 lands exactly after one emoji;
	// the second request puts the boundary inside a surrogate pair.
	for _, path := range []string{
		"/" + strings.Repeat("a", 509) + strings.Repeat("😀", 50),
		"/" + strings.Repeat("a", 510) + strings.Repeat("😀", 50),
	} {
		req := httptest.NewRequest("GET", "/x", nil)
		req.URL.Path = path
		req.Method = strings.Repeat("M", 40)
		req.Header.Set("X-Customer-Id", "cust_1")
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
	evs := waitEvents(t, srv, 2)

	wantLens := map[int]bool{512: false, 511: false}
	for _, ev := range evs {
		p := ev["endpointPath"].(string)
		if !utf8.ValidString(p) || strings.ContainsRune(p, utf8.RuneError) {
			t.Errorf("endpointPath has a broken character: %q", p[len(p)-8:])
		}
		n := utf16Len(p)
		if _, ok := wantLens[n]; !ok {
			t.Errorf("endpointPath is %d UTF-16 units, want 512 (or 511 when the cut would split a pair)", n)
		}
		wantLens[n] = true
		if m := ev["httpMethod"].(string); m != strings.Repeat("M", 16) {
			t.Errorf("httpMethod = %q, want 16 characters", m)
		}
		if ev["metricName"] != DefaultMetricName {
			t.Errorf("metricName = %v", ev["metricName"])
		}
	}
	if !wantLens[512] || !wantLens[511] {
		t.Errorf("expected one path of 512 and one of 511 units, got %v", wantLens)
	}
	if evs[0]["idempotencyKey"] == evs[1]["idempotencyKey"] {
		t.Errorf("two requests share an idempotency key")
	}
	out := logs.String()
	if n := strings.Count(out, "endpointPath taken from the request"); n != 1 {
		t.Errorf("endpointPath truncation WARN logged %d times, want 1", n)
	}
	if n := strings.Count(out, "httpMethod taken from the request"); n != 1 {
		t.Errorf("httpMethod truncation WARN logged %d times, want 1", n)
	}
}

func TestHTTPMiddleware_OverLongCustomerIDStillDropped(t *testing.T) {
	captureLog(t)
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	h := newLabelMiddleware(t, ts.URL)

	req := httptest.NewRequest("GET", "/v1/data", nil)
	req.Header.Set("X-Customer-Id", strings.Repeat("c", 65))
	h.ServeHTTP(httptest.NewRecorder(), req)
	time.Sleep(200 * time.Millisecond)
	if n := len(srv.events()); n != 0 {
		t.Errorf("got %d events for an over-long customer id, want 0", n)
	}
}

// A label the SDK caller passes to Track is never shortened.
func TestTrack_ExplicitOverLongLabelsStillDropped(t *testing.T) {
	captureLog(t)
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	var reasons []DropReason
	c := newTestClient(t, ts.URL, func(o *Options) {
		o.OnDrop = func(_ []TrackEvent, r DropReason) { reasons = append(reasons, r) }
	})
	for _, ev := range []TrackEvent{
		{CustomerID: strings.Repeat("c", 65), MetricName: "api_calls"},
		{CustomerID: "cust_1", MetricName: "api_calls", EndpointPath: "/" + strings.Repeat("a", 512)},
		{CustomerID: "cust_1", MetricName: "api_calls", HTTPMethod: strings.Repeat("M", 17)},
	} {
		if err := c.Track(ev); err == nil {
			t.Errorf("Track accepted an over-long explicit field: %+v", ev)
		}
	}
	if len(reasons) != 3 {
		t.Fatalf("OnDrop called %d times, want 3", len(reasons))
	}
	for _, r := range reasons {
		if r != DropInvalid {
			t.Errorf("reason = %q, want %q", r, DropInvalid)
		}
	}
}
