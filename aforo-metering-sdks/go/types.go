package metering

import (
	"log"
	"strings"
	"sync/atomic"
	"time"
)

// DropReason describes why a buffered event was permanently dropped by the SDK.
type DropReason string

const (
	// DropOverflow — the ring buffer was full; the OLDEST event was evicted.
	DropOverflow DropReason = "overflow"
	// DropRetryExhausted — a batch failed after all transport retries (ingest outage).
	DropRetryExhausted DropReason = "retry_exhausted"
	// DropRejected — the ingestor rejected the batch with a non-retryable 4xx
	// (or the batch could not be serialized).
	DropRejected DropReason = "rejected"
	// DropInvalid — the event failed client-side validation (blank required
	// field, non-positive quantity, field over the ingestor's limit) and was
	// never buffered. Track also returns ErrInvalidEvent for it.
	DropInvalid DropReason = "invalid"
)

const (
	// DefaultProductType is the product type stamped on events when neither
	// Options.ProductType nor TrackEvent.ProductType is set.
	DefaultProductType = "API"
	// maxBatchSize is the ingestor's per-request event limit.
	maxBatchSize = 1000
)

// Options configures the AforoClient.
type Options struct {
	APIKey          string
	BaseURL         string        // Default: "https://api.aforo.ai"
	ProductType     string        // Default: "API". Sent as top-level `productType` on every event.
	FlushCount      int           // Default: 50 (clamped to 1000, the ingestor batch limit)
	FlushInterval   time.Duration // Default: 5s
	MaxQueueSize    int           // Default: 10000
	MaxRetries      int           // Default: 3
	RetryBase       time.Duration // Default: 1s
	Timeout         time.Duration // Default: 10s
	ShutdownTimeout time.Duration // Default: 5s

	// OnDrop is an OPT-IN hook invoked with events the SDK is about to lose
	// permanently (buffer overflow, retry exhaustion, non-retryable
	// rejection, or client-side validation), so the app can persist / alert / replay them. Dropped
	// events keep their idempotency keys — re-submitting them via Track()
	// after recovery is dedup-safe. Default: nil (drops are still counted in
	// DroppedCount() and WARN-logged). Panics in the hook are recovered.
	OnDrop func(events []TrackEvent, reason DropReason)
}

func (o *Options) defaults() {
	if o.BaseURL == "" {
		o.BaseURL = "https://api.aforo.ai"
	}
	o.ProductType = normalizeProductType(o.ProductType)
	if o.ProductType == "" {
		o.ProductType = DefaultProductType
	}
	if o.FlushCount <= 0 {
		o.FlushCount = 50
	}
	if o.FlushCount > maxBatchSize {
		o.FlushCount = maxBatchSize
	}
	if o.FlushInterval <= 0 {
		o.FlushInterval = 5 * time.Second
	}
	if o.MaxQueueSize <= 0 {
		o.MaxQueueSize = 10_000
	}
	if o.MaxRetries <= 0 {
		o.MaxRetries = 3
	}
	if o.RetryBase <= 0 {
		o.RetryBase = 1 * time.Second
	}
	if o.Timeout <= 0 {
		o.Timeout = 10 * time.Second
	}
	if o.ShutdownTimeout <= 0 {
		o.ShutdownTimeout = 5 * time.Second
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

// batchRequest is the JSON body sent to POST /v1/ingest/batch.
type batchRequest struct {
	Events []resolvedEvent `json:"events"`
}

// batchResponse is the 202 body returned by POST /v1/ingest/batch.
type batchResponse struct {
	Accepted   int `json:"accepted"`
	Duplicates int `json:"duplicates"`
	Failed     int `json:"failed"`
	Errors     []struct {
		Index   *int   `json:"index"`
		Message string `json:"message"`
	} `json:"errors"`
}

// FlushResult contains the result of a flush operation.
type FlushResult struct {
	Sent   int
	Failed int
	// Reason describes why the batch failed, when Failed > 0. Empty on success.
	Reason DropReason

	// failedIndexes are the batch positions the ingestor refused in a 2xx
	// partial-failure response (errors[].index), when it identified them.
	failedIndexes []int
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
