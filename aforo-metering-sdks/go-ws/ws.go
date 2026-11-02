// Package wsmetering ships per-connection (and optionally per-frame)
// WebSocket billing events from a Go server to Aforo's usage ingestor.
//
// Framework-agnostic — works with gorilla/websocket, nhooyr.io/websocket,
// gobwas/ws, net/http upgrade, etc. Call Open, RecordFrame, and Close
// from your handlers; the SDK aggregates per-connection counters and
// emits a CONNECTION_OPENED + CONNECTION_CLOSED event pair.
package wsmetering

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go-ws/v2/internal/ingest"
)

const sdkVersion = "2.1.0"

// DefaultConnectionIdleTimeout is how long a connection may go without Open,
// RecordFrame or Close activity before the SDK closes it itself (see
// Config.ConnectionIdleTimeout).
const DefaultConnectionIdleTimeout = time.Hour

// Config configures Billing. Sending defaults follow the shared transport
// policy (contract/ingest-contract.json → transportPolicy).
type Config struct {
	TenantID       string
	ProductID      string
	APIKey         string // sent only as X-API-Key; never logged or printed
	IngestorURL    string // must be https (http only for localhost or with AllowInsecureHTTP)
	ProductType    string // default "WEBSOCKET_API"; sent as top-level productType on every event
	PerFrameEvents bool   // off by default — emit only OPEN + CLOSE

	AllowInsecureHTTP bool          // allow http:// to a host other than localhost/127.0.0.1/::1
	Compression       string        // "gzip" (default; 1 KiB+ batches gzip-encoded, needs usage-ingestor wave 8+) or "none"
	FlushCount        int           // events per request, default 500 (max 1000)
	FlushInterval     time.Duration // default 5s
	MaxQueueSize      int           // default 10000; when full the oldest event is dropped (DropOverflow)
	MaxRetries        int           // default 3; negative disables retries
	RetryBase         time.Duration // full-jitter backoff base, default 500ms
	Timeout           time.Duration // total deadline per request, default 10s
	ShutdownTimeout   time.Duration // how long Shutdown keeps sending, default 5s

	// ConnectionIdleTimeout closes a tracked connection that saw no activity
	// for this long (a CONNECTION_CLOSED event with close reason
	// ABNORMAL_CLOSURE and metadata closedBy "sdk_idle_timeout"), so a
	// connection your code never closed does not stay in memory. Default 1h.
	// A negative value is refused by New: without the sweep the connection
	// map could grow without bound.
	ConnectionIdleTimeout time.Duration

	HTTPClient *http.Client // optional; you keep ownership
	// OnError is called for sending problems with a *TransportError (use
	// errors.As and branch on Kind: outage, auth, rejected, shutdown,
	// closed) and for events refused client-side with a plain error. It runs
	// on the background sender and may call Flush or Shutdown. Never carries
	// the API key.
	OnError func(error)
	// OnAccepted, when set, receives the body of every 2xx answer (the data
	// object, envelope removed) and the events of that request. Same
	// goroutine and panic rules as OnError.
	OnAccepted func(body json.RawMessage, events []map[string]any)
	// OnDrop is an OPT-IN hook invoked with events the SDK gives up on (see
	// DropReason). Events keep their idempotency keys, so re-submitting them
	// after recovery is dedup-safe. Default: nil (drops are still counted in
	// DroppedCount() and WARN-logged). Panics in the hook are recovered.
	OnDrop func(events []map[string]any, reason DropReason)

	hooks ingest.Hooks // tests: clock, sleep and random source
}

type Billing struct {
	cfg Config
	tp  *ingest.Client

	connections sync.Map // map[string]*ConnectionState
	// lifecycle orders Open against Shutdown: Open holds it for reading while
	// it registers a connection and queues its OPEN; Shutdown takes it for
	// writing to set shuttingDown. An Open is therefore either finished
	// before Shutdown closes the open connections (and gets its CLOSE) or
	// sees shuttingDown and is refused as closed.
	lifecycle    sync.RWMutex
	shuttingDown bool
	stopSweep    chan struct{}
	sweepDone    chan struct{}
	stopOnce     sync.Once
	now          func() time.Time
}

type ConnectionState struct {
	customerId   string
	productType  string
	startMs      int64
	frames       atomic.Int64
	bytes        atomic.Int64
	lastActivity atomic.Int64 // unix millis
	metadata     map[string]any
}

// New validates cfg and starts the background sender (and the idle-connection
// sweep). Call Shutdown(ctx) when your server stops.
func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" {
		return nil, errors.New("wsmetering: TenantID, ProductID, APIKey, IngestorURL are required")
	}
	cfg.ProductType = normalizeProductType(cfg.ProductType)
	if cfg.ProductType == "" {
		cfg.ProductType = DefaultProductType
	}
	if cfg.OnError == nil {
		cfg.OnError = func(err error) {}
	}
	if cfg.ConnectionIdleTimeout < 0 {
		return nil, errors.New("wsmetering: ConnectionIdleTimeout must not be negative (0 means the default, 1h)")
	}
	if cfg.ConnectionIdleTimeout == 0 {
		cfg.ConnectionIdleTimeout = DefaultConnectionIdleTimeout
	}
	tp, err := newTransport(cfg)
	if err != nil {
		return nil, err
	}
	b := &Billing{cfg: cfg, tp: tp, stopSweep: make(chan struct{}), sweepDone: make(chan struct{}), now: time.Now}
	if cfg.hooks.Now != nil {
		b.now = cfg.hooks.Now
	}
	go b.sweepLoop()
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
	productType := b.productTypeFor(opts)
	if customerID == "" {
		// Not billed, but counted: a connection without a customer is a
		// resolution gap in the integration, not something to hide.
		b.dropInvalid(map[string]any{"customerId": "", "productType": productType, "metadata": metadata}, "customerId is required; connection not metered")
		return ""
	}
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
	now := b.now()
	connID := fmt.Sprintf("ws_%d_%s", now.UnixNano(), randomSuffix())
	state := &ConnectionState{
		customerId:  customerID,
		productType: productType,
		startMs:     now.UnixMilli(),
		metadata:    metadata,
	}
	state.lastActivity.Store(now.UnixMilli())
	b.lifecycle.RLock()
	defer b.lifecycle.RUnlock()
	if b.shuttingDown {
		// During or after Shutdown: reported as DropClosed, never tracked or sent.
		ev := b.connEvent(state, connID, "OPEN", "SERVER_TO_CLIENT", 0, 0, 0, "", metadata)
		key, _ := ev["idempotencyKey"].(string)
		b.tp.Report([]ingest.Event{{Key: key, Ref: ev}}, ingest.DropClosed)
		return ""
	}
	b.connections.Store(connID, state)
	b.push(withExecutionStatus(b.connEvent(state, connID, "OPEN", "SERVER_TO_CLIENT", 0, 0, 0, "", merge(metadata, map[string]any{"event": "CONNECTION_OPENED"})), executionStatusFor(opts)))
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
	nowMs := b.now().UnixMilli()
	s.lastActivity.Store(nowMs)
	if b.cfg.PerFrameEvents {
		b.push(withExecutionStatus(b.connEvent(s, connID, frameType, direction, 1, bytes,
			nowMs-s.startMs, "", s.metadata), opts.ExecutionStatus))
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
	b.closeConn(connID, closeCode, "", opts)
}

// closeConn emits CONNECTION_CLOSED once per connection; closedBy names an
// SDK-initiated close ("sdk_shutdown", "sdk_idle_timeout").
func (b *Billing) closeConn(connID string, closeCode int, closedBy string, opts EventOptions) {
	v, loaded := b.connections.LoadAndDelete(connID)
	if !loaded {
		return
	}
	s := v.(*ConnectionState)
	durationMs := b.now().UnixMilli() - s.startMs
	reason := mapCloseReason(closeCode)
	extra := map[string]any{
		"event":     "CONNECTION_CLOSED",
		"frames":    s.frames.Load(),
		"bytes":     s.bytes.Load(),
		"closeCode": closeCode,
	}
	if closedBy != "" {
		extra["closedBy"] = closedBy
	}
	meta := merge(s.metadata, extra)
	b.push(withExecutionStatus(b.connEvent(s, connID, "CLOSE", "SERVER_TO_CLIENT",
		int(s.frames.Load()), s.bytes.Load(), durationMs, reason, meta), opts.ExecutionStatus))
}

func (b *Billing) connEvent(s *ConnectionState, connID, frameType, direction string, frames int, bytesAmt, durationMs int64, closeReason string, metadata map[string]any) map[string]any {
	now := b.now().UTC()
	metricName := "websocket_api.message"
	switch frameType {
	case "OPEN":
		metricName = "websocket_api.connection_opened"
	case "CLOSE":
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
	case "OPEN", "TEXT", "BINARY", "PING", "PONG", "CLOSE":
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

// OpenConnections returns how many connections are tracked (opened and not
// yet closed by you, the idle sweep or Shutdown).
func (b *Billing) OpenConnections() int {
	n := 0
	b.connections.Range(func(_, _ any) bool { n++; return true })
	return n
}

func (b *Billing) sweepLoop() {
	defer close(b.sweepDone)
	every := b.cfg.ConnectionIdleTimeout / 4
	if every > time.Minute {
		every = time.Minute
	}
	if every < time.Second {
		every = time.Second
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			b.sweepIdle(b.now())
		case <-b.stopSweep:
			return
		}
	}
}

// sweepIdle closes connections idle longer than ConnectionIdleTimeout.
func (b *Billing) sweepIdle(now time.Time) int {
	cutoff := now.Add(-b.cfg.ConnectionIdleTimeout).UnixMilli()
	n := 0
	b.connections.Range(func(k, v any) bool {
		if v.(*ConnectionState).lastActivity.Load() <= cutoff {
			b.closeConn(k.(string), 1006, "sdk_idle_timeout", EventOptions{})
			n++
		}
		return true
	})
	return n
}

// Shutdown emits CONNECTION_CLOSED (close code 1001, GOING_AWAY, metadata
// closedBy "sdk_shutdown") for every connection still open, then sends what
// is queued until the earlier of ctx's deadline and Config.ShutdownTimeout.
// Events still queued then are reported as DropShutdown and Shutdown returns
// an error wrapping ErrShutdownIncomplete. Safe to call more than once.
func (b *Billing) Shutdown(ctx context.Context) error {
	b.stopOnce.Do(func() {
		b.lifecycle.Lock()
		b.shuttingDown = true
		b.lifecycle.Unlock()
		close(b.stopSweep)
		<-b.sweepDone
		b.connections.Range(func(k, _ any) bool {
			b.closeConn(k.(string), 1001, "sdk_shutdown", EventOptions{})
			return true
		})
	})
	return b.shutdownTransport(ctx)
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
