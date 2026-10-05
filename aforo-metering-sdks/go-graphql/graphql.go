// Package graphqlmetering ships per-operation GraphQL billing events
// from a Go GraphQL server (graphql-go, gqlgen, or any HTTP server)
// to Aforo's usage ingestor.
//
// Two integration modes:
//   - HTTP middleware: Wrap your /graphql HTTP handler with billing.Middleware()
//   - Manual:           Call billing.Record() from your custom executor
package graphqlmetering

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const sdkVersion = "1.2.2"

// maxGqlOperationNameLen is the ingestor's limit for gqlOperationName.
const maxGqlOperationNameLen = 255

// maxCapturedResponseBytes caps how much of a GraphQL response the
// Middleware keeps to derive executionStatus. Larger responses fall back to
// the HTTP status.
const maxCapturedResponseBytes = 1 << 20

// DropReason describes why a buffered batch was permanently dropped.
// The buffer is unbounded (drained at flush start), so unlike the core SDK
// there is no overflow reason here.
type DropReason string

const (
	// DropRetryExhausted — the batch failed after all transport retries.
	DropRetryExhausted DropReason = "retry_exhausted"
	// DropRejected — the ingestor answered a non-retryable 4xx, refused the
	// event individually in a 2xx partial-failure response, or the batch
	// could not be serialized.
	DropRejected DropReason = "rejected"
	// DropInvalid — the event failed client-side validation (a required field
	// was blank or a field exceeded the ingestor's limit) and was never
	// buffered.
	DropInvalid DropReason = "invalid"
)

type Config struct {
	TenantID          string
	ProductID         string
	APIKey            string
	IngestorURL       string
	ProductType       string // default "GRAPHQL_API"; sent as top-level productType on every event
	SchemaVersion     string // optional, attached to event metadata
	FlushCount        int
	FlushInterval     time.Duration
	HTTPClient        *http.Client
	CustomerExtractor func(r *http.Request) string
	OnError           func(error)
	// OnDrop is an OPT-IN hook invoked with events the SDK is about to lose
	// permanently (retry exhaustion, a rejection by the ingestor, or
	// client-side validation — see DropReason). Events keep
	// their idempotency keys, so re-submitting them after recovery is
	// dedup-safe. Default: nil (drops are still counted in DroppedCount()
	// and WARN-logged). Panics in the hook are recovered.
	OnDrop func(events []map[string]any, reason DropReason)
}

type Billing struct {
	cfg    Config
	url    string
	client *http.Client

	mu       sync.Mutex
	buffer   []map[string]any
	stop     chan struct{}
	stopOnce sync.Once
	dropped  atomic.Int64
	// invalidDrops throttles the DropInvalid WARN log.
	invalidDrops atomic.Int64
	// truncWarned holds the label names already WARN-logged as truncated.
	truncWarned sync.Map
	// retryBackoffBase is the exponential-backoff base (default 1s) —
	// package-private so tests can skip real sleeps.
	retryBackoffBase time.Duration
	wg               sync.WaitGroup
}

func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" {
		return nil, errors.New("graphqlmetering: TenantID, ProductID, APIKey, IngestorURL are required")
	}
	cfg.ProductType = normalizeProductType(cfg.ProductType)
	if cfg.ProductType == "" {
		cfg.ProductType = DefaultProductType
	}
	if cfg.FlushCount == 0 {
		cfg.FlushCount = 50
	}
	if cfg.FlushInterval == 0 {
		cfg.FlushInterval = 5 * time.Second
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 10 * time.Second}
	}
	if cfg.CustomerExtractor == nil {
		cfg.CustomerExtractor = func(r *http.Request) string { return r.Header.Get("X-Customer-Id") }
	}
	if cfg.OnError == nil {
		cfg.OnError = func(err error) {}
	}
	b := &Billing{
		cfg:              cfg,
		url:              strings.TrimRight(cfg.IngestorURL, "/") + "/v1/ingest/batch",
		client:           cfg.HTTPClient,
		stop:             make(chan struct{}),
		retryBackoffBase: time.Second,
	}
	b.wg.Add(1)
	go b.flushLoop()
	return b, nil
}

// Middleware wraps an http.Handler that serves GraphQL POST requests.
// Captures the request body, extracts operation type/name, and emits one
// billing event per response.
//
// The operation name comes from the client's request. One longer than the
// ingestor's 255 characters is truncated (never splitting a character) and the
// event is still sent; a WARN is logged once.
//
// executionStatus is derived from the response body (see
// OutcomeFromGraphQLResponse), falling back to the HTTP status (see
// OutcomeFromHTTPStatus) when the body is not a GraphQL response or is larger
// than 1 MiB. A handler can override it with SetExecutionStatus(r.Context(), …).
func (b *Billing) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			next.ServeHTTP(w, r)
			return
		}
		bodyBytes, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

		holder := &statusHolder{}
		r = r.WithContext(context.WithValue(r.Context(), statusHolderKey{}, holder))

		start := time.Now()
		recw := &responseRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(recw, r)

		var req struct {
			Query         string `json:"query"`
			OperationName string `json:"operationName"`
		}
		if err := json.Unmarshal(bodyBytes, &req); err != nil || req.Query == "" {
			return
		}
		customerID := strings.TrimSpace(b.cfg.CustomerExtractor(r))
		if customerID == "" {
			return
		}
		executionStatus := holder.get()
		if executionStatus == "" && !recw.overflow {
			executionStatus = OutcomeFromGraphQLResponse(recw.body.Bytes())
		}
		if executionStatus == "" {
			executionStatus = OutcomeFromHTTPStatus(recw.status)
		}
		b.record(customerID, req.Query, req.OperationName, time.Since(start).Milliseconds(), recw.status >= 400, executionStatus, b.cfg.ProductType)
	})
}

// Record emits one billing event manually. Use from custom executors.
// No executionStatus is sent unless EventOptions.ExecutionStatus is set (for
// example OutcomeFromGraphQLResponse of the response you returned). Optional
// EventOptions also override the event's productType.
//
// A call with a blank customerID or query is not metered. An event the
// ingestor would refuse (a field over its limit) is not buffered: it is
// counted in DroppedCount(), WARN-logged and handed to OnDrop with DropInvalid.
// The operation name (the operationName argument, or the name read from the
// query text when it is "") originates from the client's request, so one over
// 255 characters is truncated and the event is still sent.
func (b *Billing) Record(customerID, query, operationName string, durationMs int64, hasErrors bool, opts ...EventOptions) {
	b.record(customerID, query, operationName, durationMs, hasErrors, executionStatusFor(opts), b.productTypeFor(opts))
}

// RecordWithOptions is Record with optional per-event fields.
func (b *Billing) RecordWithOptions(customerID, query, operationName string, durationMs int64, hasErrors bool, opts EventOptions) {
	b.Record(customerID, query, operationName, durationMs, hasErrors, opts)
}

func (b *Billing) record(customerID, query, operationName string, durationMs int64, hasErrors bool, executionStatus, productType string) {
	customerID = strings.TrimSpace(customerID)
	if customerID == "" || query == "" {
		return
	}
	opType, opName := detectOperation(query, operationName)
	complexity, fieldCount := scoreComplexity(query)

	now := time.Now().UTC()
	// The key is built from the full operation name, before truncation.
	key := idempotencyKeyFor(b.cfg.TenantID, b.cfg.ProductID, opName, now.UnixMilli(), randomSuffix())
	// The operation name always originates from the client's request (also
	// when integration code hands it to Record), so it is truncated to the
	// ingestor's limit instead of dropping the event.
	opName = b.truncateLabel("gqlOperationName", opName, maxGqlOperationNameLen)
	event := map[string]any{
		"customerId":          customerID,
		"metricName":          "graphql_api.operations",
		"quantity":            1,
		"occurredAt":          now.Format(time.RFC3339Nano),
		"idempotencyKey":      key,
		"productType":         productType,
		"gqlOperationType":    opType,
		"gqlOperationName":    opName,
		"gqlComplexity":       complexity,
		"gqlFieldCount":       fieldCount,
		"gqlHasErrors":        hasErrors,
		"executionDurationMs": durationMs,
		"metadata": withSchemaVersion(map[string]any{
			"sdkVersion": sdkVersion,
			"productId":  b.cfg.ProductID,
		}, b.cfg.SchemaVersion),
	}
	if s := normalizeExecutionStatus(executionStatus); s != "" {
		event["executionStatus"] = s
	}
	for _, c := range []struct {
		field, value string
		max          int
	}{
		{"customerId", customerID, maxCustomerIDLen},
		{"productType", productType, maxProductTypeLen},
	} {
		if msg := tooLong(c.field, c.value, c.max); msg != "" {
			b.dropInvalid(event, msg)
			return
		}
	}
	b.mu.Lock()
	b.buffer = append(b.buffer, event)
	overflow := len(b.buffer) >= b.cfg.FlushCount
	b.mu.Unlock()
	if overflow {
		go b.flush()
	}
}

func (b *Billing) flushLoop() {
	defer b.wg.Done()
	ticker := time.NewTicker(b.cfg.FlushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			b.flush()
		case <-b.stop:
			b.flush()
			return
		}
	}
}

func (b *Billing) Shutdown() error {
	b.stopOnce.Do(func() { close(b.stop) })
	b.wg.Wait()
	return nil
}

// ── Helpers ──

type responseRecorder struct {
	http.ResponseWriter
	status   int
	body     bytes.Buffer
	overflow bool
}

func (r *responseRecorder) WriteHeader(code int) { r.status = code; r.ResponseWriter.WriteHeader(code) }

// Write keeps a copy of the first maxCapturedResponseBytes of the response so
// the Middleware can derive executionStatus from it.
func (r *responseRecorder) Write(p []byte) (int, error) {
	if !r.overflow {
		if r.body.Len()+len(p) > maxCapturedResponseBytes {
			r.overflow = true
			r.body = bytes.Buffer{}
		} else {
			r.body.Write(p)
		}
	}
	return r.ResponseWriter.Write(p)
}

var firstKeywordRegex = regexp.MustCompile(`^\s*(query|mutation|subscription)\b\s*([A-Za-z_][A-Za-z0-9_]*)?`)

func detectOperation(query, operationName string) (string, string) {
	matches := firstKeywordRegex.FindStringSubmatch(query)
	opType := "QUERY"
	opName := operationName
	if len(matches) >= 2 {
		opType = strings.ToUpper(matches[1])
	}
	if opName == "" && len(matches) >= 3 && matches[2] != "" {
		opName = matches[2]
	}
	if opName == "" {
		opName = "anonymous"
	}
	return opType, opName
}

// scoreComplexity = field_count + 5 * max_depth using a brace-balance approximation.
// (Lightweight — for AST-accurate scoring use graphql-go's visitor.)
func scoreComplexity(query string) (int, int) {
	depth, maxDepth, fields := 0, 0, 0
	for _, c := range query {
		switch c {
		case '{':
			depth++
			if depth > maxDepth {
				maxDepth = depth
			}
		case '}':
			if depth > 0 {
				depth--
			}
		}
	}
	// Field count = approximation — count whitespace-separated identifiers inside braces.
	// Good enough for billing scoring; SDK consumers can override via Record() with a precomputed value.
	fields = len(regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_]*\s*[(:{]?`).FindAllString(query, -1))
	return fields + 5*maxDepth, fields
}

func withSchemaVersion(m map[string]any, sv string) map[string]any {
	if sv != "" {
		m["schemaVersion"] = sv
	}
	return m
}

// idempotencyKeyFor returns "gql:<tenant>:<product>:<operation>:<millis>:<suffix>".
// opName must be the full, untruncated operation name; see boundedKey for what
// happens when the key would exceed 255 characters.
func idempotencyKeyFor(tenantID, productID, opName string, millis int64, suffix string) string {
	return boundedKey(fmt.Sprintf("gql:%s:%s:", tenantID, productID), opName, fmt.Sprintf(":%d:%s", millis, suffix))
}

var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomSuffix() string {
	out := make([]byte, 8)
	for i := range out {
		out[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(out)
}
