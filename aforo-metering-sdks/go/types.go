package metering

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go/v2/internal/ingest"
)

// DropReason describes why the SDK gave up on an event.
type DropReason string

const (
	// DropOverflow — the queue was full; the OLDEST event was evicted.
	DropOverflow DropReason = "overflow"
	// DropRejected — the ingestor refused the event (a non-retryable 4xx, a
	// single event still too large after 413 splitting, or errors[] with
	// retryable=false in a 2xx answer).
	DropRejected DropReason = "rejected"
	// DropInvalid — the event failed client-side validation (blank required
	// field, non-positive quantity, field over the ingestor's limit, or no
	// customer resolved by the middleware) and was never queued. Track also
	// returns ErrInvalidEvent for it.
	DropInvalid DropReason = "invalid"
	// DropShutdown — the event was still queued when Close's deadline passed.
	DropShutdown DropReason = "shutdown"
	// DropClosed — Track was called after Close. Track also returns
	// ErrClientClosed.
	DropClosed DropReason = "closed"
	// DropRetryExhausted is kept for API compatibility. Since v2 a batch that
	// keeps failing goes back to the queue (the ingestor deduplicates on the
	// idempotency key) instead of being dropped, so this reason is not
	// reported by the transport.
	DropRetryExhausted DropReason = "retry_exhausted"
)

const (
	// DefaultProductType is the product type stamped on events when neither
	// Options.ProductType nor TrackEvent.ProductType is set.
	DefaultProductType = "API"
	// DefaultBaseURL is the ingestor used when Options.BaseURL is empty.
	DefaultBaseURL = "https://api.aforo.ai"
	// maxBatchSize is the ingestor's per-request event limit.
	maxBatchSize = 1000
)

// Options configures the AforoClient.
//
// Defaults follow contract/ingest-contract.json → transportPolicy.
type Options struct {
	APIKey      string // sent only as the X-API-Key header; never logged or printed
	BaseURL     string // Default: "https://api.aforo.ai". Must be https (see AllowInsecureHTTP)
	ProductType string // Default: "API". Sent as top-level `productType` on every event.

	// AllowInsecureHTTP permits an http:// BaseURL on a host other than
	// localhost, 127.0.0.1 or ::1. Leave it off in production.
	AllowInsecureHTTP bool

	// Compression is "gzip" (default: batches of 1 KiB or more are sent with
	// Content-Encoding: gzip; needs usage-ingestor wave 8 or later) or "none"
	// (always plain JSON).
	Compression string

	FlushCount      int           // Events per request. Default: 500 (clamped to 1000, the ingestor batch limit)
	FlushInterval   time.Duration // Default: 5s
	MaxQueueSize    int           // Default: 10000. When full the oldest event is dropped (DropOverflow)
	MaxRetries      int           // Default: 3; a negative value disables retries
	RetryBase       time.Duration // Full-jitter backoff base. Default: 500ms
	Timeout         time.Duration // Total deadline per request. Default: 10s
	ShutdownTimeout time.Duration // How long Close keeps sending. Default: 5s

	// HTTPClient, when set, is used for every request (you keep ownership).
	// When nil the SDK builds one pooled client and closes it on Close.
	HTTPClient *http.Client

	// OnDrop is an OPT-IN hook invoked with events the SDK gives up on (see
	// DropReason), so the app can persist / alert / replay them. Dropped
	// events keep their idempotency keys — re-submitting them via Track()
	// after recovery is dedup-safe. Default: nil (drops are still counted in
	// DroppedCount() and WARN-logged). Panics in the hook are recovered.
	OnDrop func(events []TrackEvent, reason DropReason)

	// OnError, when set, receives a *TransportError for every sending
	// problem: an outage or auth failure (events stay queued), a rejection, a
	// shutdown loss, or Track after Close. Branch on Kind, never on the
	// message. It runs on the background sender and may call Flush or Close;
	// panics are recovered. It never carries the API key.
	OnError func(err *TransportError)

	// OnAccepted, when set, receives the body of every 2xx answer (the data
	// object, envelope removed — for example accepted, duplicates,
	// killedSessionIds) and the events of that request. Same rules as OnError.
	OnAccepted func(body json.RawMessage, events []TrackEvent)

	// hooks replace the clock, sleep and random source in tests.
	hooks ingest.Hooks
}

// String never prints the API key.
func (o Options) String() string {
	return fmt.Sprintf("metering.Options{APIKey:%s, BaseURL:%q, ProductType:%q, FlushCount:%d, MaxQueueSize:%d}",
		ingest.RedactKey(o.APIKey), o.BaseURL, o.ProductType, o.FlushCount, o.MaxQueueSize)
}

// GoString never prints the API key.
func (o Options) GoString() string { return o.String() }

func (o *Options) defaults() {
	if o.BaseURL == "" {
		o.BaseURL = DefaultBaseURL
	}
	o.ProductType = normalizeProductType(o.ProductType)
	if o.ProductType == "" {
		o.ProductType = DefaultProductType
	}
	if o.FlushCount <= 0 {
		o.FlushCount = ingest.DefaultFlushCount
	}
	if o.FlushCount > maxBatchSize {
		o.FlushCount = maxBatchSize
	}
}

// normalizeProductType trims and upper-cases a product type. Unknown values
// are passed through unchanged (the ingestor is the source of truth).
func normalizeProductType(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

// TrackEvent represents a usage event to track.
type TrackEvent struct {
	CustomerID     string
	MetricName     string
	Quantity       float64
	IdempotencyKey string // Auto-generated if empty
	OccurredAt     string // ISO 8601 / RFC 3339; normalized to UTC. Defaults to now
	ProductType    string // Overrides Options.ProductType for this event
	Metadata       map[string]interface{}

	// ExecutionStatus is the optional outcome of the request, used by
	// OUTCOME_BASED pricing (each event bills at the weight set for its status;
	// events without a status bill at full price). Trimmed and upper-cased by
	// the SDK; blank is treated as absent and omitted from the wire body.
	// Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED,
	// FAILED, FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED (max 20
	// chars). Any other value is WARN-logged and omitted (the rest of the event
	// is still sent), since the ingestor would reject the event.
	ExecutionStatus string `json:"executionStatus,omitempty"`

	// Optional HTTP context, sent as top-level fields when set.
	EndpointPath   string
	HTTPMethod     string
	StatusCode     int
	ResponseTimeMs int64
}

// resolvedEvent is the internal representation with all fields resolved.
type resolvedEvent struct {
	CustomerID     string                 `json:"customerId"`
	MetricName     string                 `json:"metricName"`
	Quantity       float64                `json:"quantity"`
	IdempotencyKey string                 `json:"idempotencyKey"`
	OccurredAt     string                 `json:"occurredAt"`
	ProductType    string                 `json:"productType"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
	// ExecutionStatus is normalized (trimmed, upper-cased); omitted when empty.
	ExecutionStatus string `json:"executionStatus,omitempty"`
	EndpointPath    string `json:"endpointPath,omitempty"`
	HTTPMethod      string `json:"httpMethod,omitempty"`
	StatusCode      int    `json:"statusCode,omitempty"`
	ResponseTimeMs  int64  `json:"responseTimeMs,omitempty"`
}

// FlushResult reports what a Flush did.
type FlushResult struct {
	Sent     int // accepted (or reported as duplicate) by the ingestor
	Rejected int // refused by the ingestor and reported through OnDrop
	Pending  int // still queued (for example during an ingest outage)
}

// asTrackEvent converts the internal representation back to the public shape
// so drop hooks receive events they can re-submit via Track() (keys preserved).
func (e resolvedEvent) asTrackEvent() TrackEvent {
	return TrackEvent{
		CustomerID:     e.CustomerID,
		MetricName:     e.MetricName,
		Quantity:       e.Quantity,
		IdempotencyKey: e.IdempotencyKey,
		OccurredAt:     e.OccurredAt,
		ProductType:    e.ProductType,
		Metadata:       e.Metadata,
		EndpointPath:   e.EndpointPath,
		HTTPMethod:     e.HTTPMethod,
		StatusCode:     e.StatusCode,
		ResponseTimeMs: e.ResponseTimeMs,
		// Already normalized — re-normalizing on re-submit is idempotent.
		ExecutionStatus: e.ExecutionStatus,
	}
}

// maxExecutionStatusLength mirrors the ingest contract's maxLength for
// executionStatus.
const maxExecutionStatusLength = 20

// canonicalExecutionStatuses is the ingest contract's executionStatus set
// (contract/ingest-contract.json). Any other value makes the ingestor reject
// the event, so the SDK leaves the status off and keeps the event.
var canonicalExecutionStatuses = map[string]struct{}{
	"SUCCESS": {}, "PARTIAL": {}, "TIMEOUT": {}, "ERROR": {},
	"VALIDATION_FAILED": {}, "FAILED": {}, "FAILURE": {}, "CANCELLED": {},
	"PENDING": {}, "BLOCKED": {}, "HITL_REQUIRED": {},
}

// invalidExecutionStatuses counts unknown values dropped by
// normalizeExecutionStatus; it throttles the WARN log.
var invalidExecutionStatuses atomic.Int64

// normalizeExecutionStatus trims and upper-cases a status; blank becomes "".
// A value outside the canonical set (or longer than 20 chars) is WARN-logged
// and also becomes "", so the field is omitted and the rest of the event (and
// its batch) still reaches the ingestor.
func normalizeExecutionStatus(value string) string {
	s := strings.ToUpper(strings.TrimSpace(value))
	if s == "" {
		return ""
	}
	if _, ok := canonicalExecutionStatuses[s]; ok && len(s) <= maxExecutionStatusLength {
		return s
	}
	// Throttled (first, then every 1000th) so a misconfigured caller can't
	// storm the log.
	if n := invalidExecutionStatuses.Add(1); n == 1 || n%1000 == 0 {
		log.Printf("[aforo] WARN: unknown executionStatus %q omitted from event (%d total). Accepted: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED.", truncateForLog(value), n)
	}
	return ""
}

// truncateForLog bounds a caller-supplied value before it is logged.
func truncateForLog(value string) string {
	const limit = 80
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}

// ErrorKind classifies a TransportError.
type ErrorKind = ingest.ErrorKind

// Kinds a TransportError can have.
const (
	KindOutage   = ingest.KindOutage   // unreachable, 5xx/408/429 after the retries, or a redirect; events kept queued
	KindAuth     = ingest.KindAuth     // 401/403: the API key is wrong or revoked; events kept queued
	KindRejected = ingest.KindRejected // the ingestor refused events; they went to OnDrop as rejected
	KindShutdown = ingest.KindShutdown // still queued at Close's deadline; reported as shutdown
	KindClosed   = ingest.KindClosed   // tracked after Close; reported as closed
)

// TransportError is what Options.OnError receives. Events are the events
// concerned (requeued for outage/auth, dropped for the other kinds). Status
// is the HTTP status that caused it, 0 for a network error. errors.Is
// matches ErrIngestUnavailable (outage, auth), ErrShutdownIncomplete
// (shutdown) and ErrClientClosed (closed).
type TransportError struct {
	Kind    ErrorKind
	Status  int
	Message string
	Events  []TrackEvent
}

func (e *TransportError) Error() string { return e.Message }

// Unwrap exposes the sentinel error for the kind.
func (e *TransportError) Unwrap() error {
	switch e.Kind {
	case KindOutage, KindAuth:
		return ErrIngestUnavailable
	case KindShutdown:
		return ErrShutdownIncomplete
	case KindClosed:
		return ErrClientClosed
	}
	return nil
}
