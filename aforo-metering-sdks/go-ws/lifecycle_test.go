package wsmetering

import (
	"context"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// A negative ConnectionIdleTimeout would switch the idle sweep off and let
// the connection map grow without bound, so New refuses it.
func TestNegativeConnectionIdleTimeoutRefused(t *testing.T) {
	_, err := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://127.0.0.1:1",
		ConnectionIdleTimeout: -time.Second})
	if err == nil {
		t.Fatal("New accepted a negative ConnectionIdleTimeout")
	}
}

// An Open racing Shutdown is either tracked and closed by Shutdown (OPEN and
// CLOSE both sent) or refused as closed (neither sent): never an OPEN
// without its CLOSE.
func TestOpenRacingShutdownNeverLeavesOpenWithoutClose(t *testing.T) {
	for iter := 0; iter < 200; iter++ {
		srv := &scriptedServer{}
		ts := httptest.NewServer(srv)
		b := newContractBilling(t, ts.URL, &errSink{}, func(c *Config) { c.FlushCount = 1000 })
		var wg sync.WaitGroup
		start := make(chan struct{})
		for g := 0; g < 8; g++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				for i := 0; i < 20; i++ {
					b.Open("cust_1", nil)
				}
			}()
		}
		close(start)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = b.Shutdown(ctx)
		cancel()
		wg.Wait()
		opened, closed := map[string]bool{}, map[string]bool{}
		for _, e := range srv.events() {
			id, _ := e["wsConnectionId"].(string)
			switch e["wsFrameType"] {
			case "OPEN":
				opened[id] = true
			case "CLOSE":
				closed[id] = true
			}
		}
		for id := range opened {
			if !closed[id] {
				ts.Close()
				t.Fatalf("iteration %d: connection %s was billed OPEN but never CLOSE", iter, id)
			}
		}
		if n := b.OpenConnections(); n != 0 {
			ts.Close()
			t.Fatalf("iteration %d: %d connection(s) still tracked after Shutdown", iter, n)
		}
		ts.Close()
	}
}
