package metering

import (
	"strings"
	"time"
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
	EndpointPath   string                 `json:"endpointPath,omitempty"`
	HTTPMethod     string                 `json:"httpMethod,omitempty"`
	StatusCode     int                    `json:"statusCode,omitempty"`
	ResponseTimeMs int64                  `json:"responseTimeMs,omitempty"`
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
		Index   int    `json:"index"`
		Message string `json:"message"`
	} `json:"errors"`
}

// FlushResult contains the result of a flush operation.
type FlushResult struct {
	Sent   int
	Failed int
}
