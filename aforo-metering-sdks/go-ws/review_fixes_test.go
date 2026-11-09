package wsmetering

// Regression tests for the 2026-11-09 SDK review (#2, #5, #8, R3, R8).

import (
	"context"
	"encoding/json"
	"fmt"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// openReturns runs Open on another goroutine and reports whether it returned.
func openReturns(b *Billing, customer string, meta map[string]any) bool {
	done := make(chan struct{})
	go func() { b.Open(customer, meta); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(3 * time.Second):
		return false
	}
}

// Config.OnError "may call Flush or Shutdown": doing so while Open reports an
// unserializable event must not deadlock Open or later Opens.
func TestShutdownFromOnErrorDuringOpenDoesNotDeadlock(t *testing.T) {
	var b *Billing
	var calls atomic.Int32
	b, _ = New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://localhost:1", hooks: fastHooks(),
		OnError: func(err error) {
			if calls.Add(1) == 1 {
				ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
				defer cancel()
				_ = b.Shutdown(ctx)
			}
		}})
	if !openReturns(b, "cust_1", map[string]any{"bad": func() {}}) {
		t.Fatal("Open blocked: Shutdown in OnError deadlocked")
	}
	if !openReturns(b, "cust_2", nil) {
		t.Fatal("a later Open blocked")
	}
	if b.OpenConnections() != 0 {
		t.Fatalf("%d connections tracked", b.OpenConnections())
	}
}

func TestShutdownFromOnDropOnOverflowDuringOpenDoesNotDeadlock(t *testing.T) {
	var b *Billing
	var once atomic.Bool
	b, _ = New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://localhost:1", MaxQueueSize: 1, FlushCount: 1000, hooks: fastHooks(),
		OnDrop: func(ev []map[string]any, r DropReason) {
			if r == DropOverflow && once.CompareAndSwap(false, true) {
				ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
				defer cancel()
				_ = b.Shutdown(ctx)
			}
		}})
	b.Open("cust_1", nil)
	if !openReturns(b, "cust_2", nil) {
		t.Fatal("Open blocked: Shutdown in OnDrop(overflow) deadlocked")
	}
}

func TestIdleSweptConnectionIsTrackedAgainOnItsNextFrame(t *testing.T) {
	var mu sync.Mutex
	now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	h := fastHooks()
	h.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	advance := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }
	srv, events := captureServer(t)
	b, _ := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: srv.URL, Compression: "none", PerFrameEvents: true, hooks: h})
	defer b.Shutdown(bg)
	id := b.Open("cust_1", map[string]any{"room": "a"})
	advance(61 * time.Minute)
	if n := b.sweepIdle(h.Now()); n != 1 {
		t.Fatalf("swept %d", n)
	}
	for i := 0; i < 3; i++ {
		b.RecordFrame(id, "SERVER_TO_CLIENT", "TEXT", 100)
	}
	advance(time.Second)
	b.Close(id, 1000)
	b.Close(id, 1000) // a second Close sends nothing
	_ = b.Flush(bg)
	var frames, closes int
	for _, e := range events() {
		meta, _ := e["metadata"].(map[string]any)
		switch e["metricName"] {
		case "websocket_api.message":
			frames++
			if e["customerId"] != "cust_1" || meta["resumedAfterIdle"] != true || meta["room"] != "a" {
				t.Errorf("resumed frame event %v", e)
			}
		case "websocket_api.connection_closed":
			closes++
			if closes == 2 && (meta["frames"] != float64(3) || meta["bytes"] != float64(300)) {
				t.Errorf("second close %v", meta)
			}
		case "websocket_api.connection_opened":
			if meta["resumedAfterIdle"] == true {
				t.Error("a second CONNECTION_OPENED was sent")
			}
		}
	}
	if frames != 3 || closes != 2 {
		t.Fatalf("frames=%d closes=%d, want 3 and 2 (sweep + your Close)", frames, closes)
	}
	// Forgotten after 24 × ConnectionIdleTimeout.
	id2 := b.Open("cust_2", nil)
	advance(61 * time.Minute)
	b.sweepIdle(h.Now())
	advance(25 * time.Hour)
	b.sweepIdle(h.Now())
	before := b.BufferedCount()
	b.RecordFrame(id2, "SERVER_TO_CLIENT", "TEXT", 1)
	if b.BufferedCount() != before || b.OpenConnections() != 0 {
		t.Fatal("a connection swept more than 24 × ConnectionIdleTimeout ago was tracked again")
	}
}

func TestLongConnectionDurationIsLeftOffNotSent(t *testing.T) {
	var mu sync.Mutex
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	cur := start
	h := fastHooks()
	h.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return cur }
	srv, events := captureServer(t)
	b, _ := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: srv.URL, Compression: "none", PerFrameEvents: true,
		ConnectionIdleTimeout: 1000 * time.Hour, hooks: h})
	defer b.Shutdown(bg)
	id := b.Open("cust_1", nil)
	mu.Lock()
	cur = start.Add(25 * 24 * time.Hour) // executionDurationMs 2 160 000 000 > int32
	mu.Unlock()
	b.RecordFrame(id, "SERVER_TO_CLIENT", "TEXT", 10)
	_ = b.Flush(bg)
	ev := events()
	last := ev[len(ev)-1]
	if _, ok := last["executionDurationMs"]; ok {
		t.Fatalf("executionDurationMs %v sent", last["executionDurationMs"])
	}
	if last["metricName"] != "websocket_api.message" || last["dataBytes"] != float64(10) {
		t.Fatalf("frame event lost or changed: %v", last)
	}
}

func TestBillingGoStringHidesKey(t *testing.T) {
	b, _ := New(Config{TenantID: "t", ProductID: "p", APIKey: "sk_live_SECRET", IngestorURL: "http://localhost:1", hooks: fastHooks()})
	defer b.Shutdown(bg)
	for _, f := range []string{"%v", "%+v", "%#v"} {
		if s := fmt.Sprintf(f, b); strings.Contains(s, "SECRET") {
			t.Errorf("%s shows the key", f)
		}
	}
}

func TestReadmeQuickstartImportsWhatItUses(t *testing.T) {
	checkQuickstart(t, "README.md")
}

func checkQuickstart(t *testing.T, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	i := strings.Index(s, "## Quickstart")
	j := strings.Index(s[i:], "```go\n")
	k := strings.Index(s[i+j+6:], "```")
	code := s[i+j+6 : i+j+6+k]
	f, err := parser.ParseFile(token.NewFileSet(), "quickstart.go", code, parser.ImportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	imported := map[string]bool{}
	for _, im := range f.Imports {
		p, _ := strconv.Unquote(im.Path.Value)
		imported[p] = true
	}
	for _, pkg := range []string{"context", "log", "os", "time"} {
		if strings.Contains(code, pkg+".") && !imported[pkg] {
			t.Errorf("quickstart uses %s. without importing %q", pkg, pkg)
		}
	}
}

func captureServer(t *testing.T) (*httptest.Server, func() []map[string]any) {
	var mu sync.Mutex
	var got []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Events []map[string]any }
		_ = json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		got = append(got, b.Events...)
		mu.Unlock()
		w.WriteHeader(202)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []map[string]any { mu.Lock(); defer mu.Unlock(); return append([]map[string]any(nil), got...) }
}
