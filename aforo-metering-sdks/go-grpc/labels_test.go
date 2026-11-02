package grpcmetering

import (
	"bytes"
	"context"
	"log"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
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

func callUnary(t *testing.T, b *Billing, customerID, fullMethod string) {
	t.Helper()
	ctx := metadata.NewIncomingContext(context.Background(), metadata.Pairs("x-customer-id", customerID))
	_, err := b.UnaryInterceptor()(ctx, nil, &grpc.UnaryServerInfo{FullMethod: fullMethod},
		func(ctx context.Context, req any) (any, error) { return "ok", nil })
	if err != nil {
		t.Fatal(err)
	}
}

type labelStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (f *labelStream) Context() context.Context { return f.ctx }

func TestInterceptorOverLongMethodIsTruncatedAndSent(t *testing.T) {
	logs := captureLog(t)
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100 })

	// 127 units then emoji: a cut at 128 would split a surrogate pair.
	shared := strings.Repeat("M", 127)
	methodA := shared + strings.Repeat("😀", 30)
	methodB := shared + strings.Repeat("Z", 300)
	callUnary(t, b, "cust_1", "/acme.v1.UserService/"+methodA)
	callUnary(t, b, "cust_1", "/acme.v1.UserService/"+methodB)
	ctx := metadata.NewIncomingContext(context.Background(), metadata.Pairs("x-customer-id", "cust_1"))
	if err := b.StreamInterceptor()(nil, &labelStream{ctx: ctx}, &grpc.StreamServerInfo{FullMethod: "/acme.v1.UserService/" + methodB, IsServerStream: true},
		func(srv any, ss grpc.ServerStream) error { return nil }); err != nil {
		t.Fatal(err)
	}
	_ = shutdown(b)

	evs := srv.events()
	if len(evs) != 3 || b.DroppedCount() != 0 {
		t.Fatalf("server saw %d events, dropped %d; want 3 / 0", len(evs), b.DroppedCount())
	}
	gotA, gotB := evs[0]["grpcMethod"].(string), evs[1]["grpcMethod"].(string)
	if gotA != shared || !utf8.ValidString(gotA) {
		t.Errorf("method A: %d units, want the 127 before the surrogate pair", utf16Len(gotA))
	}
	if gotB != methodB[:128] || utf16Len(gotB) != 128 {
		t.Errorf("method B: %d units, want exactly 128", utf16Len(gotB))
	}
	if evs[2]["grpcMethod"] != methodB[:128] || evs[2]["grpcCallType"] != "SERVER_STREAM" {
		t.Errorf("stream event grpcMethod/grpcCallType = %v / %v", utf16Len(evs[2]["grpcMethod"].(string)), evs[2]["grpcCallType"])
	}
	service := evs[0]["grpcService"].(string)
	keyA, keyB := evs[0]["idempotencyKey"].(string), evs[1]["idempotencyKey"].(string)
	if !strings.HasPrefix(keyA, "grpc:tenant-001:"+service+":"+methodA+":") {
		t.Errorf("key A (fits in 255) should carry the full, untruncated method: %q", keyA)
	}
	if !strings.HasPrefix(keyB, "grpc:tenant-001:"+service+":"+sha256Hex(methodB)+":") {
		t.Errorf("key B not derived from the untruncated method: %q", keyB)
	}
	if n := strings.Count(logs.String(), "grpcMethod taken from the request"); n != 1 {
		t.Errorf("truncation WARN logged %d times across 3 events, want 1", n)
	}
}

func TestIdempotencyKeyForIsStableAndDistinct(t *testing.T) {
	if got := idempotencyKeyFor("t", "acme.v1.UserService", "GetUser", 1700000000000, "abcd1234"); got != "grpc:t:acme.v1.UserService:GetUser:1700000000000:abcd1234" {
		t.Errorf("key for a short method changed: %q", got)
	}
	a := strings.Repeat("M", 300) + "a"
	b := strings.Repeat("M", 300) + "b"
	k := idempotencyKeyFor("t", "svc", a, 1, "s")
	if k != idempotencyKeyFor("t", "svc", a, 1, "s") {
		t.Errorf("second evaluation of the same request gave a different key")
	}
	if k == idempotencyKeyFor("t", "svc", b, 1, "s") {
		t.Errorf("methods sharing their first 128 characters share a key")
	}
	if charLen(k) > 255 {
		t.Errorf("key is %d characters", charLen(k))
	}
}

func TestInterceptorOverLongCustomerIDStillDropped(t *testing.T) {
	captureLog(t)
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	drops := &dropSink{}
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100; c.OnDrop = drops.hook })
	callUnary(t, b, strings.Repeat("c", 65), "/acme.v1.UserService/GetUser")
	_ = shutdown(b)
	_, reasons := drops.snapshot()
	if len(srv.events()) != 0 || len(reasons) != 1 || reasons[0] != DropInvalid {
		t.Errorf("events=%d reasons=%v, want 0 events and one %q drop", len(srv.events()), reasons, DropInvalid)
	}
}

// A method handed to Record still originates from the incoming RPC, so it is
// truncated and sent like one the interceptors read.
func TestRecordOverLongMethodIsTruncatedAndSent(t *testing.T) {
	logs := captureLog(t)
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 100 })
	ctx := metadata.NewIncomingContext(context.Background(), metadata.Pairs("x-customer-id", "cust_1"))
	method := strings.Repeat("m", 400)
	b.Record(ctx, method, "UNARY", 1, nil, 3)
	b.Record(ctx, method+"x", "UNARY", 1, nil, 3)
	_ = shutdown(b)

	evs := srv.events()
	if len(evs) != 2 || b.DroppedCount() != 0 {
		t.Fatalf("server saw %d events, dropped %d; want 2 / 0", len(evs), b.DroppedCount())
	}
	for i, full := range []string{method, method + "x"} {
		if got := evs[i]["grpcMethod"].(string); got != method[:128] {
			t.Errorf("event %d grpcMethod is %d units, want exactly 128", i, utf16Len(got))
		}
		service := evs[i]["grpcService"].(string)
		if key := evs[i]["idempotencyKey"].(string); !strings.HasPrefix(key, "grpc:tenant-001:"+service+":"+sha256Hex(full)+":") {
			t.Errorf("key %d not derived from the untruncated method: %q", i, key)
		}
	}
	if n := strings.Count(logs.String(), "grpcMethod taken from the request"); n != 1 {
		t.Errorf("truncation WARN logged %d times across 2 events, want 1", n)
	}
}

// Config.ServiceName is configuration, not a request label: never shortened.
func TestOverLongServiceNameStillDropped(t *testing.T) {
	logs := captureLog(t)
	srv := &scriptedServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	drops := &dropSink{}
	b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) {
		c.FlushCount = 100
		c.OnDrop = drops.hook
		c.ServiceName = strings.Repeat("s", 256)
	})
	callUnary(t, b, "cust_1", "/svc/GetUser")
	_ = shutdown(b)

	_, reasons := drops.snapshot()
	if len(srv.events()) != 0 || len(reasons) != 1 || reasons[0] != DropInvalid {
		t.Errorf("events=%d reasons=%v, want 0 events and one %q drop", len(srv.events()), reasons, DropInvalid)
	}
	if strings.Contains(logs.String(), "truncated to") {
		t.Errorf("a config value was reported as truncated")
	}
}
