package graphqlmetering

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql/v2/internal/ingest"
)

// ── Ingest contract helpers ──
//
// Sending (queue, batching, retries, breaker, shutdown) lives in
// internal/ingest, a byte-identical copy of the Go core's transport
// (scripts/sync-transport.sh). This file adapts it to this package.

const (
	// DefaultProductType is stamped on every event as the top-level
	// productType unless Config.ProductType or a per-event EventOptions
	// overrides it.
	DefaultProductType = "GRAPHQL_API"

	// Field limits mirror the ingestor's IngestUsageEventRequest @Size
	// constraints. The SDK never truncates an id: an over-limit event is
	// dropped with DropInvalid instead.
	maxCustomerIDLen  = 64
	maxProductTypeLen = 20
)

// DropReason describes why the SDK gave up on an event.
type DropReason string

const (
	// DropOverflow — the queue (Config.MaxQueueSize) was full; the oldest
	// event was evicted.
	DropOverflow DropReason = "overflow"
	// DropRejected — the ingestor refused the event: a non-retryable 4xx, a
	// single event still too large after 413 splitting, or errors[] with
	// retryable=false in a 2xx answer.
	DropRejected DropReason = "rejected"
	// DropInvalid — the event failed client-side validation (a required field
	// was blank — including a blank customer id — or a field exceeded the
	// ingestor's limit) and was never queued.
	DropInvalid DropReason = "invalid"
	// DropShutdown — still queued when Shutdown's deadline passed.
	DropShutdown DropReason = "shutdown"
	// DropClosed — recorded after Shutdown.
	DropClosed DropReason = "closed"
	// DropRetryExhausted is kept for API compatibility. Since v2 a batch that
	// keeps failing goes back to the queue (the ingestor deduplicates on the
	// idempotency key), so the transport does not report it.
	DropRetryExhausted DropReason = "retry_exhausted"
)

// ErrIngestUnavailable is returned by Flush when the ingestor could not be
// reached (or refused the API key) after the retries; the events stay queued.
var ErrIngestUnavailable = ingest.ErrIngestUnavailable

// ErrShutdownIncomplete is returned (wrapped) by Shutdown when events were
// still queued at the deadline; they were reported with DropShutdown.
var ErrShutdownIncomplete = ingest.ErrShutdownIncomplete

// ErrClosed is returned by Flush after Shutdown.
var ErrClosed = ingest.ErrClosed

// ErrorKind classifies a *TransportError.
type ErrorKind = ingest.ErrorKind

const (
	KindOutage   = ingest.KindOutage   // ingestor unreachable, 5xx/408/429 after retries, or a redirect; events kept queued
	KindAuth     = ingest.KindAuth     // 401/403: API key wrong or revoked; events kept queued
	KindRejected = ingest.KindRejected // the ingestor refused events; they went to OnDrop as rejected
	KindShutdown = ingest.KindShutdown // still queued at the shutdown deadline
	KindClosed   = ingest.KindClosed   // recorded after Shutdown
)

// TransportError is what OnError receives for a sending problem. Branch on
// Kind, never on Message. Events are the events concerned (requeued for
// outage/auth, dropped otherwise). errors.Is matches ErrIngestUnavailable
// (outage, auth), ErrShutdownIncomplete and ErrClosed.
type TransportError struct {
	Kind    ErrorKind
	Status  int // HTTP status that caused it, 0 for a network error
	Message string
	Events  []map[string]any
	err     *ingest.TransportError
}

func (e *TransportError) Error() string { return e.Message }

// Unwrap exposes the sentinel error for the kind.
func (e *TransportError) Unwrap() error { return e.err }

func newTransportError(e *ingest.TransportError) *TransportError {
	return &TransportError{Kind: e.Kind, Status: e.Status, Message: e.Message, Events: eventMaps(e.Events), err: e}
}

// eventMaps hands callbacks the events as queued (keys kept).
func eventMaps(events []ingest.Event) []map[string]any {
	out := make([]map[string]any, len(events))
	for i, e := range events {
		if m, ok := e.Ref.(map[string]any); ok {
			out[i] = m
		} else {
			out[i] = map[string]any{"idempotencyKey": e.Key}
		}
	}
	return out
}

// String never prints the API key.
func (c Config) String() string {
	return fmt.Sprintf("graphqlmetering.Config{TenantID:%q, ProductID:%q, APIKey:%s, IngestorURL:%q}",
		c.TenantID, c.ProductID, ingest.RedactKey(c.APIKey), c.IngestorURL)
}

// GoString never prints the API key.
func (c Config) GoString() string { return c.String() }

// String never prints the API key.
func (b *Billing) String() string { return "graphqlmetering.Billing{" + b.cfg.String() + "}" }

// newTransport builds the transport core from Config. It enforces https
// (http only for localhost, 127.0.0.1, ::1 or with AllowInsecureHTTP).
func newTransport(cfg Config) (*ingest.Client, error) {
	onDrop := cfg.OnDrop
	tc := ingest.Config{
		BaseURL:           cfg.IngestorURL,
		APIKey:            cfg.APIKey,
		UserAgent:         "aforo-go-graphql/" + sdkVersion,
		Headers:           map[string]string{"X-Tenant-Id": cfg.TenantID},
		AllowInsecureHTTP: cfg.AllowInsecureHTTP,
		Compression:       cfg.Compression,
		HTTPClient:        cfg.HTTPClient,
		Timeout:           cfg.Timeout,
		FlushCount:        cfg.FlushCount,
		FlushInterval:     cfg.FlushInterval,
		MaxQueueSize:      cfg.MaxQueueSize,
		MaxRetries:        cfg.MaxRetries,
		RetryBase:         cfg.RetryBase,
		ShutdownTimeout:   cfg.ShutdownTimeout,
		OnError: func(e *ingest.TransportError) {
			if cfg.OnError != nil {
				cfg.OnError(newTransportError(e))
			}
		},
		LogPrefix: "[graphqlmetering]",
		Hooks:     cfg.hooks,
	}
	if onDrop != nil {
		tc.OnDrop = func(events []ingest.Event, reason ingest.DropReason) {
			onDrop(eventMaps(events), DropReason(reason))
		}
	}
	if onAccepted := cfg.OnAccepted; onAccepted != nil {
		tc.OnAccepted = func(body json.RawMessage, events []ingest.Event) {
			onAccepted(body, eventMaps(events))
		}
	}
	return ingest.New(tc)
}

// push queues a resolved event. It never blocks on the network and never
// starts a goroutine; after Shutdown the event is reported as DropClosed.
func (b *Billing) push(event map[string]any) {
	if event == nil {
		return
	}
	key, _ := event["idempotencyKey"].(string)
	body, err := json.Marshal(event)
	if err != nil {
		b.dropInvalid(event, "event cannot be serialized: "+err.Error())
		return
	}
	_ = b.tp.Enqueue(ingest.Event{Key: key, Body: body, Ref: event})
}

// Flush sends everything queued and waits, or until ctx ends. During an
// ingest outage it returns ErrIngestUnavailable; nothing is lost.
func (b *Billing) Flush(ctx context.Context) error {
	_, err := b.tp.Flush(ctx)
	return err
}

// BufferedCount returns the number of queued events.
func (b *Billing) BufferedCount() int { return b.tp.Len() }

// shutdownTransport closes the transport: it sends what is queued until the
// earlier of ctx's deadline and Config.ShutdownTimeout, then reports the
// rest as DropShutdown. Safe to call more than once.
func (b *Billing) shutdownTransport(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	return b.tp.Close(ctx)
}

func normalizeProductType(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

// productTypeFor returns the last non-blank per-event override, else the
// configured default.
func (b *Billing) productTypeFor(opts []EventOptions) string {
	for i := len(opts) - 1; i >= 0; i-- {
		if pt := normalizeProductType(opts[i].ProductType); pt != "" {
			return pt
		}
	}
	return b.cfg.ProductType
}

// executionStatusFor returns the last non-blank per-event ExecutionStatus
// (raw; the caller normalizes it).
func executionStatusFor(opts []EventOptions) string {
	for i := len(opts) - 1; i >= 0; i-- {
		if strings.TrimSpace(opts[i].ExecutionStatus) != "" {
			return opts[i].ExecutionStatus
		}
	}
	return ""
}

// charLen counts UTF-16 code units, which is what the server's @Size counts
// (Java String.length()). Counting bytes would refuse multi-byte values the
// ingestor accepts.
func charLen(value string) int {
	n := 0
	for _, r := range value {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// tooLong returns a message naming the field, the limit and the (truncated)
// value when value exceeds max characters, else "".
func tooLong(field, value string, max int) string {
	if n := charLen(value); n > max {
		return fmt.Sprintf("%s is %d characters, exceeding the ingestor's %d-character limit (value %q)",
			field, n, max, truncate(value, 80))
	}
	return ""
}

// dropInvalid accounts for an event refused client-side. It is never queued
// or sent: it is counted in DroppedCount(), WARN-logged (throttled), reported
// through OnError and handed to the opt-in OnDrop hook with DropInvalid.
func (b *Billing) dropInvalid(event map[string]any, msg string) {
	key, _ := event["idempotencyKey"].(string)
	b.cfg.OnError(fmt.Errorf("graphqlmetering: invalid event dropped: %s", msg))
	b.tp.ReportInvalid(ingest.Event{Key: key, Ref: event}, msg)
}

// DroppedCount returns the total events the SDK gave up on since this Billing
// instance was created (every DropReason).
func (b *Billing) DroppedCount() int64 {
	return b.tp.Dropped()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
