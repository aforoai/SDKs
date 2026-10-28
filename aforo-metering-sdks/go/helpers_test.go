package metering

import (
	"context"
	"testing"
	"time"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go/v2/internal/ingest"
)

// fastHooks keep retries off the wall clock: Sleep returns at once (or with
// the context's error), the flush-interval timer never fires (tests flush
// explicitly) and the jitter source is fixed.
func fastHooks() ingest.Hooks {
	return ingest.Hooks{
		Sleep: func(ctx context.Context, _ time.Duration) error { return ctx.Err() },
		After: func(time.Duration) (<-chan time.Time, func() bool) {
			return make(chan time.Time), func() bool { return true }
		},
		Rand: func() float64 { return 0 },
	}
}

// mustNewClient builds a client with fast hooks and closes it when the test ends.
func mustNewClient(t *testing.T, opts Options) *AforoClient {
	t.Helper()
	if opts.hooks.Sleep == nil {
		opts.hooks = fastHooks()
	}
	c, err := NewClient(opts)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() { closeNow(c) })
	return c
}

func flushNow(c *AforoClient) FlushResult {
	r, _ := c.Flush(context.Background())
	return r
}

// closeNow closes with a short deadline: shutdown keeps retrying an
// unreachable ingestor until its deadline, and tests point at dead ports.
func closeNow(c *AforoClient) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_ = c.Close(ctx)
}
