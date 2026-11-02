package graphqlmetering

// Drop observability + OnDrop hook (A+ delivery-guarantee prompt 6 —
// transport-variant mirror of the core SDK's drop hardening).
//
// Retries use injected hooks (fastHooks), so no test waits on a real backoff.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql/v2/internal/ingest"
)

func newDropBilling(t *testing.T, url string, onDrop func([]map[string]any, DropReason)) *Billing {
	t.Helper()
	b, err := New(Config{
		TenantID:            "tenant-001",
		ProductID:           "prod-gql-001",
		APIKey:              "sk_test_abc",
		IngestorURL:         url,
		ShutdownTimeout:     300 * time.Millisecond, // shutdown retries until this deadline; keep tests fast
		hooks:               fastHooks(),
		TrustCustomerHeader: true,
		FlushCount:          100,
		FlushInterval:       time.Hour,
		OnDrop:              onDrop,
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func statusServer(status int, hits *atomic.Int32) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(status)
	}))
}

type dropCapture struct {
	mu      sync.Mutex
	events  []map[string]any
	reasons []DropReason
}

func (d *dropCapture) hook(events []map[string]any, reason DropReason) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.events = append(d.events, events...)
	d.reasons = append(d.reasons, reason)
}

func recordOne(b *Billing, customerID string) {
	b.Record(customerID, "{ a }", "", 5, false)
}

func TestDrop5xxOutageReportedAtShutdownWithKeys(t *testing.T) {
	var hits atomic.Int32
	srv := statusServer(503, &hits)
	defer srv.Close()

	cap := &dropCapture{}
	b := newDropBilling(t, srv.URL, cap.hook)
	recordOne(b, "cust_1")
	recordOne(b, "cust_2")
	// Shutdown keeps retrying until its deadline (contract/TRANSPORT-SPEC.md,
	// "Shutdown after an outage"); a short deadline keeps the test fast.
	ctx, cancel := context.WithTimeout(bg, 200*time.Millisecond)
	defer cancel()
	_ = b.Shutdown(ctx)

	if got := b.DroppedCount(); got != 2 {
		t.Fatalf("DroppedCount = %d, want 2", got)
	}
	// Since v2 an outage keeps the events queued (same keys); they are only
	// given up on when Shutdown's deadline passes.
	if len(cap.reasons) != 1 || cap.reasons[0] != DropShutdown {
		t.Fatalf("reasons = %v, want [shutdown]", cap.reasons)
	}
	if len(cap.events) != 2 {
		t.Fatalf("dropped events = %d, want 2", len(cap.events))
	}
	key, _ := cap.events[0]["idempotencyKey"].(string)
	if len(key) == 0 || key[:len("gql:")] != "gql:" {
		t.Fatalf("idempotencyKey %q does not start with gql:", key)
	}
	if got := hits.Load(); got < ingest.DefaultMaxRetries+1 { // first try + retries, then more until the deadline
		t.Fatalf("ingest hits = %d, want at least %d", got, ingest.DefaultMaxRetries+1)
	}
}

func TestDropTerminal4xxClassifiedRejected(t *testing.T) {
	var hits atomic.Int32
	srv := statusServer(400, &hits)
	defer srv.Close()

	cap := &dropCapture{}
	b := newDropBilling(t, srv.URL, cap.hook)
	recordOne(b, "cust_1")
	_ = b.Shutdown(bg)

	if got := b.DroppedCount(); got != 1 {
		t.Fatalf("DroppedCount = %d, want 1", got)
	}
	if len(cap.reasons) != 1 || cap.reasons[0] != DropRejected {
		t.Fatalf("reasons = %v, want [rejected]", cap.reasons)
	}
}

func TestDropNetworkFailureReportedAtShutdown(t *testing.T) {
	srv := statusServer(204, new(atomic.Int32))
	url := srv.URL
	srv.Close() // connection refused from here on

	cap := &dropCapture{}
	b := newDropBilling(t, url, cap.hook)
	recordOne(b, "cust_1")
	_ = b.Shutdown(bg)

	if got := b.DroppedCount(); got != 1 {
		t.Fatalf("DroppedCount = %d, want 1", got)
	}
	// Since v2 an outage keeps the events queued (same keys); they are only
	// given up on when Shutdown's deadline passes.
	if len(cap.reasons) != 1 || cap.reasons[0] != DropShutdown {
		t.Fatalf("reasons = %v, want [shutdown]", cap.reasons)
	}
}

func TestDropPanickingHookIsRecovered(t *testing.T) {
	var hits atomic.Int32
	srv := statusServer(503, &hits)
	defer srv.Close()

	b := newDropBilling(t, srv.URL, func([]map[string]any, DropReason) {
		panic("hook bug")
	})
	recordOne(b, "cust_1")
	_ = b.Shutdown(bg) // must not panic

	if got := b.DroppedCount(); got != 1 {
		t.Fatalf("DroppedCount = %d, want 1", got)
	}
}

func TestDropDefaultNoHookStillCounts(t *testing.T) {
	var hits atomic.Int32
	srv := statusServer(503, &hits)
	defer srv.Close()

	b := newDropBilling(t, srv.URL, nil)
	recordOne(b, "cust_1")
	_ = b.Shutdown(bg)

	if got := b.DroppedCount(); got != 1 {
		t.Fatalf("DroppedCount = %d, want 1", got)
	}
}

func TestDropHappyPathUnchanged(t *testing.T) {
	var hits atomic.Int32
	srv := statusServer(204, &hits)
	defer srv.Close()

	cap := &dropCapture{}
	b := newDropBilling(t, srv.URL, cap.hook)
	recordOne(b, "cust_1")
	_ = b.Shutdown(bg)

	if got := b.DroppedCount(); got != 0 {
		t.Fatalf("DroppedCount = %d, want 0", got)
	}
	if len(cap.reasons) != 0 {
		t.Fatalf("unexpected drops: %v", cap.reasons)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("ingest hits = %d, want 1", got)
	}
}

func TestDoubleShutdownDoesNotPanic(t *testing.T) {
	var hits atomic.Int32
	srv := statusServer(204, &hits)
	defer srv.Close()

	b := newDropBilling(t, srv.URL, nil)
	recordOne(b, "cust_1")
	_ = b.Shutdown(bg)
	_ = b.Shutdown(bg) // second call used to panic on close of closed channel
}
