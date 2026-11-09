package grpcmetering

// Regression tests for the 2026-11-09 SDK review (#5, R3, R7).

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"google.golang.org/grpc"
)

func TestBillingGoStringHidesKey(t *testing.T) {
	b, err := New(Config{TenantID: "t", ProductID: "p", APIKey: "sk_live_SECRET", IngestorURL: "http://localhost:1", ServiceName: "s",
		CustomerResolver: func(context.Context) string { return "c" }, hooks: fastHooks()})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown(bg)
	for _, f := range []string{"%v", "%+v", "%#v"} {
		if s := fmt.Sprintf(f, b); strings.Contains(s, "SECRET") {
			t.Errorf("%s shows the key", f)
		}
	}
}

// grpc-go does not recover interceptor panics; a panicking resolver must
// drop the event as invalid, not take the process down.
func TestPanickingResolverDropsTheEventAsInvalid(t *testing.T) {
	var mu sync.Mutex
	var reasons []DropReason
	b, _ := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://localhost:1", ServiceName: "s", hooks: fastHooks(),
		CustomerResolver: func(context.Context) string { panic("token cache down") },
		OnDrop:           func(ev []map[string]any, r DropReason) { mu.Lock(); reasons = append(reasons, r); mu.Unlock() }})
	defer b.Shutdown(bg)
	resp, err := b.UnaryInterceptor()(context.Background(), "req", &grpc.UnaryServerInfo{FullMethod: "/s/Get"},
		func(ctx context.Context, req any) (any, error) { return "ok", nil })
	if resp != "ok" || err != nil {
		t.Fatalf("RPC result changed: %v %v", resp, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if b.DroppedCount() != 1 || len(reasons) != 1 || reasons[0] != DropInvalid {
		t.Fatalf("dropped=%d reasons=%v", b.DroppedCount(), reasons)
	}
}

func TestLongStreamDurationIsLeftOff(t *testing.T) {
	b, _ := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://localhost:1", ServiceName: "s", hooks: fastHooks(),
		CustomerResolver: func(context.Context) string { return "c" }})
	defer b.Shutdown(bg)
	b.Record(context.Background(), "Watch", "SERVER_STREAM", 3, nil, 25*24*3600*1000)
	if b.BufferedCount() != 1 {
		t.Fatal("event not queued")
	}
}
