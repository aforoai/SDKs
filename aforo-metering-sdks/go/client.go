package metering

import (
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// AforoClient is the main entry point for the Aforo metering SDK.
//
// Enqueues events into a thread-safe ring buffer and flushes them
// in batches via a background goroutine.
//
//	client := metering.NewClient(metering.Options{APIKey: "your-key"})
//	defer client.Close()
//	client.Track(metering.TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
type AforoClient struct {
	buf         *ringBuffer
	tp          *transport
	flushCount  int
	productType string
	ticker      *time.Ticker
	done        chan struct{}
	closed      bool
	mu          sync.Mutex

	onDrop func(events []TrackEvent, reason DropReason)

	// Drop accounting — events permanently lost (overflow eviction, failed
	// batch, per-event server rejection, or client-side validation).
	dropped       atomic.Int64
	overflowDrops atomic.Int64
	invalidDrops  atomic.Int64
}

// NewClient creates a new AforoClient with the given options.
func NewClient(opts Options) *AforoClient {
	opts.defaults()

	c := &AforoClient{
		buf:         newRingBuffer(opts.MaxQueueSize),
		tp:          newTransport(opts.BaseURL, opts.APIKey, opts.Timeout, opts.MaxRetries, opts.RetryBase),
		flushCount:  opts.FlushCount,
		productType: opts.ProductType,
		ticker:      time.NewTicker(opts.FlushInterval),
		done:        make(chan struct{}),
		onDrop:      opts.OnDrop,
	}

	// Background flush goroutine
	go c.flushLoop()

	return c
}

// Track enqueues a usage event for batched delivery.
// Non-blocking — returns immediately.
func (c *AforoClient) Track(event TrackEvent) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClientClosed
	}
	c.mu.Unlock()

	// Minted once, here, when the event is enqueued — never at flush/retry time,
	// so a retried batch carries the same keys and the ingestor deduplicates it.
	// A caller-supplied key is passed through verbatim; otherwise each event gets
	// its own random UUID. (A content hash would make two distinct events that
	// share a timestamp collide, and the ingestor would drop the second one.)
	// Callers wanting logical retry-dedup supply their own stable key.
	// Minted before validation so an event handed to OnDrop with reason
	// DropInvalid still carries its key.
	if event.IdempotencyKey == "" {
		event.IdempotencyKey = generateRandomKey()
	}

	// Events the ingestor would refuse are dropped server-side and never
	// billed, and because flushing happens in the background nobody would see
	// that rejection. Such an event never enters the buffer: it is counted,
	// WARN-logged, handed to OnDrop (DropInvalid) and reported to the caller.
	if err := c.validate(&event); err != nil {
		c.recordInvalid(event, err)
		return err
	}

	productType := normalizeProductType(event.ProductType)
	if productType == "" {
		productType = c.productType
	}

	resolved := resolvedEvent{
		CustomerID:      event.CustomerID,
		MetricName:      event.MetricName,
		Quantity:        event.Quantity,
		IdempotencyKey:  event.IdempotencyKey,
		OccurredAt:      event.OccurredAt,
		ProductType:     productType,
		Metadata:        event.Metadata,
		ExecutionStatus: normalizeExecutionStatus(event.ExecutionStatus),
		EndpointPath:    event.EndpointPath,
		HTTPMethod:      event.HTTPMethod,
		StatusCode:      event.StatusCode,
		ResponseTimeMs:  event.ResponseTimeMs,
	}

	if evicted, overflow := c.buf.pushEvict(resolved); overflow {
		c.recordDrop([]resolvedEvent{evicted}, DropOverflow)
	}

	if c.buf.size() >= c.flushCount {
		go c.Flush()
	}

	return nil
}

// validate normalizes Quantity / OccurredAt in place and reports the first
// ingestor constraint the event breaks (wrapped ErrInvalidEvent).
func (c *AforoClient) validate(event *TrackEvent) error {
	if strings.TrimSpace(event.CustomerID) == "" {
		return fmt.Errorf("%w: CustomerID is required", ErrInvalidEvent)
	}
	if strings.TrimSpace(event.MetricName) == "" {
		return fmt.Errorf("%w: MetricName is required", ErrInvalidEvent)
	}
	if event.Quantity < 0 || math.IsNaN(event.Quantity) || math.IsInf(event.Quantity, 0) {
		return fmt.Errorf("%w: Quantity must be > 0, got %v", ErrInvalidEvent, event.Quantity)
	}
	// Zero is Go's "unset" value: default to 1.
	if event.Quantity == 0 {
		event.Quantity = 1
	}
	if event.OccurredAt == "" {
		event.OccurredAt = time.Now().UTC().Format(time.RFC3339Nano)
	} else {
		ts, err := time.Parse(time.RFC3339Nano, event.OccurredAt)
		if err != nil {
			return fmt.Errorf("%w: OccurredAt must be an RFC 3339 timestamp, got %q", ErrInvalidEvent, truncateForLog(event.OccurredAt))
		}
		event.OccurredAt = ts.UTC().Format(time.RFC3339Nano)
	}
	return checkFieldLimits(event)
}

// recordInvalid accounts for an event refused client-side: counter, throttled
// WARN (first, then every 1000th, so a tight loop can't storm the log) and the
// opt-in OnDrop hook with DropInvalid.
func (c *AforoClient) recordInvalid(event TrackEvent, cause error) {
	total := c.dropped.Add(1)
	if n := c.invalidDrops.Add(1); n == 1 || n%1000 == 0 {
		log.Printf("[aforo] WARN: invalid event dropped, not sent — %v (%d invalid, %d total dropped).", cause, n, total)
	}
	c.callOnDrop([]TrackEvent{event}, DropInvalid)
}

// callOnDrop invokes the opt-in hook. A hook bug must never break
// tracking/flushing.
func (c *AforoClient) callOnDrop(events []TrackEvent, reason DropReason) {
	if c.onDrop == nil || len(events) == 0 {
		return
	}
	defer func() { _ = recover() }()
	c.onDrop(events, reason)
}

// recordDrop accounts for permanently lost events: bumps the counter,
// WARN-logs, and invokes the opt-in OnDrop hook. Overflow logs are throttled
// (first, then every 1000th eviction) so sustained overflow can't storm the
// log; failed-batch drops log every time (bounded by flush cadence).
func (c *AforoClient) recordDrop(events []resolvedEvent, reason DropReason) {
	total := c.dropped.Add(int64(len(events)))

	if reason == DropOverflow {
		overflows := c.overflowDrops.Add(int64(len(events)))
		if overflows == 1 || overflows%1000 == 0 {
			log.Printf("[aforo] WARN: buffer overflow: oldest event dropped (%d total dropped). Consider raising MaxQueueSize or checking ingest connectivity.", total)
		}
	} else {
		log.Printf("[aforo] WARN: dropped %d event(s) — %s (%d total dropped).", len(events), reason, total)
	}

	if c.onDrop != nil {
		dropped := make([]TrackEvent, len(events))
		for i, e := range events {
			dropped[i] = e.asTrackEvent()
		}
		c.callOnDrop(dropped, reason)
	}
}

// Flush sends all buffered events to the ingestor.
func (c *AforoClient) Flush() FlushResult {
	var totalSent, totalFailed int

	for !c.buf.isEmpty() {
		batch := c.buf.drainUpTo(c.flushCount)
		if len(batch) == 0 {
			break
		}
		result := c.tp.send(batch)
		totalSent += result.Sent
		totalFailed += result.Failed

		if result.Failed > 0 {
			// The batch was already drained from the buffer — without this it
			// vanishes silently. Surface it (counter + WARN + opt-in hook).
			reason := result.Reason
			if reason == "" {
				reason = DropRetryExhausted
			}
			switch {
			case result.Failed >= len(batch):
				c.recordDrop(batch, reason)
			case len(result.failedIndexes) > 0:
				// 2xx partial failure: the ingestor named the events it refused.
				rejected := make([]resolvedEvent, 0, len(result.failedIndexes))
				for _, i := range result.failedIndexes {
					rejected = append(rejected, batch[i])
				}
				c.recordDrop(rejected, reason)
				if extra := result.Failed - len(rejected); extra > 0 {
					c.recordUnidentifiedDrop(extra, reason)
				}
			default:
				// Partial failure without usable indexes: count, but do not
				// guess which events were refused.
				c.recordUnidentifiedDrop(result.Failed, reason)
			}
		}
	}

	return FlushResult{Sent: totalSent, Failed: totalFailed}
}

// recordUnidentifiedDrop counts events the ingestor refused without saying
// which ones; OnDrop is not called because the SDK cannot name them.
func (c *AforoClient) recordUnidentifiedDrop(n int, reason DropReason) {
	total := c.dropped.Add(int64(n))
	log.Printf("[aforo] WARN: dropped %d event(s) — %s; the ingestor did not identify them (%d total dropped).", n, reason, total)
}

// Close flushes remaining events and stops the background goroutine.
func (c *AforoClient) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.mu.Unlock()

	c.ticker.Stop()
	close(c.done)
	c.Flush()
	c.tp.close()
}

// BufferedCount returns the number of events in the buffer.
func (c *AforoClient) BufferedCount() int {
	return c.buf.size()
}

// DroppedCount returns the total events permanently dropped (overflow +
// failed batches + rejected + invalid events) since the client was created.
func (c *AforoClient) DroppedCount() int64 {
	return c.dropped.Load()
}

// IsClosed returns whether the client has been closed.
func (c *AforoClient) IsClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (c *AforoClient) flushLoop() {
	for {
		select {
		case <-c.ticker.C:
			c.Flush()
		case <-c.done:
			return
		}
	}
}

// ErrInvalidEvent is returned (wrapped) by Track when an event is missing a
// field the ingestor requires or breaks one of its field limits. The event is
// not buffered or sent; it is counted in DroppedCount(), WARN-logged and
// handed to Options.OnDrop with DropInvalid.
var ErrInvalidEvent = errors.New("aforo: invalid event")

// ErrClientClosed is returned when Track is called on a closed client.
var ErrClientClosed = &clientClosedError{}

type clientClosedError struct{}

func (e *clientClosedError) Error() string {
	return "aforo: client is closed"
}
