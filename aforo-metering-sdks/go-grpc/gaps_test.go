package grpcmetering

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

func emitOneEvent(b *Billing) { b.Record(context.Background(), "Get", "UNARY", 1, nil, 1) }

func baseConfig(url string) Config {
	return Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: url, ServiceName: "acme.v1.Svc",
		FlushInterval: time.Hour, ShutdownTimeout: 100 * time.Millisecond, hooks: fastHooks()}
}

// G265: no resolver and no explicit trust → configuration error.
func TestNew_RequiresResolverOrExplicitTrust(t *testing.T) {
	if _, err := New(baseConfig("https://api.example.com")); !errors.Is(err, ErrNoCustomerResolver) {
		t.Fatalf("err = %v, want ErrNoCustomerResolver", err)
	}
}

// G265: the resolver wins; caller-supplied metadata is ignored.
func TestResolverIgnoresCallerMetadata(t *testing.T) {
	r := &recorder{status: 202}
	srv := httptest.NewServer(r)
	defer srv.Close()
	cfg := baseConfig(srv.URL)
	cfg.CustomerResolver = func(context.Context) string { return "cust_from_auth" }
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx := metadata.NewIncomingContext(context.Background(), metadata.Pairs("x-customer-id", "attacker"))
	b.Record(ctx, "Get", "UNARY", 1, nil, 1)
	_ = b.Shutdown(bg)
	got := r.got()
	if len(got) != 1 {
		t.Fatalf("requests = %d", len(got))
	}
	ev := got[0].body["events"].([]any)[0].(map[string]any)
	if ev["customerId"] != "cust_from_auth" {
		t.Fatalf("customerId = %v, want the resolver's value", ev["customerId"])
	}
}

// A resolver that returns nothing: not billed, counted as invalid.
func TestBlankResolvedCustomerIsCounted(t *testing.T) {
	d := &mockDrops{}
	cfg := baseConfig("http://127.0.0.1:1")
	cfg.CustomerResolver = func(context.Context) string { return "" }
	cfg.OnDrop = d.hook
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown(bg)
	emitOneEvent(b)
	if _, reasons := d.snapshot(); len(reasons) != 1 || reasons[0] != DropInvalid || b.BufferedCount() != 0 {
		t.Fatalf("reasons=%v buffered=%d", reasons, b.BufferedCount())
	}
}

// streamFake delivers three client messages, then io.EOF.
type streamFake struct {
	grpc.ServerStream
	ctx  context.Context
	left int
}

func (f *streamFake) Context() context.Context { return f.ctx }
func (f *streamFake) RecvMsg(any) error {
	if f.left == 0 {
		return io.EOF
	}
	f.left--
	return nil
}
func (f *streamFake) SendMsg(any) error { return nil }

// G280: a stream reports the messages it really carried.
func TestStreamRecordsRealMessageCount(t *testing.T) {
	r := &recorder{status: 202}
	srv := httptest.NewServer(r)
	defer srv.Close()
	cfg := baseConfig(srv.URL)
	cfg.CustomerResolver = func(context.Context) string { return "cust_1" }
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	_ = b.StreamInterceptor()(nil, &streamFake{ctx: context.Background(), left: 3},
		&grpc.StreamServerInfo{FullMethod: "/acme.v1.Svc/Chat", IsClientStream: true, IsServerStream: true},
		func(_ any, ss grpc.ServerStream) error {
			for ss.RecvMsg(nil) == nil {
				_ = ss.SendMsg(nil)
			}
			return ss.SendMsg(nil) // one closing summary
		})
	_ = b.Shutdown(bg)
	ev := r.got()[0].body["events"].([]any)[0].(map[string]any)
	meta := ev["metadata"].(map[string]any)
	if ev["messageCount"] != float64(7) || meta["messagesReceived"] != float64(3) || meta["messagesSent"] != float64(4) {
		t.Fatalf("messageCount=%v received=%v sent=%v, want 7 / 3 / 4", ev["messageCount"], meta["messagesReceived"], meta["messagesSent"])
	}
}

// G276: recording over the threshold starts no goroutine.
func TestRecord_StartsNoGoroutines(t *testing.T) {
	gate := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-gate; w.WriteHeader(202) }))
	defer srv.Close()
	defer close(gate)
	cfg := baseConfig(srv.URL)
	cfg.FlushCount = 1
	cfg.CustomerResolver = func(context.Context) string { return "c" }
	b, err := New(cfg)
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

// G270: https is enforced and the API key is never printed.
func TestHTTPSAndKeyRedaction(t *testing.T) {
	cfg := baseConfig("http://api.example.com")
	cfg.TrustCustomerHeader = true
	if _, err := New(cfg); err == nil {
		t.Fatal("plain http to a remote host accepted")
	}
	cfg = baseConfig("https://api.example.com")
	cfg.TrustCustomerHeader = true
	cfg.APIKey = "sk_live_secret"
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
