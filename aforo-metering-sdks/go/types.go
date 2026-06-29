package metering

import "time"

// Options configures the AforoClient.
type Options struct {
	APIKey          string
	BaseURL         string        // Default: "https://ingest.aforo.ai"
	FlushCount      int           // Default: 50
	FlushInterval   time.Duration // Default: 5s
	MaxQueueSize    int           // Default: 10000
	MaxRetries      int           // Default: 3
	RetryBase       time.Duration // Default: 1s
	Timeout         time.Duration // Default: 10s
	ShutdownTimeout time.Duration // Default: 5s
}

func (o *Options) defaults() {
	if o.BaseURL == "" {
		o.BaseURL = "https://ingest.aforo.ai"
	}
	if o.FlushCount <= 0 {
		o.FlushCount = 50
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

// TrackEvent represents a usage event to track.
type TrackEvent struct {
	CustomerID     string
	MetricName     string
	Quantity       float64
	IdempotencyKey string // Auto-generated if empty
	OccurredAt     string // ISO 8601; defaults to now
	Metadata       map[string]interface{}
}

// resolvedEvent is the internal representation with all fields resolved.
type resolvedEvent struct {
	CustomerID     string                 `json:"customerId"`
	MetricName     string                 `json:"metricName"`
	Quantity       float64                `json:"quantity"`
	IdempotencyKey string                 `json:"idempotencyKey"`
	OccurredAt     string                 `json:"occurredAt"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
}

// batchRequest is the JSON body sent to POST /v1/ingest/batch.
type batchRequest struct {
	Events []resolvedEvent `json:"events"`
}

// FlushResult contains the result of a flush operation.
type FlushResult struct {
	Sent   int
	Failed int
}
