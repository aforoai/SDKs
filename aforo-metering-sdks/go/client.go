package metering

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go/v2/internal/ingest"
)

// sdkVersion is sent in the User-Agent header; keep it equal to VERSION.
const sdkVersion = "2.0.0"

// AforoClient is the main entry point for the Aforo metering SDK.
//
// Track appends to a bounded queue; one background goroutine sends batches.
// Create one client per process and close it on shutdown:
//
//	client, err := metering.NewClient(metering.Options{APIKey: os.Getenv("AFORO_API_KEY")})
//	if err != nil { log.Fatal(err) }
//	defer client.Close(context.Background())
//	client.Track(metering.TrackEvent{CustomerID: "cust_1", MetricName: "api_calls"})
type AforoClient struct {
	tp          *ingest.Client
	productType string
}

// NewClient validates opts and starts the background sender. It returns an
// error when APIKey is blank or BaseURL is not https (http is allowed for
// localhost, 127.0.0.1 and ::1, or with AllowInsecureHTTP).
func NewClient(opts Options) (*AforoClient, error) {
	opts.defaults()
	onDrop := opts.OnDrop
	cfg := ingest.Config{
		BaseURL:           opts.BaseURL,
		APIKey:            opts.APIKey,
		UserAgent:         "aforo-go/" + sdkVersion,
		AllowInsecureHTTP: opts.AllowInsecureHTTP,
		HTTPClient:        opts.HTTPClient,
		Timeout:           opts.Timeout,
		FlushCount:        opts.FlushCount,
		FlushInterval:     opts.FlushInterval,
		MaxQueueSize:      opts.MaxQueueSize,
		MaxRetries:        opts.MaxRetries,
		RetryBase:         opts.RetryBase,
		ShutdownTimeout:   opts.ShutdownTimeout,
		LogPrefix:         "[aforo]",
		Hooks:             opts.hooks,
	}
	if onDrop != nil {
		cfg.OnDrop = func(events []ingest.Event, reason ingest.DropReason) {
			onDrop(trackEvents(events), DropReason(reason))
		}
	}
	if onError := opts.OnError; onError != nil {
		cfg.OnError = func(e *ingest.TransportError) {
			onError(&TransportError{Kind: e.Kind, Status: e.Status, Message: e.Message, Events: trackEvents(e.Events)})
		}
	}
	if onAccepted := opts.OnAccepted; onAccepted != nil {
		cfg.OnAccepted = func(body json.RawMessage, events []ingest.Event) {
			onAccepted(body, trackEvents(events))
		}
	}
	tp, err := ingest.New(cfg)
	if err != nil {
		return nil, err
	}
	return &AforoClient{tp: tp, productType: opts.ProductType}, nil
}

// trackEvents hands callbacks the events as tracked (keys kept).
func trackEvents(events []ingest.Event) []TrackEvent {
	out := make([]TrackEvent, len(events))
	for i, e := range events {
		if te, ok := e.Ref.(TrackEvent); ok {
			out[i] = te
		} else {
			out[i] = TrackEvent{IdempotencyKey: e.Key}
		}
	}
	return out
}

// String never prints the API key.
func (c *AforoClient) String() string { return "metering.AforoClient{" + c.tp.String() + "}" }

// Track enqueues a usage event for batched delivery. It never blocks on the
// network and never starts a goroutine.
//
// It returns ErrInvalidEvent (wrapped) for an event the ingestor would refuse
// and ErrClientClosed after Close; both are counted in DroppedCount() and
// handed to OnDrop (DropInvalid / DropClosed).
func (c *AforoClient) Track(event TrackEvent) error {
	// Minted once, here, when the event is enqueued — never at flush/retry time,
	// so a retried batch carries the same keys and the ingestor deduplicates it.
	// A caller-supplied key is passed through verbatim; otherwise each event gets
	// its own random UUID. Minted before validation so an event handed to OnDrop
	// still carries its key.
	if event.IdempotencyKey == "" {
		event.IdempotencyKey = generateRandomKey()
	}
	if c.tp.Closed() {
		c.tp.Report([]ingest.Event{{Key: event.IdempotencyKey, Ref: event}}, ingest.DropClosed)
		return ErrClientClosed
	}

	if err := c.validate(&event); err != nil {
		c.tp.ReportInvalid(ingest.Event{Key: event.IdempotencyKey, Ref: event}, err.Error())
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
	body, err := json.Marshal(resolved)
	if err != nil {
		cause := fmt.Errorf("%w: event cannot be serialized: %v", ErrInvalidEvent, err)
		c.tp.ReportInvalid(ingest.Event{Key: event.IdempotencyKey, Ref: event}, cause.Error())
		return cause
	}
	if err := c.tp.Enqueue(ingest.Event{Key: resolved.IdempotencyKey, Body: body, Ref: resolved.asTrackEvent()}); err != nil {
		return ErrClientClosed
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

// Flush hands the queued events to the background sender and waits until it
// has tried to send them all, or ctx ends. During an ingest outage it returns
// ErrIngestUnavailable; the events stay queued and are sent on recovery.
func (c *AforoClient) Flush(ctx context.Context) (FlushResult, error) {
	r, err := c.tp.Flush(ctx)
	res := FlushResult{Sent: r.Sent, Rejected: r.Rejected, Pending: r.Pending}
	switch {
	case errors.Is(err, ingest.ErrClosed):
		return res, ErrClientClosed
	case errors.Is(err, ingest.ErrIngestUnavailable):
		return res, ErrIngestUnavailable
	}
	return res, err
}

// Close stops accepting events and sends what is queued until the earlier of
// ctx's deadline and Options.ShutdownTimeout. Events still queued then are
// reported through OnDrop with DropShutdown and Close returns an error
// wrapping ErrShutdownIncomplete. Safe to call more than once.
func (c *AforoClient) Close(ctx context.Context) error {
	err := c.tp.Close(ctx)
	if errors.Is(err, ingest.ErrShutdownIncomplete) {
		return fmt.Errorf("%w: %v", ErrShutdownIncomplete, err)
	}
	return err
}

// BufferedCount returns the number of queued events.
func (c *AforoClient) BufferedCount() int { return c.tp.Len() }

// DroppedCount returns the total events the SDK gave up on since the client
// was created (every DropReason).
func (c *AforoClient) DroppedCount() int64 { return c.tp.Dropped() }

// IsClosed returns whether the client has been closed.
func (c *AforoClient) IsClosed() bool { return c.tp.Closed() }

// ErrInvalidEvent is returned (wrapped) by Track when an event is missing a
// field the ingestor requires or breaks one of its field limits. The event is
// not queued or sent; it is counted in DroppedCount(), WARN-logged and
// handed to Options.OnDrop with DropInvalid.
var ErrInvalidEvent = errors.New("aforo: invalid event")

// ErrIngestUnavailable is returned by Flush when the ingestor could not be
// reached (or refused the API key) after the retries. Nothing is lost: the
// events stay queued and are sent when it recovers.
var ErrIngestUnavailable = errors.New("aforo: ingestor unavailable; events kept in the queue")

// ErrShutdownIncomplete is returned (wrapped) by Close when events were still
// queued at the shutdown deadline.
var ErrShutdownIncomplete = errors.New("aforo: shutdown deadline passed with events still queued")

// ErrClientClosed is returned when Track or Flush is called on a closed client.
var ErrClientClosed = &clientClosedError{}

type clientClosedError struct{}

func (e *clientClosedError) Error() string {
	return "aforo: client is closed"
}
