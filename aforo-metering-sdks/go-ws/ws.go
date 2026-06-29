// Package wsmetering ships per-connection (and optionally per-frame)
// WebSocket billing events from a Go server to Aforo's usage ingestor.
//
// Framework-agnostic — works with gorilla/websocket, nhooyr.io/websocket,
// gobwas/ws, net/http upgrade, etc. Call Open, RecordFrame, and Close
// from your handlers; the SDK aggregates per-connection counters and
// emits a CONNECTION_OPENED + CONNECTION_CLOSED event pair.
package wsmetering

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const sdkVersion = "1.0.0"

type Config struct {
	TenantID         string
	ProductID        string
	APIKey           string
	IngestorURL      string
	PerFrameEvents   bool          // off by default — emit only OPEN + CLOSE
	FlushCount       int           // default 100
	FlushInterval    time.Duration // default 3s
	HTTPClient       *http.Client
	OnError          func(error)
}

type Billing struct {
	cfg    Config
	url    string
	client *http.Client

	connections sync.Map // map[string]*ConnectionState
	mu          sync.Mutex
	buffer      []map[string]any
	stop        chan struct{}
	wg          sync.WaitGroup
}

type ConnectionState struct {
	customerId string
	startMs    int64
	frames     atomic.Int64
	bytes      atomic.Int64
	metadata   map[string]any
}

func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" {
		return nil, errors.New("wsmetering: TenantID, ProductID, APIKey, IngestorURL are required")
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
		cfg:    cfg,
		url:    strings.TrimRight(cfg.IngestorURL, "/") + "/v1/ingest/events",
		client: cfg.HTTPClient,
		stop:   make(chan struct{}),
	}
	b.wg.Add(1)
	go b.flushLoop()
	return b, nil
}

// Open registers a new tracked WebSocket connection. Returns a connection ID
// you must hold and pass to RecordFrame and Close.
func (b *Billing) Open(customerID string, metadata map[string]any) string {
	if customerID == "" {
		return ""
	}
	connID := fmt.Sprintf("ws_%d_%s", time.Now().UnixNano(), randomSuffix())
	state := &ConnectionState{
		customerId: customerID,
		startMs:    time.Now().UnixMilli(),
		metadata:   metadata,
	}
	b.connections.Store(connID, state)
	b.push(b.connEvent(customerID, connID, "PING", "SERVER_TO_CLIENT", 0, 0, 0, "", merge(metadata, map[string]any{"event": "CONNECTION_OPENED"})))
	return connID
}

// RecordFrame increments per-connection counters. Emits per-frame events
// only when Config.PerFrameEvents is true.
func (b *Billing) RecordFrame(connID, direction, frameType string, bytes int64) {
	v, ok := b.connections.Load(connID)
	if !ok {
		return
	}
	s := v.(*ConnectionState)
	s.frames.Add(1)
	s.bytes.Add(bytes)
	if b.cfg.PerFrameEvents {
		b.push(b.connEvent(s.customerId, connID, frameType, direction, 1, bytes,
			time.Now().UnixMilli()-s.startMs, "", s.metadata))
	}
}

// Close finalizes a tracked connection and emits the CONNECTION_CLOSED event
// with the aggregated counters. closeCode follows standard WebSocket codes
// (1000 normal, 1006 abnormal, 1008 policy, 4xxx app-level → IDLE_TIMEOUT).
func (b *Billing) Close(connID string, closeCode int) {
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
	b.push(b.connEvent(s.customerId, connID, "CLOSE", "SERVER_TO_CLIENT",
		int(s.frames.Load()), s.bytes.Load(), durationMs, reason, meta))
}

func (b *Billing) connEvent(customerID, connID, frameType, direction string, frames int, bytesAmt, durationMs int64, closeReason string, metadata map[string]any) map[string]any {
	now := time.Now().UTC()
	metricName := "websocket_api.message"
	if frameType == "CLOSE" {
		metricName = "websocket_api.connection_closed"
	}
	e := map[string]any{
		"customerId":     customerID,
		"metricName":     metricName,
		"quantity":       1,
		"occurredAt":     now.Format(time.RFC3339Nano),
		"idempotencyKey": fmt.Sprintf("ws:%s:%s:%s:%d:%s", b.cfg.TenantID, connID, frameType, now.UnixMilli(), randomSuffix()),
		"productType":    "WEBSOCKET_API",
		"wsConnectionId": connID,
		"wsDirection":    direction,
		"wsFrameType":    frameType,
		"messageCount":   frames,
		"dataBytes":      bytesAmt,
		"durationMs":     durationMs,
		"metadata":       merge(metadata, map[string]any{"sdkVersion": sdkVersion, "productId": b.cfg.ProductID}),
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
	b.cfg.OnError(fmt.Errorf("wsmetering: flush exhausted retries (dropped %d events)", len(batch)))
}

func (b *Billing) Shutdown() error {
	close(b.stop)
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
