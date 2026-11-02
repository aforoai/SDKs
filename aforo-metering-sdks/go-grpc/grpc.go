// Package grpcmetering ships per-RPC billing events from a Go gRPC server
// to Aforo's usage ingestor.
//
// Usage:
//
//	billing, err := grpcmetering.New(grpcmetering.Config{
//	    TenantID:    "tenant_acme",
//	    ProductID:   "prod_grpc_user_svc",
//	    APIKey:      os.Getenv("AFORO_API_KEY"),
//	    IngestorURL: "https://api.aforo.ai",
//	    ServiceName: "acme.v1.UserService",
//	    // The customer your auth interceptor put on the context.
//	    CustomerResolver: func(ctx context.Context) string { return auth.CustomerID(ctx) },
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
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc/v2/internal/ingest"
)

const sdkVersion = "2.1.0"

// Ingestor limits for the gRPC fields (IngestUsageEventRequest @Size).
const (
	maxGrpcServiceLen = 255
	maxGrpcMethodLen  = 128
)

// DefaultCustomerMetadataKey is the incoming metadata key read for the
// customer id when Config.TrustCustomerHeader is true.
const DefaultCustomerMetadataKey = "x-customer-id"

// ErrNoCustomerResolver is returned by New when Config has neither a
// CustomerResolver nor TrustCustomerHeader.
var ErrNoCustomerResolver = errors.New("grpcmetering: Config needs a CustomerResolver (the Aforo customer id from your own authentication: auth token subject, API-key lookup, mTLS identity) or TrustCustomerHeader: true to bill the customer named in incoming metadata, which your callers control")

// Config captures all SDK options. Sending defaults follow the shared
// transport policy (contract/ingest-contract.json → transportPolicy).
type Config struct {
	TenantID    string
	ProductID   string
	APIKey      string // sent only as X-API-Key; never logged or printed
	IngestorURL string // must be https (http only for localhost or with AllowInsecureHTTP)
	ServiceName string // fully-qualified gRPC service, e.g. "acme.v1.UserService"
	ProductType string // default "GRPC_API"; sent as top-level productType on every event

	// CustomerResolver returns the Aforo customer id for a call, from identity
	// your server authenticated (auth interceptor, token subject, mTLS peer).
	// Required unless TrustCustomerHeader is true. A blank result is not
	// billed: the event is dropped as DropInvalid and counted; the RPC itself
	// is never affected.
	CustomerResolver func(ctx context.Context) string
	// TrustCustomerHeader bills the customer named in the incoming metadata
	// key CustomerMetadataKey. Callers control metadata, so only turn this on
	// when a trusted proxy sets it and strips client values. Ignored when
	// CustomerResolver is set.
	TrustCustomerHeader bool
	// CustomerMetadataKey defaults to DefaultCustomerMetadataKey.
	CustomerMetadataKey string

	AllowInsecureHTTP bool          // allow http:// to a host other than localhost/127.0.0.1/::1
	Compression       string        // "gzip" (default; 1 KiB+ batches gzip-encoded, needs usage-ingestor wave 8+) or "none"
	FlushCount        int           // events per request, default 500 (max 1000)
	FlushInterval     time.Duration // default 5s
	MaxQueueSize      int           // default 10000; when full the oldest event is dropped (DropOverflow)
	MaxRetries        int           // default 3; negative disables retries
	RetryBase         time.Duration // full-jitter backoff base, default 500ms
	Timeout           time.Duration // total deadline per request, default 10s
	ShutdownTimeout   time.Duration // how long Shutdown keeps sending, default 5s

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
	cfg      Config
	tp       *ingest.Client
	customer func(ctx context.Context) string
	// truncWarned holds the label names already WARN-logged as truncated.
	truncWarned sync.Map
}

// New constructs a Billing instance and starts the background sender. It
// returns ErrNoCustomerResolver when Config has neither CustomerResolver nor
// TrustCustomerHeader, and an error for a non-https IngestorURL.
func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" || cfg.ServiceName == "" {
		return nil, errors.New("grpcmetering: TenantID, ProductID, APIKey, IngestorURL and ServiceName are required")
	}
	customer := cfg.CustomerResolver
	if customer == nil {
		if !cfg.TrustCustomerHeader {
			return nil, ErrNoCustomerResolver
		}
		key := strings.ToLower(strings.TrimSpace(cfg.CustomerMetadataKey))
		if key == "" {
			key = DefaultCustomerMetadataKey
		}
		customer = func(ctx context.Context) string { return metadataCustomer(ctx, key) }
	}
	cfg.ProductType = normalizeProductType(cfg.ProductType)
	if cfg.ProductType == "" {
		cfg.ProductType = DefaultProductType
	}
	if cfg.OnError == nil {
		cfg.OnError = func(err error) {}
	}
	tp, err := newTransport(cfg)
	if err != nil {
		return nil, err
	}
	return &Billing{cfg: cfg, tp: tp, customer: customer}, nil
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
// Each stream emits one event on completion. Its messageCount is the number of
// messages the stream actually carried (received + sent); metadata adds
// messagesReceived and messagesSent.
func (b *Billing) StreamInterceptor() grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		start := time.Now()
		ms := &meteredStream{ServerStream: ss, ctx: withStatusHolder(ss.Context())}
		err := handler(srv, ms)
		received, sent := ms.received.Load(), ms.sent.Load()
		callType := "BIDI_STREAM"
		switch {
		case info.IsClientStream && !info.IsServerStream:
			callType = "CLIENT_STREAM"
		case !info.IsClientStream && info.IsServerStream:
			callType = "SERVER_STREAM"
		}
		b.recordRPCCounts(ms.ctx, info.FullMethod, callType, err, int(received+sent), start,
			map[string]any{"messagesReceived": received, "messagesSent": sent})
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
	b.recordWithMeta(ctx, method, callType, messageCount, err, durationMs, opts, nil)
}

func (b *Billing) recordWithMeta(ctx context.Context, method, callType string, messageCount int, err error, durationMs int64, opts []EventOptions, extraMeta map[string]any) {
	customerID := strings.TrimSpace(b.customer(ctx))
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
	for k, v := range extraMeta {
		event["metadata"].(map[string]any)[k] = v
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
	case customerID == "":
		// Not billed, but counted: a call without a resolved customer.
		msg = "customerId is required (CustomerResolver returned nothing)"
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
	b.push(event)
}

func (b *Billing) recordRPC(ctx context.Context, fullMethod, callType string, err error, messageCount int, start time.Time) {
	b.recordRPCCounts(ctx, fullMethod, callType, err, messageCount, start, nil)
}

func (b *Billing) recordRPCCounts(ctx context.Context, fullMethod, callType string, err error, messageCount int, start time.Time, meta map[string]any) {
	method := fullMethod
	if i := strings.LastIndex(fullMethod, "/"); i >= 0 {
		method = fullMethod[i+1:]
	}
	b.recordWithMeta(ctx, method, callType, messageCount, err, time.Since(start).Milliseconds(), nil, meta)
}

// Shutdown sends what is queued until the earlier of ctx's deadline and
// Config.ShutdownTimeout. Events still queued then are reported as
// DropShutdown and Shutdown returns an error wrapping ErrShutdownIncomplete.
// Safe to call more than once.
func (b *Billing) Shutdown(ctx context.Context) error {
	return b.shutdownTransport(ctx)
}

// metadataCustomer reads key from the incoming metadata (TrustCustomerHeader).
func metadataCustomer(ctx context.Context, key string) string {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	if v := md.Get(key); len(v) > 0 {
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
