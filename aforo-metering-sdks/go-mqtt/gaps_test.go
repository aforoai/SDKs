package mqttmetering

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

func emitOneEvent(b *Billing) { b.RecordPublish("cust_1", "client_1", "a/b", 1, false, 10) }

// G276: recording over the threshold starts no goroutine.
func TestRecord_StartsNoGoroutines(t *testing.T) {
	gate := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-gate; w.WriteHeader(202) }))
	defer srv.Close()
	defer close(gate)
	b, err := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: srv.URL, FlushCount: 1,
		FlushInterval: time.Hour, ShutdownTimeout: 100 * time.Millisecond, hooks: fastHooks()})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown(bg)
	before := runtime.NumGoroutine()
	for i := 0; i < 500; i++ {
		emitOneEvent(b)
	}
	if extra := runtime.NumGoroutine() - before; extra > 8 {
		t.Fatalf("500 events started %d goroutines", extra)
	}
}

// G276: the queue is bounded; overflow evicts the oldest event.
func TestQueueIsBounded(t *testing.T) {
	d := &mockDrops{}
	b, err := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://127.0.0.1:1",
		MaxQueueSize: 3, FlushInterval: time.Hour, OnDrop: d.hook, ShutdownTimeout: 50 * time.Millisecond, hooks: fastHooks()})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown(bg)
	for i := 0; i < 5; i++ {
		emitOneEvent(b)
	}
	evs, reasons := d.snapshot()
	if b.BufferedCount() != 3 || len(evs) != 2 || reasons[0] != DropOverflow {
		t.Fatalf("buffered=%d drops=%d %v", b.BufferedCount(), len(evs), reasons)
	}
}

// A blank customer is not billed but is counted (DropInvalid).
func TestBlankCustomerIsCounted(t *testing.T) {
	d := &mockDrops{}
	b, err := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://127.0.0.1:1",
		FlushInterval: time.Hour, OnDrop: d.hook, ShutdownTimeout: 50 * time.Millisecond, hooks: fastHooks()})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown(bg)
	b.RecordConnect(" ", "client_1")
	if _, reasons := d.snapshot(); len(reasons) != 1 || reasons[0] != DropInvalid || b.BufferedCount() != 0 {
		t.Fatalf("reasons=%v buffered=%d", reasons, b.BufferedCount())
	}
}

// G270: https is enforced and the API key is never printed.
func TestHTTPSAndKeyRedaction(t *testing.T) {
	if _, err := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://api.example.com"}); err == nil {
		t.Fatal("plain http to a remote host accepted")
	}
	cfg := Config{TenantID: "t", ProductID: "p", APIKey: "sk_live_secret", IngestorURL: "https://api.example.com", hooks: fastHooks()}
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown(bg)
	for _, s := range []string{fmt.Sprint(cfg), fmt.Sprintf("%+v", cfg), fmt.Sprintf("%#v", cfg), fmt.Sprint(b)} {
		if strings.Contains(s, "sk_live_secret") {
			t.Fatalf("API key printed: %s", s)
		}
	}
}
