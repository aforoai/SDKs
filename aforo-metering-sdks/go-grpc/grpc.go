// Package grpcmetering ships per-RPC billing events from a Go gRPC server
// to Aforo's usage ingestor.
//
// Usage:
//
//	billing, _ := grpcmetering.New(grpcmetering.Config{
//	    TenantID:    "tenant_acme",
//	    ProductID:   "prod_grpc_user_svc",
//	    APIKey:      os.Getenv("AFORO_API_KEY"),
//	    IngestorURL: "https://ingestor.aforo.ai",
//	    ServiceName: "acme.v1.UserService",
//	})
//	defer billing.Shutdown(context.Background())
//
//	server := grpc.NewServer(
//	    grpc.UnaryInterceptor(billing.UnaryInterceptor()),
//	    grpc.StreamInterceptor(billing.StreamInterceptor()),
//	)
package grpcmetering

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const sdkVersion = "1.0.0"

// Config captures all SDK options.
type Config struct {
	TenantID         string
	ProductID        string
	APIKey           string
	IngestorURL      string
	ServiceName      string // fully-qualified gRPC service, e.g. "acme.v1.UserService"
	FlushCount       int   // default 50
	FlushInterval    time.Duration // default 5s
	HTTPClient       *http.Client  // optional override
	CustomerExtractor func(ctx context.Context) string // default reads "x-customer-id" md
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

// New constructs a Billing instance and starts the background flush loop.
func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" || cfg.ServiceName == "" {
		return nil, errors.New("grpcmetering: TenantID, ProductID, APIKey, IngestorURL and ServiceName are required")
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
		cfg.CustomerExtractor = defaultCustomerExtractor
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

// UnaryInterceptor returns a grpc.UnaryServerInterceptor that meters every call.
func (b *Billing) UnaryInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		start := time.Now()
		resp, err := handler(ctx, req)
		b.recordRPC(ctx, info.FullMethod, "UNARY", err, 1, start)
		return resp, err
	}
}

// StreamInterceptor returns a grpc.StreamServerInterceptor that meters streaming RPCs.
// Streaming RPCs emit one event on stream completion with messageCount = 1 (we cannot
// observe per-frame counts without wrapping the ServerStream — call Record() manually
// from inside the handler if you need exact frame counts).
func (b *Billing) StreamInterceptor() grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		start := time.Now()
		err := handler(srv, ss)
		callType := "BIDI_STREAM"
		switch {
		case info.IsClientStream && !info.IsServerStream:
			callType = "CLIENT_STREAM"
		case !info.IsClientStream && info.IsServerStream:
			callType = "SERVER_STREAM"
		}
		b.recordRPC(ss.Context(), info.FullMethod, callType, err, 1, start)
		return err
	}
}

// Record manually emits a billing event. Use for streaming RPCs where you want exact
// message counts. The grpcStatusCode is auto-derived from err.
func (b *Billing) Record(ctx context.Context, method, callType string, messageCount int, err error, durationMs int64) {
	customerID := b.cfg.CustomerExtractor(ctx)
	if customerID == "" {
		return
	}
	statusLabel := "OK"
	if err != nil {
		st, _ := status.FromError(err)
		statusLabel = st.Code().String()
	}
	now := time.Now().UTC()
	event := map[string]any{
		"customerId":          customerID,
		"metricName":          "grpc_api.rpc_calls",
		"quantity":            1,
		"occurredAt":          now.Format(time.RFC3339Nano),
		"idempotencyKey":      fmt.Sprintf("grpc:%s:%s:%s:%d:%s", b.cfg.TenantID, b.cfg.ServiceName, method, now.UnixMilli(), randomSuffix()),
		"productType":         "GRPC_API",
		"grpcService":         b.cfg.ServiceName,
		"grpcMethod":          method,
		"grpcStatusCode":      statusLabel,
		"grpcCallType":        callType,
		"messageCount":        messageCount,
		"executionDurationMs": durationMs,
		"metadata": map[string]any{
			"sdkVersion": sdkVersion,
			"productId":  b.cfg.ProductID,
		},
	}
	b.mu.Lock()
	b.buffer = append(b.buffer, event)
	overflow := len(b.buffer) >= b.cfg.FlushCount
	b.mu.Unlock()
	if overflow {
		go b.flush()
	}
}

func (b *Billing) recordRPC(ctx context.Context, fullMethod, callType string, err error, messageCount int, start time.Time) {
	method := fullMethod
	if i := strings.LastIndex(fullMethod, "/"); i >= 0 {
		method = fullMethod[i+1:]
	}
	b.Record(ctx, method, callType, messageCount, err, time.Since(start).Milliseconds())
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
	b.cfg.OnError(fmt.Errorf("grpcmetering: flush exhausted retries (dropped %d events)", len(batch)))
}

// Shutdown flushes pending events and stops the background goroutine.
func (b *Billing) Shutdown(ctx context.Context) error {
	close(b.stop)
	done := make(chan struct{})
	go func() { b.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func defaultCustomerExtractor(ctx context.Context) string {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	if v := md.Get("x-customer-id"); len(v) > 0 {
		return v[0]
	}
	return ""
}

var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomSuffix() string {
	out := make([]byte, 8)
	for i := range out {
		out[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(out)
}
