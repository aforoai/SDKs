package wsmetering

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

// emitOneEvent records exactly one event (see emit in contract_test.go).
func emitOneEvent(b *Billing) { b.connections.Delete(b.Open("cust_1", nil)) }

// G276: recording over the threshold starts no goroutine.
func TestRecord_StartsNoGoroutines(t *testing.T) {
	gate := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-gate; w.WriteHeader(202) }))
	defer srv.Close()
	defer close(gate)
	b, err := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: srv.URL, FlushCount: 1,
		PerFrameEvents: true, FlushInterval: time.Hour, ShutdownTimeout: 100 * time.Millisecond, hooks: fastHooks()})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown(bg)
	id := b.Open("c", nil)
	before := runtime.NumGoroutine()
	for i := 0; i < 500; i++ {
		b.RecordFrame(id, "CLIENT_TO_SERVER", "TEXT", 1)
	}
	if extra := runtime.NumGoroutine() - before; extra > 8 {
		t.Fatalf("500 frames started %d goroutines", extra)
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

// G279: Shutdown closes connections that are still open.
func TestShutdownSynthesizesCloseForOpenConnections(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv)
	b.Open("cust_a", nil)
	b.Open("cust_b", nil)
	if b.OpenConnections() != 2 {
		t.Fatalf("open = %d", b.OpenConnections())
	}
	_ = b.Shutdown(bg)
	if b.OpenConnections() != 0 {
		t.Fatal("Shutdown left connections in the map")
	}
	closes := 0
	for _, e := range r.events() {
		if e["wsFrameType"] == "CLOSE" {
			closes++
			meta := e["metadata"].(map[string]any)
			if e["wsCloseReason"] != "GOING_AWAY" || meta["closedBy"] != "sdk_shutdown" {
				t.Errorf("shutdown close = %v / %v", e["wsCloseReason"], meta["closedBy"])
			}
		}
	}
	if closes != 2 {
		t.Fatalf("CLOSE events = %d, want 2", closes)
	}
}

// G279: an idle connection is closed by the sweep; an active one is kept.
func TestIdleSweepClosesStaleConnections(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.ConnectionIdleTimeout = time.Hour })
	stale := b.Open("cust_stale", nil)
	fresh := b.Open("cust_fresh", nil)
	b.connections.Range(func(k, v any) bool {
		if k == stale {
			v.(*ConnectionState).lastActivity.Store(time.Now().Add(-2 * time.Hour).UnixMilli())
		}
		return true
	})
	if n := b.sweepIdle(time.Now()); n != 1 {
		t.Fatalf("swept %d, want 1", n)
	}
	if _, ok := b.connections.Load(fresh); !ok {
		t.Fatal("the active connection was swept")
	}
	_ = b.Shutdown(bg)
	found := false
	for _, e := range r.events() {
		if e["wsConnectionId"] == stale && e["wsFrameType"] == "CLOSE" {
			found = e["metadata"].(map[string]any)["closedBy"] == "sdk_idle_timeout" && e["wsCloseReason"] == "ABNORMAL_CLOSURE"
		}
	}
	if !found {
		t.Fatal("no idle-timeout CLOSE event for the stale connection")
	}
}

// A blank customer is not billed but is counted (DropInvalid).
func TestOpenBlankCustomerIsCounted(t *testing.T) {
	d := &mockDrops{}
	b, err := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://127.0.0.1:1",
		FlushInterval: time.Hour, OnDrop: d.hook, ShutdownTimeout: 50 * time.Millisecond, hooks: fastHooks()})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown(bg)
	if id := b.Open("  ", nil); id != "" {
		t.Fatal("blank customer opened a connection")
	}
	if _, reasons := d.snapshot(); len(reasons) != 1 || reasons[0] != DropInvalid || b.DroppedCount() != 1 {
		t.Fatalf("reasons=%v dropped=%d", reasons, b.DroppedCount())
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
