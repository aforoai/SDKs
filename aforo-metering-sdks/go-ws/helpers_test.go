package wsmetering

import (
	"context"
	"time"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go-ws/v2/internal/ingest"
)

// fastHooks keep retries off the wall clock: Sleep returns at once (or with
// the context's error), the flush-interval timer never fires (tests flush
// explicitly or reach the threshold) and the jitter source is fixed.
func fastHooks() ingest.Hooks {
	return ingest.Hooks{
		Sleep: func(ctx context.Context, _ time.Duration) error { return ctx.Err() },
		After: func(time.Duration) (<-chan time.Time, func() bool) {
			return make(chan time.Time), func() bool { return true }
		},
		Rand: func() float64 { return 0 },
	}
}

// bg is the context tests pass to Shutdown and Flush.
var bg = context.Background()
