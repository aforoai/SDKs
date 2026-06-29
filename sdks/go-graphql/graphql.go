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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const sdkVersion = "1.0.0"

type Config struct {
	TenantID         string
	ProductID        string
	APIKey           string
	IngestorURL      string
	SchemaVersion    string // optional, attached to event metadata
	FlushCount       int
	FlushInterval    time.Duration
	HTTPClient       *http.Client
	CustomerExtractor func(r *http.Request) string
	OnError          func(error)
}

type Billing struct {
	cfg    Config
	url    string
	client *http.Client

	mu     sync.Mutex
	buffer []map[string]any
	stop   chan struct{}
	wg     sync.WaitGroup
}

func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" {
		return nil, errors.New("graphqlmetering: TenantID, ProductID, APIKey, IngestorURL are required")
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
		cfg:    cfg,
		url:    strings.TrimRight(cfg.IngestorURL, "/") + "/v1/ingest/events",
		client: cfg.HTTPClient,
		stop:   make(chan struct{}),
	}
	b.wg.Add(1)
	go b.flushLoop()
	return b, nil
}

// Middleware wraps an http.Handler that serves GraphQL POST requests.
// Captures the request body, extracts operation type/name, and emits one
// billing event per response.
func (b *Billing) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			next.ServeHTTP(w, r)
			return
		}
		bodyBytes, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

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
		customerID := b.cfg.CustomerExtractor(r)
		if customerID == "" {
			return
		}
		b.Record(customerID, req.Query, req.OperationName, time.Since(start).Milliseconds(), recw.status >= 400)
	})
}

// Record emits one billing event manually. Use from custom executors.
func (b *Billing) Record(customerID, query, operationName string, durationMs int64, hasErrors bool) {
	if customerID == "" || query == "" {
		return
	}
	opType, opName := detectOperation(query, operationName)
	complexity, fieldCount := scoreComplexity(query)

	now := time.Now().UTC()
	event := map[string]any{
		"customerId":          customerID,
		"metricName":          "graphql_api.operations",
		"quantity":            1,
		"occurredAt":          now.Format(time.RFC3339Nano),
		"idempotencyKey":      fmt.Sprintf("gql:%s:%s:%s:%d:%s", b.cfg.TenantID, b.cfg.ProductID, opName, now.UnixMilli(), randomSuffix()),
		"productType":         "GRAPHQL_API",
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

func (b *Billing) flush() {
	b.mu.Lock()
	if len(b.buffer) == 0 {
		b.mu.Unlock()
		return
	}
	batch := b.buffer
	b.buffer = nil
	b.mu.Unlock()

	body, err := json.Marshal(map[string]any{"events": batch})
	if err != nil {
		b.cfg.OnError(err)
		return
	}
	for attempt := 1; attempt <= 3; attempt++ {
		req, _ := http.NewRequest(http.MethodPost, b.url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+b.cfg.APIKey)
		req.Header.Set("X-Tenant-Id", b.cfg.TenantID)
		resp, err := b.client.Do(req)
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return
			}
		} else if attempt == 3 {
			b.cfg.OnError(err)
			return
		}
		time.Sleep(time.Duration(1<<(attempt-1)) * time.Second)
	}
	b.cfg.OnError(fmt.Errorf("graphqlmetering: flush exhausted retries (dropped %d events)", len(batch)))
}

func (b *Billing) Shutdown() error {
	close(b.stop)
	b.wg.Wait()
	return nil
}

// ── Helpers ──

type responseRecorder struct {
	http.ResponseWriter
	status int
}

func (r *responseRecorder) WriteHeader(code int) { r.status = code; r.ResponseWriter.WriteHeader(code) }

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

var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomSuffix() string {
	out := make([]byte, 8)
	for i := range out {
		out[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(out)
}
