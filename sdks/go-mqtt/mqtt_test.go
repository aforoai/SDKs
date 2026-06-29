// Tests for mqttmetering. Unique bits:
//   - 6 record methods (Publish / Deliver / Subscribe / Unsubscribe / Connect / Disconnect)
//   - DELIVER opt-in via EmitDeliverEvents
//   - QoS + retained flags on every event
//   - metricName formula: mqtt_broker.{eventType.lower()}

package mqttmetering

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sync"
	"testing"
	"time"
)

type rec struct {
	mu       sync.Mutex
	requests []map[string]any
}

func (r *rec) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	raw, _ := io.ReadAll(req.Body)
	req.Body.Close()
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	r.mu.Lock()
	r.requests = append(r.requests, body)
	r.mu.Unlock()
	w.WriteHeader(204)
}

func (r *rec) events() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []map[string]any{}
	for _, b := range r.requests {
		if evs, ok := b["events"].([]any); ok {
			for _, e := range evs {
				out = append(out, e.(map[string]any))
			}
		}
	}
	return out
}

func newBilling(t *testing.T, srv *httptest.Server, opts ...func(*Config)) *Billing {
	t.Helper()
	cfg := Config{
		TenantID:      "tenant-001",
		ProductID:     "prod-mqtt-001",
		APIKey:        "sk_mqtt_abc",
		IngestorURL:   srv.URL,
		FlushCount:    1,
		FlushInterval: 60 * time.Second,
	}
	for _, o := range opts {
		o(&cfg)
	}
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func waitFor(t *testing.T, cond func() bool, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timeout")
}

// ── PUBLISH ────────────────────────────────────────────────────────────

func TestPublishEventShape(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv)

	b.RecordPublish("cust_001", "device-001", "sensors/room-a/temperature", 1, false, 4)
	waitFor(t, func() bool { return len(r.events()) == 1 }, 2*time.Second)
	_ = b.Shutdown()

	ev := r.events()[0]
	want := map[string]any{
		"productType":   "MQTT_BROKER",
		"mqttEventType": "PUBLISH",
		"mqttTopic":     "sensors/room-a/temperature",
		"mqttQos":       float64(1),
		"mqttRetained":  false,
		"mqttClientId":  "device-001",
		"dataBytes":     float64(4),
		"customerId":    "cust_001",
		"metricName":    "mqtt_broker.publish",
	}
	for k, v := range want {
		if ev[k] != v {
			t.Errorf("event[%q] = %v, want %v", k, ev[k], v)
		}
	}
}

// ── DELIVER opt-in ─────────────────────────────────────────────────────

func TestDeliverSkippedByDefault(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.FlushCount = 100 })
	b.RecordDeliver("cust_001", "device-001", "t", 0, false, 10)
	_ = b.Shutdown()

	for _, e := range r.events() {
		if e["mqttEventType"] == "DELIVER" {
			t.Errorf("DELIVER event emitted when EmitDeliverEvents=false")
		}
	}
}

func TestDeliverEmittedWhenEnabled(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.EmitDeliverEvents = true })

	b.RecordDeliver("cust_001", "device-001", "sensors/a", 1, false, 7)
	waitFor(t, func() bool { return len(r.events()) == 1 }, 2*time.Second)
	_ = b.Shutdown()

	ev := r.events()[0]
	if ev["mqttEventType"] != "DELIVER" {
		t.Errorf("mqttEventType = %v", ev["mqttEventType"])
	}
	if ev["metricName"] != "mqtt_broker.deliver" {
		t.Errorf("metricName = %v", ev["metricName"])
	}
}

// ── All 6 event types → metricName formula ──────────────────────────

func TestMetricNameFormula(t *testing.T) {
	cases := []struct {
		emit     func(*Billing)
		want     string
		metric   string
	}{
		{func(b *Billing) { b.RecordPublish("c", "x", "t", 0, false, 0) }, "PUBLISH", "mqtt_broker.publish"},
		{func(b *Billing) { b.RecordSubscribe("c", "x", "t", 0) }, "SUBSCRIBE", "mqtt_broker.subscribe"},
		{func(b *Billing) { b.RecordUnsubscribe("c", "x", "t") }, "UNSUBSCRIBE", "mqtt_broker.unsubscribe"},
		{func(b *Billing) { b.RecordConnect("c", "x") }, "CONNECT", "mqtt_broker.connect"},
		{func(b *Billing) { b.RecordDisconnect("c", "x") }, "DISCONNECT", "mqtt_broker.disconnect"},
	}

	for _, c := range cases {
		r := &rec{}
		srv := httptest.NewServer(r)
		b := newBilling(t, srv)
		c.emit(b)
		waitFor(t, func() bool { return len(r.events()) == 1 }, 2*time.Second)
		_ = b.Shutdown()

		ev := r.events()[0]
		if ev["mqttEventType"] != c.want {
			t.Errorf("eventType = %v, want %s", ev["mqttEventType"], c.want)
		}
		if ev["metricName"] != c.metric {
			t.Errorf("metricName = %v, want %s", ev["metricName"], c.metric)
		}
		srv.Close()
	}
}

// ── QoS + retained flags carried ─────────────────────────────────────

func TestQosRetainedCarried(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv, func(c *Config) { c.FlushCount = 3 })

	b.RecordPublish("c", "x", "t", 0, false, 1)
	b.RecordPublish("c", "x", "t", 1, true, 1)
	b.RecordPublish("c", "x", "t", 2, false, 1)
	waitFor(t, func() bool { return len(r.events()) == 3 }, 2*time.Second)
	_ = b.Shutdown()

	events := r.events()
	for i, expectQos := range []float64{0, 1, 2} {
		if events[i]["mqttQos"] != expectQos {
			t.Errorf("event[%d].mqttQos = %v, want %v", i, events[i]["mqttQos"], expectQos)
		}
	}
	if events[1]["mqttRetained"] != true {
		t.Errorf("event[1].mqttRetained = %v, want true", events[1]["mqttRetained"])
	}
}

// ── Empty customerId rejected ────────────────────────────────────────

func TestEmptyCustomerIDRejected(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv)
	b.RecordPublish("", "x", "t", 0, false, 1)
	_ = b.Shutdown()
	if n := len(r.events()); n != 0 {
		t.Errorf("got %d events, want 0", n)
	}
}

// ── idempotencyKey format ─────────────────────────────────────────────

func TestIdempotencyKeyFormat(t *testing.T) {
	r := &rec{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b := newBilling(t, srv)

	b.RecordPublish("cust_001", "c1", "a/b", 0, false, 1)
	waitFor(t, func() bool { return len(r.events()) == 1 }, 2*time.Second)
	_ = b.Shutdown()

	key := r.events()[0]["idempotencyKey"].(string)
	re := regexp.MustCompile(`^mqtt:tenant-001:c1:PUBLISH:a/b:\d+:[a-z0-9]{8}$`)
	if !re.MatchString(key) {
		t.Errorf("idempotencyKey=%q does not match format", key)
	}
}
