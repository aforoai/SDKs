// Package wsmetering ships per-connection (and optionally per-frame)
// WebSocket billing events from a Go server to Aforo's usage ingestor.
//
// Framework-agnostic — works with gorilla/websocket, nhooyr.io/websocket,
// gobwas/ws, net/http upgrade, etc. Call Open, RecordFrame, and Close
// from your handlers; the SDK aggregates per-connection counters and
// emits a CONNECTION_OPENED + CONNECTION_CLOSED event pair.
package wsmetering

import (
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const sdkVersion = "1.2.1"

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
	TenantID       string
	ProductID      string
	APIKey         string
	IngestorURL    string
	ProductType    string        // default "WEBSOCKET_API"; sent as top-level productType on every event
	PerFrameEvents bool          // off by default — emit only OPEN + CLOSE
	FlushCount     int           // default 100
	FlushInterval  time.Duration // default 3s
	HTTPClient     *http.Client
	OnError        func(error)
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

	connections sync.Map // map[string]*ConnectionState
	mu          sync.Mutex
	buffer      []map[string]any
	stop        chan struct{}
	stopOnce    sync.Once
	dropped     atomic.Int64
	// invalidDrops throttles the DropInvalid WARN log.
	invalidDrops atomic.Int64
	// retryBackoffBase is the exponential-backoff base (default 1s) —
	// package-private so tests can skip real sleeps.
	retryBackoffBase time.Duration
	wg               sync.WaitGroup
}

type ConnectionState struct {
	customerId  string
	productType string
	startMs     int64
	frames      atomic.Int64
	bytes       atomic.Int64
	metadata    map[string]any
}

func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" {
		return nil, errors.New("wsmetering: TenantID, ProductID, APIKey, IngestorURL are required")
	}
	cfg.ProductType = normalizeProductType(cfg.ProductType)
	if cfg.ProductType == "" {
		cfg.ProductType = DefaultProductType
	}
	if cfg.FlushCount == 0 {
		cfg.FlushCount = 100
	}
	if cfg.FlushInterval == 0 {
		cfg.FlushInterval = 3 * time.Second
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 10 * time.Second}
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

// Open registers a new tracked WebSocket connection. Returns a connection ID
// you must hold and pass to RecordFrame and Close. Optional EventOptions set
// the productType of every event of this connection and the executionStatus
// of the CONNECTION_OPENED event.
//
// A blank customerID is not metered ("" is returned). A customerID or
// productType over the ingestor's limit is refused the same way and reported
// through DroppedCount() / OnDrop with DropInvalid.
func (b *Billing) Open(customerID string, metadata map[string]any, opts ...EventOptions) string {
	customerID = strings.TrimSpace(customerID)
	if customerID == "" {
		return ""
	}
	productType := b.productTypeFor(opts)
	for _, c := range []struct {
		field, value string
		max          int
	}{
		{"customerId", customerID, maxCustomerIDLen},
		{"productType", productType, maxProductTypeLen},
	} {
		if msg := tooLong(c.field, c.value, c.max); msg != "" {
			// The connection is not metered; the hook gets the fields known so far.
			b.dropInvalid(map[string]any{"customerId": customerID, "productType": productType, "metadata": metadata}, msg+"; connection not metered")
			return ""
		}
	}
	connID := fmt.Sprintf("ws_%d_%s", time.Now().UnixNano(), randomSuffix())
	state := &ConnectionState{
		customerId:  customerID,
		productType: productType,
		startMs:     time.Now().UnixMilli(),
		metadata:    metadata,
	}
	b.connections.Store(connID, state)
	b.push(withExecutionStatus(b.connEvent(state, connID, "PING", "SERVER_TO_CLIENT", 0, 0, 0, "", merge(metadata, map[string]any{"event": "CONNECTION_OPENED"})), executionStatusFor(opts)))
	return connID
}

// OpenWithOptions is Open with optional fields for the CONNECTION_OPENED event.
func (b *Billing) OpenWithOptions(customerID string, metadata map[string]any, opts EventOptions) string {
	return b.Open(customerID, metadata, opts)
}

// RecordFrame increments per-connection counters. Emits per-frame events
// only when Config.PerFrameEvents is true.
func (b *Billing) RecordFrame(connID, direction, frameType string, bytes int64) {
	b.RecordFrameWithOptions(connID, direction, frameType, bytes, EventOptions{})
}

// RecordFrameWithOptions is RecordFrame with optional fields for the
// per-frame event. The options are unused when Config.PerFrameEvents is off,
// because no per-frame event is emitted then.
func (b *Billing) RecordFrameWithOptions(connID, direction, frameType string, bytes int64, opts EventOptions) {
	v, ok := b.connections.Load(connID)
	if !ok {
		return
	}
	s := v.(*ConnectionState)
	s.frames.Add(1)
	s.bytes.Add(bytes)
	if b.cfg.PerFrameEvents {
		b.push(withExecutionStatus(b.connEvent(s, connID, frameType, direction, 1, bytes,
			time.Now().UnixMilli()-s.startMs, "", s.metadata), opts.ExecutionStatus))
	}
}

// Close finalizes a tracked connection and emits the CONNECTION_CLOSED event
// with the aggregated counters. closeCode follows standard WebSocket codes
// (1000 normal, 1006 abnormal, 1008 policy, 4xxx app-level → IDLE_TIMEOUT).
func (b *Billing) Close(connID string, closeCode int) {
	b.CloseWithOptions(connID, closeCode, EventOptions{})
}

// CloseWithOptions is Close with optional fields for the CONNECTION_CLOSED
// event.
func (b *Billing) CloseWithOptions(connID string, closeCode int, opts EventOptions) {
	v, loaded := b.connections.LoadAndDelete(connID)
	if !loaded {
		return
	}
	s := v.(*ConnectionState)
	durationMs := time.Now().UnixMilli() - s.startMs
	reason := mapCloseReason(closeCode)
	meta := merge(s.metadata, map[string]any{
		"event":     "CONNECTION_CLOSED",
		"frames":    s.frames.Load(),
		"bytes":     s.bytes.Load(),
		"closeCode": closeCode,
	})
	b.push(withExecutionStatus(b.connEvent(s, connID, "CLOSE", "SERVER_TO_CLIENT",
		int(s.frames.Load()), s.bytes.Load(), durationMs, reason, meta), opts.ExecutionStatus))
}

func (b *Billing) connEvent(s *ConnectionState, connID, frameType, direction string, frames int, bytesAmt, durationMs int64, closeReason string, metadata map[string]any) map[string]any {
	now := time.Now().UTC()
	metricName := "websocket_api.message"
	if frameType == "CLOSE" {
		metricName = "websocket_api.connection_closed"
	}
	e := map[string]any{
		"customerId":          s.customerId,
		"metricName":          metricName,
		"quantity":            1,
		"occurredAt":          now.Format(time.RFC3339Nano),
		"idempotencyKey":      fmt.Sprintf("ws:%s:%s:%s:%d:%s", b.cfg.TenantID, connID, frameType, now.UnixMilli(), randomSuffix()),
		"productType":         s.productType,
		"wsConnectionId":      connID,
		"messageCount":        frames,
		"dataBytes":           bytesAmt,
		"executionDurationMs": durationMs,
		"metadata":            merge(metadata, map[string]any{"sdkVersion": sdkVersion, "productId": b.cfg.ProductID}),
	}
	// wsDirection / wsFrameType are enums on the ingestor; a value outside the
	// allowed set rejects the whole event, so omit rather than send it.
	switch d := strings.ToUpper(direction); d {
	case "CLIENT_TO_SERVER", "SERVER_TO_CLIENT":
		e["wsDirection"] = d
	}
	switch ft := strings.ToUpper(frameType); ft {
	case "TEXT", "BINARY", "PING", "PONG", "CLOSE":
		e["wsFrameType"] = ft
	}
	if closeReason != "" {
		e["wsCloseReason"] = closeReason
	}
	return e
}

func mapCloseReason(code int) string {
	switch {
	case code == 1000:
		return "NORMAL_CLOSURE"
	case code == 1001:
		return "GOING_AWAY"
	case code == 1002 || code == 1007:
		return "PROTOCOL_ERROR"
	case code == 1003:
		return "UNSUPPORTED_DATA"
	case code == 1006:
		return "ABNORMAL_CLOSURE"
	case code == 1008:
		return "POLICY_VIOLATION"
	case code == 1009:
		return "MESSAGE_TOO_BIG"
	case code == 1011:
		return "INTERNAL_ERROR"
	case code >= 4000:
		return "IDLE_TIMEOUT"
	default:
		return "NORMAL_CLOSURE"
	}
}

func (b *Billing) push(event map[string]any) {
	if event == nil {
		return
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

func merge(base, extra map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(extra))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomSuffix() string {
	out := make([]byte, 8)
	for i := range out {
		out[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(out)
}
