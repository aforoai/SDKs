package graphqlmetering

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
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

func TestTruncateUTF16(t *testing.T) {
	if got := truncateUTF16("abc", 3); got != "abc" {
		t.Errorf("value at the limit changed: %q", got)
	}
	if got := truncateUTF16(strings.Repeat("é", 600), 255); utf16Len(got) != 255 || !utf8.ValidString(got) {
		t.Errorf("multi-byte: %d units, want 255", utf16Len(got))
	}
	if got := truncateUTF16("abc"+strings.Repeat("😀", 5), 4); got != "abc" {
		t.Errorf("cut inside a surrogate pair: %q", got)
	}
	if got := truncateUTF16("abc"+strings.Repeat("😀", 5), 5); got != "abc😀" {
		t.Errorf("got %q, want abc + one emoji", got)
	}
}

func postGraphQL(h http.Handler, customerID, query, operationName string) {
	body, _ := json.Marshal(map[string]any{"query": query, "operationName": operationName})
	req := httptest.NewRequest(http.MethodPost, "/graphql", bytes.NewReader(body))
	req.Header.Set("X-Customer-Id", customerID)
	h.ServeHTTP(httptest.NewRecorder(), req)
}

var okGraphQL = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	_, _ = w.Write([]byte(`{"data":{"a":1}}`))
})

func TestMiddlewareOverLongOperationNameIsTruncatedAndSent(t *testing.T) {
	logs := captureLog(t)
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	drops := &dropSink{}
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100; c.OnDrop = drops.hook })
	h := b.Middleware(okGraphQL)

	// Request operationName: 254 units then emoji, so a cut at 255 would
	// split a surrogate pair. Shares its first 254 characters with nameB.
	shared := strings.Repeat("N", 254)
	nameA := shared + strings.Repeat("😀", 30)
	nameB := shared + strings.Repeat("Z", 60)
	// Name parsed from the query text (no operationName in the request).
	parsed := strings.Repeat("P", 300)
	postGraphQL(h, "cust_1", "query Q { a }", nameA)
	postGraphQL(h, "cust_1", "query Q { a }", nameB)
	postGraphQL(h, "cust_1", "query "+parsed+" { a }", "")
	_ = shutdown(b)

	evs := srv.events()
	if len(evs) != 3 || b.DroppedCount() != 0 {
		t.Fatalf("server saw %d events, dropped %d; want 3 / 0", len(evs), b.DroppedCount())
	}
	gotA, gotB, gotP := evs[0]["gqlOperationName"].(string), evs[1]["gqlOperationName"].(string), evs[2]["gqlOperationName"].(string)
	if gotA != shared || utf16Len(gotA) != 254 || !utf8.ValidString(gotA) {
		t.Errorf("name A: %d units, want the 254 before the surrogate pair", utf16Len(gotA))
	}
	if gotB != nameB[:255] || utf16Len(gotB) != 255 {
		t.Errorf("name B: %d units, want exactly 255", utf16Len(gotB))
	}
	if gotP != parsed[:255] {
		t.Errorf("parsed name: %d units, want exactly 255", utf16Len(gotP))
	}
	// Keys come from the full names: A and B truncate to labels that share a
	// prefix, but their keys carry different digests.
	keyA, keyB := evs[0]["idempotencyKey"].(string), evs[1]["idempotencyKey"].(string)
	if !strings.HasPrefix(keyA, "gql:tenant-001:prod-001:"+sha256Hex(nameA)+":") {
		t.Errorf("key A not derived from the untruncated name: %q", keyA)
	}
	if !strings.HasPrefix(keyB, "gql:tenant-001:prod-001:"+sha256Hex(nameB)+":") {
		t.Errorf("key B not derived from the untruncated name: %q", keyB)
	}
	for _, ev := range evs {
		if n := charLen(ev["idempotencyKey"].(string)); n > 255 {
			t.Errorf("idempotencyKey is %d characters", n)
		}
	}
	if n := strings.Count(logs.String(), "gqlOperationName taken from the request"); n != 1 {
		t.Errorf("truncation WARN logged %d times across 3 events, want 1", n)
	}
}

func TestIdempotencyKeyForIsStableAndDistinct(t *testing.T) {
	// Unchanged for a name that fits.
	if got := idempotencyKeyFor("t", "p", "GetUser", 1700000000000, "abcd1234"); got != "gql:t:p:GetUser:1700000000000:abcd1234" {
		t.Errorf("key for a short name changed: %q", got)
	}
	a := strings.Repeat("N", 255) + "a"
	b := strings.Repeat("N", 255) + "b"
	k := idempotencyKeyFor("t", "p", a, 1, "s")
	if k != idempotencyKeyFor("t", "p", a, 1, "s") {
		t.Errorf("second evaluation of the same request gave a different key")
	}
	if k == idempotencyKeyFor("t", "p", b, 1, "s") {
		t.Errorf("names sharing their first 255 characters share a key")
	}
	if charLen(k) > 255 {
		t.Errorf("key is %d characters", charLen(k))
	}
}

func TestMiddlewareOverLongCustomerIDStillDropped(t *testing.T) {
	captureLog(t)
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	drops := &dropSink{}
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100; c.OnDrop = drops.hook })
	postGraphQL(b.Middleware(okGraphQL), strings.Repeat("c", 65), "query Q { a }", "Q")
	_ = shutdown(b)
	_, reasons := drops.snapshot()
	if len(srv.events()) != 0 || len(reasons) != 1 || reasons[0] != DropInvalid {
		t.Errorf("events=%d reasons=%v, want 0 events and one %q drop", len(srv.events()), reasons, DropInvalid)
	}
}

// An operationName handed to Record still originates from the client's
// request, so it is truncated and sent like one the Middleware reads.
func TestRecordOverLongOperationNameIsTruncatedAndSent(t *testing.T) {
	logs := captureLog(t)
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100 })
	shared := strings.Repeat("N", 254)
	nameA := shared + strings.Repeat("😀", 30)
	nameB := strings.Repeat("N", 300)
	b.Record("cust_1", "query Q { a }", nameA, 3, false)
	b.Record("cust_1", "query Q { a }", nameB, 3, false)
	_ = shutdown(b)

	evs := srv.events()
	if len(evs) != 2 || b.DroppedCount() != 0 {
		t.Fatalf("server saw %d events, dropped %d; want 2 / 0", len(evs), b.DroppedCount())
	}
	if got := evs[0]["gqlOperationName"].(string); got != shared || !utf8.ValidString(got) {
		t.Errorf("name A: %d units, want the 254 before the surrogate pair", utf16Len(got))
	}
	if got := evs[1]["gqlOperationName"].(string); got != nameB[:255] {
		t.Errorf("name B: %d units, want exactly 255", utf16Len(got))
	}
	for i, name := range []string{nameA, nameB} {
		if key := evs[i]["idempotencyKey"].(string); !strings.HasPrefix(key, "gql:tenant-001:prod-001:"+sha256Hex(name)+":") {
			t.Errorf("key %d not derived from the untruncated name: %q", i, key)
		}
	}
	if n := strings.Count(logs.String(), "gqlOperationName taken from the request"); n != 1 {
		t.Errorf("truncation WARN logged %d times across 2 events, want 1", n)
	}
}

func TestRecordOverLongCustomerIDStillDropped(t *testing.T) {
	logs := captureLog(t)
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	drops := &dropSink{}
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100; c.OnDrop = drops.hook })
	b.Record(strings.Repeat("c", 65), "query Q { a }", "Q", 3, false)
	b.Record("cust_1", "query Q { a }", "Q", 3, false, EventOptions{ProductType: strings.Repeat("p", 21)})
	_ = shutdown(b)
	_, reasons := drops.snapshot()
	if len(srv.events()) != 0 || len(reasons) != 2 || reasons[0] != DropInvalid || reasons[1] != DropInvalid {
		t.Errorf("events=%d reasons=%v, want 0 events and two %q drops", len(srv.events()), reasons, DropInvalid)
	}
	if strings.Contains(logs.String(), "truncated to") {
		t.Errorf("a caller-set field was reported as truncated")
	}
}
