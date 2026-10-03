// Package grpcmetering ships per-RPC billing events from a Go gRPC server
// to Aforo's usage ingestor.
//
// Usage:
//
//	billing, _ := grpcmetering.New(grpcmetering.Config{
//	    TenantID:    "tenant_acme",
//	    ProductID:   "prod_grpc_user_svc",
//	    APIKey:      os.Getenv("AFORO_API_KEY"),
//	    IngestorURL: "https://api.aforo.ai",
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
	"context"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const sdkVersion = "1.2.2"

// Ingestor limits for the gRPC fields (IngestUsageEventRequest @Size).
const (
	maxGrpcServiceLen = 255
	maxGrpcMethodLen  = 128
)

// Config captures all SDK options.
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
	ServiceName       string                           // fully-qualified gRPC service, e.g. "acme.v1.UserService"
	ProductType       string                           // default "GRPC_API"; sent as top-level productType on every event
	FlushCount        int                              // default 50
	FlushInterval     time.Duration                    // default 5s
	HTTPClient        *http.Client                     // optional override
	CustomerExtractor func(ctx context.Context) string // default reads "x-customer-id" md
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

// New constructs a Billing instance and starts the background flush loop.
func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" || cfg.ServiceName == "" {
		return nil, errors.New("grpcmetering: TenantID, ProductID, APIKey, IngestorURL and ServiceName are required")
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
		cfg.CustomerExtractor = defaultCustomerExtractor
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

// UnaryInterceptor returns a grpc.UnaryServerInterceptor that meters every call.
func (b *Billing) UnaryInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		start := time.Now()
		ctx = withStatusHolder(ctx)
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
		ms := &meteredStream{ServerStream: ss, ctx: withStatusHolder(ss.Context())}
		err := handler(srv, ms)
		callType := "BIDI_STREAM"
		switch {
		case info.IsClientStream && !info.IsServerStream:
			callType = "CLIENT_STREAM"
		case !info.IsClientStream && info.IsServerStream:
			callType = "SERVER_STREAM"
		}
		b.recordRPC(ms.ctx, info.FullMethod, callType, err, 1, start)
		return err
	}
}

// Record manually emits a billing event. Use for streaming RPCs where you want exact
// message counts. The grpcStatusCode and executionStatus are auto-derived from err
// (see OutcomeFromGrpcCode); a status set with SetExecutionStatus on ctx wins.
// Optional EventOptions override the event's productType and executionStatus.
//
// A call with no customer id is not metered. An event the ingestor would
// refuse (blank method, a field over its limit) is not buffered: it is counted
// in DroppedCount(), WARN-logged and handed to OnDrop with DropInvalid. The
// method name is the exception: it originates from the incoming RPC, so one
// over 128 characters is truncated and the event is still sent.
func (b *Billing) Record(ctx context.Context, method, callType string, messageCount int, err error, durationMs int64, opts ...EventOptions) {
	b.record(ctx, method, callType, messageCount, err, durationMs, opts)
}

// RecordWithOptions is Record with optional per-event fields. A non-blank
// opts.ExecutionStatus wins over a status set with SetExecutionStatus, which
// wins over the status derived from err.
func (b *Billing) RecordWithOptions(ctx context.Context, method, callType string, messageCount int, err error, durationMs int64, opts EventOptions) {
	b.record(ctx, method, callType, messageCount, err, durationMs, []EventOptions{opts})
}

func (b *Billing) record(ctx context.Context, method, callType string, messageCount int, err error, durationMs int64, opts []EventOptions) {
	customerID := strings.TrimSpace(b.cfg.CustomerExtractor(ctx))
	if customerID == "" {
		return
	}
	statusLabel := "OK"
	executionStatus := OutcomeFromGrpcCode(codes.OK)
	if err != nil {
		st, ok := status.FromError(err)
		if !ok {
			// A handler returning a plain context error (e.g. ctx.Err()) is
			// sent to the client as CANCELLED / DEADLINE_EXCEEDED by grpc-go;
			// record the same code rather than UNKNOWN.
			st = status.FromContextError(err)
		}
		// The ingestor's grpcStatusCode enum uses UPPER_SNAKE names.
		statusLabel = statusCodeName(st.Code())
		executionStatus = OutcomeFromGrpcCode(st.Code())
	}
	if explicit := statusFromContext(ctx); explicit != "" {
		executionStatus = explicit
	}
	if explicit := normalizeExecutionStatus(executionStatusFor(opts)); explicit != "" {
		executionStatus = explicit
	}
	now := time.Now().UTC()
	// The key is built from the full method name, before truncation.
	key := idempotencyKeyFor(b.cfg.TenantID, b.cfg.ServiceName, method, now.UnixMilli(), randomSuffix())
	// The method name always originates from the incoming RPC (also when
	// integration code hands it to Record), so it is truncated to the
	// ingestor's limit instead of dropping the event.
	method = b.truncateLabel("grpcMethod", method, maxGrpcMethodLen)
	event := map[string]any{
		"customerId":          customerID,
		"metricName":          "grpc_api.rpc_calls",
		"quantity":            1,
		"occurredAt":          now.Format(time.RFC3339Nano),
		"idempotencyKey":      key,
		"productType":         b.productTypeFor(opts),
		"grpcService":         b.cfg.ServiceName,
		"grpcMethod":          method,
		"grpcStatusCode":      statusLabel,
		"messageCount":        messageCount,
		"executionDurationMs": durationMs,
		"executionStatus":     executionStatus,
		"metadata": map[string]any{
			"sdkVersion": sdkVersion,
			"productId":  b.cfg.ProductID,
		},
	}
	// grpcCallType is an enum on the ingestor; an unknown value rejects the
	// whole event, so omit it rather than send something outside the set.
	switch ct := strings.ToUpper(callType); ct {
	case "UNARY", "CLIENT_STREAM", "SERVER_STREAM", "BIDI_STREAM":
		event["grpcCallType"] = ct
	}
	// Required-field and limit guards: an event the ingestor would refuse is
	// dropped here (DropInvalid) instead of failing server-side unseen.
	msg := ""
	switch {
	case strings.TrimSpace(method) == "":
		msg = "grpcMethod is required for a GRPC_API event"
	case strings.TrimSpace(b.cfg.ServiceName) == "":
		msg = "grpcService is required for a GRPC_API event"
	default:
		for _, c := range []struct {
			field, value string
			max          int
		}{
			{"customerId", customerID, maxCustomerIDLen},
			{"grpcService", b.cfg.ServiceName, maxGrpcServiceLen},
			{"productType", event["productType"].(string), maxProductTypeLen},
		} {
			if msg = tooLong(c.field, c.value, c.max); msg != "" {
				break
			}
		}
	}
	if msg != "" {
		b.dropInvalid(event, msg)
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

func (b *Billing) recordRPC(ctx context.Context, fullMethod, callType string, err error, messageCount int, start time.Time) {
	method := fullMethod
	if i := strings.LastIndex(fullMethod, "/"); i >= 0 {
		method = fullMethod[i+1:]
	}
	b.record(ctx, method, callType, messageCount, err, time.Since(start).Milliseconds(), nil)
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

// Shutdown flushes pending events and stops the background goroutine.
func (b *Billing) Shutdown(ctx context.Context) error {
	b.stopOnce.Do(func() { close(b.stop) })
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

// statusCodeName maps a gRPC code to the ingestor's grpcStatusCode enum
// (canonical UPPER_SNAKE names). codes.Code.String() returns CamelCase
// ("InvalidArgument", "Canceled"), which the ingestor rejects.
func statusCodeName(c codes.Code) string {
	switch c {
	case codes.OK:
		return "OK"
	case codes.Canceled:
		return "CANCELLED"
	case codes.InvalidArgument:
		return "INVALID_ARGUMENT"
	case codes.DeadlineExceeded:
		return "DEADLINE_EXCEEDED"
	case codes.NotFound:
		return "NOT_FOUND"
	case codes.AlreadyExists:
		return "ALREADY_EXISTS"
	case codes.PermissionDenied:
		return "PERMISSION_DENIED"
	case codes.ResourceExhausted:
		return "RESOURCE_EXHAUSTED"
	case codes.FailedPrecondition:
		return "FAILED_PRECONDITION"
	case codes.Aborted:
		return "ABORTED"
	case codes.OutOfRange:
		return "OUT_OF_RANGE"
	case codes.Unimplemented:
		return "UNIMPLEMENTED"
	case codes.Internal:
		return "INTERNAL"
	case codes.Unavailable:
		return "UNAVAILABLE"
	case codes.DataLoss:
		return "DATA_LOSS"
	case codes.Unauthenticated:
		return "UNAUTHENTICATED"
	default:
		return "UNKNOWN"
	}
}

// idempotencyKeyFor returns "grpc:<tenant>:<service>:<method>:<millis>:<suffix>".
// method must be the full, untruncated method name; see boundedKey for what
// happens when the key would exceed 255 characters.
func idempotencyKeyFor(tenantID, serviceName, method string, millis int64, suffix string) string {
	return boundedKey(fmt.Sprintf("grpc:%s:%s:", tenantID, serviceName), method, fmt.Sprintf(":%d:%s", millis, suffix))
}

var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomSuffix() string {
	out := make([]byte, 8)
	for i := range out {
		out[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(out)
}
