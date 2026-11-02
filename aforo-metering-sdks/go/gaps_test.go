package metering

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

// G270: plain http to a remote host is refused at construction.
func TestNewClient_RequiresHTTPS(t *testing.T) {
	if _, err := NewClient(Options{APIKey: "k", BaseURL: "http://api.example.com"}); err == nil {
		t.Fatal("http://api.example.com accepted")
	}
	if _, err := NewClient(Options{APIKey: " ", BaseURL: "https://api.example.com"}); err == nil {
		t.Fatal("a blank API key accepted")
	}
	c, err := NewClient(Options{APIKey: "k", BaseURL: "http://api.example.com", AllowInsecureHTTP: true})
	if err != nil {
		t.Fatalf("AllowInsecureHTTP ignored: %v", err)
	}
	closeNow(c)
}

// G270: the API key never appears in String / %v / %+v / %#v.
func TestOptions_StringRedactsAPIKey(t *testing.T) {
	o := Options{APIKey: "sk_live_supersecret", BaseURL: "https://api.example.com"}
	c := mustNewClient(t, o)
	for _, s := range []string{fmt.Sprint(o), fmt.Sprintf("%+v", o), fmt.Sprintf("%#v", o), fmt.Sprint(c), fmt.Sprintf("%+v", c)} {
		if strings.Contains(s, "sk_live_supersecret") {
			t.Fatalf("API key printed: %s", s)
		}
	}
}

// G269: default batch size is 500 events.
func TestOptions_DefaultFlushCountIs500(t *testing.T) {
	o := Options{}
	o.defaults()
	if o.FlushCount != 500 {
		t.Fatalf("FlushCount = %d, want 500", o.FlushCount)
	}
}

// G266/G274: Track over the threshold starts no goroutine; one flusher sends.
func TestTrack_OverThresholdStartsNoGoroutines(t *testing.T) {
	gate := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-gate; w.WriteHeader(202) }))
	defer srv.Close()
	defer close(gate)
	c := mustNewClient(t, Options{APIKey: "k", BaseURL: srv.URL, FlushCount: 1, FlushInterval: time.Hour, ShutdownTimeout: 100 * time.Millisecond})
	before := runtime.NumGoroutine()
	for i := 0; i < 500; i++ {
		_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "m"})
	}
	if extra := runtime.NumGoroutine() - before; extra > 8 {
		t.Fatalf("500 Track calls started %d goroutines", extra)
	}
}
