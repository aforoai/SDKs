package wsmetering

// Transport behaviour of this variant against the shared mock ingestor
// (contract/TRANSPORT-SPEC.md, G312). Retries use injected hooks; waits poll
// conditions, never fixed sleeps.

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type sleepLog struct {
	mu sync.Mutex
	d  []time.Duration
}

func (s *sleepLog) sleep(ctx context.Context, d time.Duration) error {
	s.mu.Lock()
	s.d = append(s.d, d)
	s.mu.Unlock()
	return ctx.Err()
}

func (s *sleepLog) all() []time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]time.Duration(nil), s.d...)
}

type mockDrops struct {
	mu      sync.Mutex
	events  []map[string]any
	reasons []DropReason
}

func (d *mockDrops) hook(events []map[string]any, reason DropReason) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for range events {
		d.reasons = append(d.reasons, reason)
	}
	d.events = append(d.events, events...)
}

func (d *mockDrops) snapshot() ([]map[string]any, []DropReason) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]map[string]any(nil), d.events...), append([]DropReason(nil), d.reasons...)
}

func newMockBilling(t *testing.T, m *mockIngestor, mutate ...func(*Config)) (*Billing, *mockDrops) {
	t.Helper()
	d := &mockDrops{}
	cfg := Config{
		TenantID: "tenant-mock", ProductID: "prod-mock", APIKey: "sk_test_mock", IngestorURL: m.URL,
		FlushCount: 100, FlushInterval: time.Hour, Timeout: 2 * time.Second, ShutdownTimeout: 2 * time.Second,
		OnDrop: d.hook, hooks: fastHooks(),
	}
	for _, f := range mutate {
		f(&cfg)
	}
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Shutdown(context.Background()) })
	return b, d
}

func emitN(b *Billing, n int) {
	for i := 0; i < n; i++ {
		emitOneEvent(b)
	}
}

func TestMock_OutageThenRecoveryKeepsEveryKey(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"status": 503, "times": -1})
	b, drops := newMockBilling(t, m)
	emitN(b, 20)
	if err := b.Flush(context.Background()); !errors.Is(err, ErrIngestUnavailable) {
		t.Fatalf("Flush during outage = %v, want ErrIngestUnavailable", err)
	}
	keys := b.tp.QueuedKeys()
	if len(keys) != 20 || b.DroppedCount() != 0 {
		t.Fatalf("outage lost events: queued=%d dropped=%d", len(keys), b.DroppedCount())
	}
	m.clearFaults(t)
	if err := b.Flush(context.Background()); err != nil {
		t.Fatalf("recovery Flush: %v", err)
	}
	st := m.state(t)
	if st.UniqueKeys != 20 || st.AcceptedCount != 20 {
		t.Fatalf("mock accepted %d (unique %d), want 20", st.AcceptedCount, st.UniqueKeys)
	}
	last := st.Requests[len(st.Requests)-1].IdempotencyKeys
	if strings.Join(last, ",") != strings.Join(keys, ",") {
		t.Fatal("the recovery send changed the idempotency keys")
	}
	if evs, _ := drops.snapshot(); len(evs) != 0 {
		t.Fatalf("drops during an outage: %d", len(evs))
	}
}

func TestMock_429RetryAfterBothForms(t *testing.T) {
	m := startMockIngestor(t)
	date := time.Now().Add(3 * time.Second).UTC().Format(http.TimeFormat)
	m.faults(t,
		map[string]any{"status": 429, "retryAfter": "2", "times": 1},
		map[string]any{"status": 429, "retryAfter": date, "times": 1},
	)
	sl := &sleepLog{}
	b, _ := newMockBilling(t, m, func(c *Config) { c.hooks.Sleep = sl.sleep })
	emitN(b, 2)
	if err := b.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := sl.all()
	if len(got) != 2 || got[0] != 2*time.Second || got[1] < time.Second || got[1] > 3*time.Second {
		t.Fatalf("sleeps = %v, want [2s, 1s–3s]", got)
	}
	if m.state(t).AcceptedCount != 2 {
		t.Fatal("events not delivered after the 429s")
	}
}

func TestMock_HungResponseTimesOut(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"hang": true, "times": 1})
	b, _ := newMockBilling(t, m, func(c *Config) { c.Timeout = 300 * time.Millisecond })
	emitN(b, 3)
	start := time.Now()
	if err := b.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("request timeout did not fire (%v)", took)
	}
	st := m.state(t)
	if st.Requests[0].Status != -2 || st.AcceptedCount != 3 {
		t.Fatalf("requests=%+v accepted=%d", st.Requests, st.AcceptedCount)
	}
}

func TestMock_ShutdownDeadlineReportsLeftovers(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"hang": true, "times": -1})
	b, drops := newMockBilling(t, m, func(c *Config) {
		c.Timeout = 10 * time.Second
		c.ShutdownTimeout = 300 * time.Millisecond
	})
	emitN(b, 5)
	start := time.Now()
	err := b.Shutdown(context.Background())
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("Shutdown took %v with a 300 ms deadline", took)
	}
	if !errors.Is(err, ErrShutdownIncomplete) {
		t.Fatalf("Shutdown = %v, want ErrShutdownIncomplete", err)
	}
	evs, reasons := drops.snapshot()
	if len(evs) < 5 || reasons[0] != DropShutdown {
		t.Fatalf("leftovers = %d %v, want at least 5 reported as shutdown", len(evs), reasons)
	}
	for _, e := range evs {
		if k, _ := e["idempotencyKey"].(string); k == "" {
			t.Fatal("a leftover lost its idempotency key")
		}
	}
}

func TestMock_SingleFlusher(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"delayMs": 5, "times": -1})
	b, _ := newMockBilling(t, m, func(c *Config) { c.FlushCount = 25 })
	var wg sync.WaitGroup
	for g := 0; g < 6; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			emitN(b, 100)
		}()
	}
	wg.Wait()
	if err := b.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	st := m.state(t)
	if st.AcceptedCount != 600 || st.MaxInFlight != 1 {
		t.Fatalf("accepted=%d maxInFlight=%d, want 600 and 1", st.AcceptedCount, st.MaxInFlight)
	}
}

func TestMock_PerEventRetryableRequeued(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"perEvent": []map[string]any{{"index": 0, "retryable": true}}, "times": 1})
	b, drops := newMockBilling(t, m)
	emitN(b, 3)
	_ = b.Flush(context.Background())
	if b.BufferedCount() != 1 {
		t.Fatalf("buffered = %d, want the retryable event back in the queue", b.BufferedCount())
	}
	_ = b.Flush(context.Background())
	if st := m.state(t); st.UniqueKeys != 3 {
		t.Fatalf("unique keys = %d, want 3", st.UniqueKeys)
	}
	if evs, _ := drops.snapshot(); len(evs) != 0 {
		t.Fatalf("a retryable event was dropped")
	}
}

func TestMock_OverflowWhileBreakerOpen(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"status": 502, "times": -1})
	b, drops := newMockBilling(t, m, func(c *Config) { c.MaxQueueSize = 10 })
	emitN(b, 10)
	_ = b.Flush(context.Background())
	emitN(b, 4)
	evs, reasons := drops.snapshot()
	if len(evs) != 4 || reasons[0] != DropOverflow {
		t.Fatalf("overflow drops = %d %v, want 4", len(evs), reasons)
	}
}
