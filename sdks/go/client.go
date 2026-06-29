package metering

import (
	"sync"
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
	buf        *ringBuffer
	tp         *transport
	flushCount int
	ticker     *time.Ticker
	done       chan struct{}
	closed     bool
	mu         sync.Mutex
}

// NewClient creates a new AforoClient with the given options.
func NewClient(opts Options) *AforoClient {
	opts.defaults()

	c := &AforoClient{
		buf:        newRingBuffer(opts.MaxQueueSize),
		tp:         newTransport(opts.BaseURL, opts.APIKey, opts.Timeout, opts.MaxRetries, opts.RetryBase),
		flushCount: opts.FlushCount,
		ticker:     time.NewTicker(opts.FlushInterval),
		done:       make(chan struct{}),
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

	if event.Quantity == 0 {
		event.Quantity = 1
	}
	if event.OccurredAt == "" {
		event.OccurredAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if event.IdempotencyKey == "" {
		event.IdempotencyKey = generateIdempotencyKey(
			event.CustomerID, event.MetricName, event.Quantity, event.OccurredAt)
	}

	resolved := resolvedEvent{
		CustomerID:     event.CustomerID,
		MetricName:     event.MetricName,
		Quantity:       event.Quantity,
		IdempotencyKey: event.IdempotencyKey,
		OccurredAt:     event.OccurredAt,
		Metadata:       event.Metadata,
	}

	c.buf.push(resolved)

	if c.buf.size() >= c.flushCount {
		go c.Flush()
	}

	return nil
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
	}

	return FlushResult{Sent: totalSent, Failed: totalFailed}
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

// ErrClientClosed is returned when Track is called on a closed client.
var ErrClientClosed = &clientClosedError{}

type clientClosedError struct{}

func (e *clientClosedError) Error() string {
	return "aforo: client is closed"
}
