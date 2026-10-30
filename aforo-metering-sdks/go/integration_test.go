package metering

// Transport behaviour against the shared mock ingestor (G267, G268, G273,
// G274, G312). Retry sleeps use injected hooks; waits poll conditions.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go/v2/internal/ingest"
)

type sleepLog struct {
	mu sync.Mutex
	d  []time.Duration
}

func (s *sleepLog) hooks() ingest.Hooks {
	h := fastHooks()
	h.Sleep = func(ctx context.Context, d time.Duration) error {
		s.mu.Lock()
		s.d = append(s.d, d)
		s.mu.Unlock()
		return ctx.Err()
	}
	return h
}

func (s *sleepLog) all() []time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]time.Duration(nil), s.d...)
}

func mockClient(t *testing.T, m *mockIngestor, mutate ...func(*Options)) (*AforoClient, *dropRecorder) {
	t.Helper()
	rec := &dropRecorder{}
	o := Options{APIKey: "sk_test_mock", BaseURL: m.URL, FlushCount: 100, FlushInterval: time.Hour,
		Timeout: 2 * time.Second, ShutdownTimeout: 2 * time.Second, OnDrop: rec.hook, hooks: fastHooks()}
	for _, f := range mutate {
		f(&o)
	}
	return mustNewClient(t, o), rec
}

func trackN(t *testing.T, c *AforoClient, n int, prefix string) []string {
	t.Helper()
	keys := make([]string, n)
	for i := range keys {
		keys[i] = fmt.Sprintf("%s-%04d", prefix, i)
		if err := c.Track(TrackEvent{CustomerID: "cust_1", MetricName: "api_calls", IdempotencyKey: keys[i]}); err != nil {
			t.Fatal(err)
		}
	}
	return keys
}

func TestMock_OutageThenRecoveryKeepsEveryKey(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"status": 503, "times": -1})
	c, rec := mockClient(t, m)
	keys := trackN(t, c, 25, "out")

	if _, err := c.Flush(context.Background()); !errors.Is(err, ErrIngestUnavailable) {
		t.Fatalf("Flush during outage = %v, want ErrIngestUnavailable", err)
	}
	if c.BufferedCount() != 25 || c.DroppedCount() != 0 {
		t.Fatalf("outage lost events: buffered=%d dropped=%d", c.BufferedCount(), c.DroppedCount())
	}
	m.clearFaults(t)
	res, err := c.Flush(context.Background())
	if err != nil || res.Sent != 25 {
		t.Fatalf("recovery Flush = %+v, %v", res, err)
	}
	st := m.state(t)
	if st.UniqueKeys != 25 || st.AcceptedCount != 25 {
		t.Fatalf("mock accepted %d (unique %d), want 25", st.AcceptedCount, st.UniqueKeys)
	}
	// 1 try + 3 retries during the outage, then the recovery send. The mock
	// records keys for requests it parsed (the accepted one).
	if len(st.Requests) != 5 {
		t.Fatalf("requests = %d, want 5", len(st.Requests))
	}
	if got := st.Requests[4].IdempotencyKeys; strings.Join(got, ",") != strings.Join(keys, ",") {
		t.Fatalf("the recovery send changed the keys: %v", got)
	}
	if len(rec.events) != 0 {
		t.Fatalf("drops during outage: %v", rec.reasons)
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
	c, _ := mockClient(t, m, func(o *Options) { o.hooks = sl.hooks() })
	trackN(t, c, 3, "ra")
	if res, err := c.Flush(context.Background()); err != nil || res.Sent != 3 {
		t.Fatalf("Flush = %+v, %v", res, err)
	}
	got := sl.all()
	if len(got) != 2 || got[0] != 2*time.Second {
		t.Fatalf("sleeps = %v, want [2s, <date>]", got)
	}
	if got[1] < time.Second || got[1] > 3*time.Second {
		t.Fatalf("HTTP-date Retry-After gave %v, want 1s–3s", got[1])
	}
}

func TestMock_HungResponseTimesOutAndRetriesSameKeys(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"hang": true, "times": 1})
	c, _ := mockClient(t, m, func(o *Options) { o.Timeout = 300 * time.Millisecond })
	keys := trackN(t, c, 4, "hang")
	start := time.Now()
	res, err := c.Flush(context.Background())
	if err != nil || res.Sent != 4 {
		t.Fatalf("Flush = %+v, %v", res, err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("the 300 ms request timeout did not fire (%v)", took)
	}
	st := m.state(t)
	if len(st.Requests) != 2 || st.Requests[0].Status != -2 {
		t.Fatalf("requests = %+v, want a hung one then a retry", st.Requests)
	}
	if strings.Join(st.Requests[1].IdempotencyKeys, ",") != strings.Join(keys, ",") {
		t.Fatal("the retry changed the keys")
	}
}

func TestMock_CloseHonoursDeadlineAndReportsLeftovers(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"hang": true, "times": -1})
	c, rec := mockClient(t, m, func(o *Options) {
		o.Timeout = 10 * time.Second
		o.ShutdownTimeout = 300 * time.Millisecond
	})
	trackN(t, c, 7, "close")
	start := time.Now()
	err := c.Close(context.Background())
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("Close took %v with a 300 ms shutdown deadline", took)
	}
	if !errors.Is(err, ErrShutdownIncomplete) {
		t.Fatalf("Close = %v, want ErrShutdownIncomplete", err)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.events) != 7 || rec.reasons[0] != DropShutdown || rec.events[0].IdempotencyKey != "close-0000" {
		t.Fatalf("leftovers = %d %v", len(rec.events), rec.reasons)
	}
}

func TestMock_SingleFlusherUnderLoad(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"delayMs": 5, "times": -1})
	c, _ := mockClient(t, m, func(o *Options) { o.FlushCount = 50 })
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 250; i++ {
				_ = c.Track(TrackEvent{CustomerID: "c", MetricName: "api_calls", IdempotencyKey: fmt.Sprintf("g%d-%d", g, i)})
			}
		}(g)
	}
	wg.Wait()
	if _, err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	st := m.state(t)
	if st.AcceptedCount != 2000 {
		t.Fatalf("accepted %d, want 2000", st.AcceptedCount)
	}
	if st.MaxInFlight != 1 {
		t.Fatalf("maxInFlight = %d, want 1 (one flusher)", st.MaxInFlight)
	}
}

func TestMock_PerEventRetryableRequeued(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"perEvent": []map[string]any{{"index": 1, "retryable": true, "message": "busy"}}, "times": 1})
	c, rec := mockClient(t, m)
	trackN(t, c, 3, "pe")
	_, _ = c.Flush(context.Background())
	if c.BufferedCount() != 1 {
		t.Fatalf("buffered = %d, want the retryable event back in the queue", c.BufferedCount())
	}
	_, _ = c.Flush(context.Background())
	st := m.state(t)
	if st.UniqueKeys != 3 || len(rec.events) != 0 {
		t.Fatalf("unique=%d drops=%v", st.UniqueKeys, rec.reasons)
	}
	last := st.Requests[len(st.Requests)-1].IdempotencyKeys
	if len(last) != 1 || last[0] != "pe-0001" {
		t.Fatalf("resent keys = %v, want [pe-0001]", last)
	}
}

func TestMock_OverflowWhileBreakerOpen(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"status": 502, "times": -1})
	c, rec := mockClient(t, m, func(o *Options) { o.MaxQueueSize = 10 })
	trackN(t, c, 10, "ov")
	_, _ = c.Flush(context.Background()) // opens the breaker; events requeued
	trackN(t, c, 5, "more")
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.events) != 5 || rec.reasons[0] != DropOverflow || rec.events[0].IdempotencyKey != "ov-0000" {
		t.Fatalf("overflow drops = %d %v", len(rec.events), rec.reasons)
	}
}

func TestMock_401IsAnOutageKeepingEvents(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"status": 401, "times": 1})
	c, rec := mockClient(t, m)
	trackN(t, c, 2, "auth")
	if _, err := c.Flush(context.Background()); !errors.Is(err, ErrIngestUnavailable) {
		t.Fatalf("err = %v", err)
	}
	if res, err := c.Flush(context.Background()); err != nil || res.Sent != 2 || len(rec.events) != 0 {
		t.Fatalf("after the key was fixed: %+v %v drops=%v", res, err, rec.reasons)
	}
}

// A one-event body is under the 1 KiB gzip threshold, so it goes plain (wave 8, G269).
func TestMock_SmallBodyPlainAndUserAgent(t *testing.T) {
	m := startMockIngestor(t)
	c, _ := mockClient(t, m)
	trackN(t, c, 1, "ua")
	_, _ = c.Flush(context.Background())
	st := m.state(t)
	r := st.Requests[0]
	if r.ContentEncoding != nil {
		t.Fatalf("Content-Encoding sent for a small body: %v", *r.ContentEncoding)
	}
	if r.UserAgent == nil || *r.UserAgent != "aforo-go/"+sdkVersion {
		t.Fatalf("User-Agent = %v", r.UserAgent)
	}
}

// A full batch is gzip-encoded and the mock ingestor (which decodes it like
// usage-ingestor's GzipRequestFilter) accepts every event (wave 8, G269).
func TestMock_LargeBatchGzip(t *testing.T) {
	m := startMockIngestor(t)
	c, _ := mockClient(t, m)
	trackN(t, c, 200, "gz")
	if _, err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	st := m.state(t)
	r := st.Requests[0]
	if r.ContentEncoding == nil || *r.ContentEncoding != "gzip" {
		t.Fatalf("Content-Encoding = %v, want gzip", r.ContentEncoding)
	}
	if st.UniqueKeys != 200 {
		t.Fatalf("mock accepted %d unique keys, want 200", st.UniqueKeys)
	}
}

// Edge-case rules against the shared mock ingestor (contract/TRANSPORT-SPEC.md).

func TestMock_StalledAndDrippedBodyCutOffAndRetried(t *testing.T) {
	for _, fault := range []map[string]any{{"stallBody": true, "times": 1}, {"dripMs": 100, "times": 1}} {
		m := startMockIngestor(t)
		m.faults(t, fault)
		c, _ := mockClient(t, m, func(o *Options) { o.Timeout = 300 * time.Millisecond })
		keys := trackN(t, c, 3, "body")
		start := time.Now()
		res, err := c.Flush(context.Background())
		if took := time.Since(start); took > 5*time.Second {
			t.Fatalf("%v: the 300 ms deadline did not cover the body (%v)", fault, took)
		}
		if err != nil || res.Sent != 3 {
			t.Fatalf("%v: Flush = %+v, %v; want the cut-off batch retried and sent", fault, res, err)
		}
		st := m.state(t)
		if len(st.Requests) != 2 || st.Requests[0].Status != -3 {
			t.Fatalf("%v: requests = %+v, want a cut-off body then a retry", fault, st.Requests)
		}
		if strings.Join(st.Requests[1].IdempotencyKeys, ",") != strings.Join(keys, ",") {
			t.Fatalf("%v: the retry changed the keys", fault)
		}
	}
}

func TestMock_RedirectNotFollowedAndRecovers(t *testing.T) {
	m := startMockIngestor(t)
	other := startMockIngestor(t)
	m.faults(t, map[string]any{"status": 308, "location": other.URL + "/v1/ingest/batch", "times": 1})
	c, rec := mockClient(t, m)
	keys := trackN(t, c, 2, "redir")
	if _, err := c.Flush(context.Background()); !errors.Is(err, ErrIngestUnavailable) {
		t.Fatalf("Flush = %v, want ErrIngestUnavailable", err)
	}
	if n := len(other.state(t).Requests); n != 0 {
		t.Fatalf("the redirect target got %d request(s): the key left the configured host", n)
	}
	if c.BufferedCount() != 2 || len(rec.all()) != 0 {
		t.Fatalf("buffered=%d drops=%d; want the events kept", c.BufferedCount(), len(rec.all()))
	}
	res, err := c.Flush(context.Background())
	if err != nil || res.Sent != 2 {
		t.Fatalf("recovery = %+v %v", res, err)
	}
	st := m.state(t)
	if strings.Join(st.Requests[len(st.Requests)-1].IdempotencyKeys, ",") != strings.Join(keys, ",") {
		t.Fatal("keys changed across the redirect outage")
	}
}

func TestMock_ShutdownRetriesUntilRecovery(t *testing.T) {
	m := startMockIngestor(t)
	m.faults(t, map[string]any{"status": 503, "times": 6})
	c, rec := mockClient(t, m, func(o *Options) { o.MaxRetries = 1; o.ShutdownTimeout = 3 * time.Second })
	trackN(t, c, 4, "sd")
	if err := c.Close(context.Background()); err != nil {
		t.Fatalf("Close = %v; the ingestor recovered before the deadline", err)
	}
	if st := m.state(t); st.UniqueKeys != 4 || len(rec.all()) != 0 {
		t.Fatalf("unique=%d drops=%d", st.UniqueKeys, len(rec.all()))
	}
}

func (r *dropRecorder) all() []TrackEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]TrackEvent(nil), r.events...)
}
