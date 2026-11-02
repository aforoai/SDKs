package mqttmetering

import (
	"bytes"
	"log"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
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

func TestBoundedKey(t *testing.T) {
	// A key that fits is byte-identical to the plain concatenation.
	if got := boundedKey("p:t:", "name", ":1:abc"); got != "p:t:name:1:abc" {
		t.Errorf("short key changed: %q", got)
	}
	long := strings.Repeat("x", 300)
	k1 := boundedKey("p:t:", long, ":1:abc")
	if k1 != "p:t:"+sha256Hex(long)+":1:abc" {
		t.Errorf("over-long component not replaced by its digest: %q", k1)
	}
	if k1 != boundedKey("p:t:", long, ":1:abc") {
		t.Errorf("same input gave two keys")
	}
	// Same first 255 characters, different tail of the component.
	if k1 == boundedKey("p:t:", long+"y", ":1:abc") {
		t.Errorf("two different components share a key")
	}
	// Over-long head: still within the limit, tail kept.
	k3 := boundedKey(strings.Repeat("h", 400), long, ":1:abc")
	if charLen(k3) > maxIdempotencyKeyLen || !strings.HasSuffix(k3, ":1:abc") {
		t.Errorf("fallback key = %q", k3)
	}
	// Multi-byte text is measured in characters, not bytes, and never cut.
	multi := strings.Repeat("é", 200)
	if got := boundedKey("p:", multi, ":1:abc"); got != "p:"+multi+":1:abc" {
		t.Errorf("a 208-character multi-byte key was altered")
	}
}
func TestIdempotencyKeyForIsStableAndDistinct(t *testing.T) {
	if got := idempotencyKeyFor("t", "client-1", "PUBLISH", "devices/1/telemetry", 1700000000000, "abcd1234"); got != "mqtt:t:client-1:PUBLISH:devices/1/telemetry:1700000000000:abcd1234" {
		t.Errorf("key for a short topic changed: %q", got)
	}
	a := strings.Repeat("t", 400) + "/a"
	b := strings.Repeat("t", 400) + "/b"
	k := idempotencyKeyFor("t", "client-1", "PUBLISH", a, 1, "s")
	if k != idempotencyKeyFor("t", "client-1", "PUBLISH", a, 1, "s") {
		t.Errorf("second evaluation of the same message gave a different key")
	}
	if k == idempotencyKeyFor("t", "client-1", "PUBLISH", b, 1, "s") {
		t.Errorf("topics sharing their first 400 characters share a key")
	}
	if k != "mqtt:t:client-1:PUBLISH:"+sha256Hex(a)+":1:s" {
		t.Errorf("over-long topic not replaced by its digest: %q", k)
	}
}

// A 400-character topic is within the ingestor's 500 limit: the event is sent
// unchanged, with a key that fits in 255 and is not cut.
func TestLongTopicWithinLimitIsSentWithBoundedKey(t *testing.T) {
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100 })
	topic := strings.Repeat("é", 400)
	b.RecordPublish("cust_1", "client-1", topic, 1, false, 1)
	_ = shutdown(b)
	evs := srv.events()
	if len(evs) != 1 {
		t.Fatalf("server saw %d events, want 1", len(evs))
	}
	if evs[0]["mqttTopic"] != topic {
		t.Errorf("topic within the limit was altered")
	}
	key := evs[0]["idempotencyKey"].(string)
	if !strings.HasPrefix(key, "mqtt:tenant-001:client-1:PUBLISH:"+sha256Hex(topic)+":") || charLen(key) > 255 {
		t.Errorf("key = %q", key)
	}
}

func TestOverLongTopicAndClientIDAreTruncatedAndSent(t *testing.T) {
	logs := captureLog(t)
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100; c.EmitDeliverEvents = true })

	// 499 units then emoji: a cut at 500 would split a surrogate pair.
	shared := strings.Repeat("t", 499)
	topicA := shared + strings.Repeat("😀", 30)
	topicB := shared + strings.Repeat("z", 200)
	client := strings.Repeat("k", 127) + strings.Repeat("😀", 10)
	b.RecordPublish("cust_1", "client-1", topicA, 1, false, 1)
	b.RecordPublish("cust_1", "client-1", topicB, 1, false, 1)
	b.RecordDeliver("cust_1", "client-1", topicB, 1, false, 1)
	b.RecordSubscribe("cust_1", client, "a/b", 1)
	b.RecordUnsubscribe("cust_1", client, topicB)
	b.RecordConnect("cust_1", client)
	b.RecordDisconnect("cust_1", client)
	_ = shutdown(b)

	evs := srv.events()
	if len(evs) != 7 || b.DroppedCount() != 0 {
		t.Fatalf("server saw %d events, dropped %d; want 7 / 0", len(evs), b.DroppedCount())
	}
	if got := evs[0]["mqttTopic"].(string); got != shared || !utf8.ValidString(got) {
		t.Errorf("topic A: %d units, want the 499 before the surrogate pair", utf16Len(got))
	}
	for _, i := range []int{1, 2, 4} {
		if got := evs[i]["mqttTopic"].(string); got != topicB[:500] {
			t.Errorf("event %d mqttTopic is %d units, want exactly 500", i, utf16Len(got))
		}
	}
	for _, i := range []int{3, 4, 5, 6} {
		got := evs[i]["mqttClientId"].(string)
		if got != client[:127] || !utf8.ValidString(got) {
			t.Errorf("event %d mqttClientId is %d units, want the 127 before the surrogate pair", i, utf16Len(got))
		}
	}
	// Keys come from the full topic: A and B share 499 characters.
	keyA, keyB := evs[0]["idempotencyKey"].(string), evs[1]["idempotencyKey"].(string)
	if !strings.HasPrefix(keyA, "mqtt:tenant-001:client-1:PUBLISH:"+sha256Hex(topicA)+":") {
		t.Errorf("key A not derived from the untruncated topic: %q", keyA)
	}
	if !strings.HasPrefix(keyB, "mqtt:tenant-001:client-1:PUBLISH:"+sha256Hex(topicB)+":") {
		t.Errorf("key B not derived from the untruncated topic: %q", keyB)
	}
	// The full client id (147 units) is in the SUBSCRIBE key, untruncated.
	if key := evs[3]["idempotencyKey"].(string); !strings.HasPrefix(key, "mqtt:tenant-001:"+client+":SUBSCRIBE:a/b:") {
		t.Errorf("SUBSCRIBE key does not carry the full client id: %q", key)
	}
	for i, ev := range evs {
		if n := charLen(ev["idempotencyKey"].(string)); n > 255 {
			t.Errorf("event %d idempotencyKey is %d characters", i, n)
		}
	}
	out := logs.String()
	if n := strings.Count(out, "mqttTopic taken from the request or message"); n != 1 {
		t.Errorf("mqttTopic truncation WARN logged %d times, want 1", n)
	}
	if n := strings.Count(out, "mqttClientId taken from the request or message"); n != 1 {
		t.Errorf("mqttClientId truncation WARN logged %d times, want 1", n)
	}
}

func TestOverLongCustomerIDAndProductTypeStillDropped(t *testing.T) {
	logs := captureLog(t)
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	drops := &dropSink{}
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100; c.OnDrop = drops.hook })
	b.RecordPublish(strings.Repeat("c", 65), "client-1", "a/b", 1, false, 1)
	b.RecordPublish("cust_1", "client-1", "a/b", 1, false, 1, EventOptions{ProductType: strings.Repeat("p", 21)})
	_ = shutdown(b)
	_, reasons := drops.snapshot()
	if len(srv.events()) != 0 || len(reasons) != 2 || reasons[0] != DropInvalid || reasons[1] != DropInvalid {
		t.Errorf("events=%d reasons=%v, want 0 events and two %q drops", len(srv.events()), reasons, DropInvalid)
	}
	if strings.Contains(logs.String(), "truncated to") {
		t.Errorf("a caller-set field was reported as truncated")
	}
}
