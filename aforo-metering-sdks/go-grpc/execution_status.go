package grpcmetering

import (
	"context"
	"log"
	"strings"
	"sync"
	"sync/atomic"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
)

// EventOptions carries optional per-event fields for RecordWithOptions.
type EventOptions struct {
	// ExecutionStatus is the optional outcome of the request, used by
	// OUTCOME_BASED pricing (each event bills at the weight set for its status;
	// events without a status bill at full price). Trimmed and upper-cased by
	// the SDK; blank is treated as absent. When set it wins over the value
	// derived from the gRPC status code. Accepted values: SUCCESS, PARTIAL,
	// TIMEOUT, ERROR, VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING,
	// BLOCKED, HITL_REQUIRED (max 20 chars). Any other value is WARN-logged and
	// ignored (the status derived from the gRPC code is sent instead), since the
	// ingestor would reject the event.
	ExecutionStatus string

	// ProductType overrides Config.ProductType for this event. It is trimmed
	// and upper-cased; unknown values are passed through unchanged.
	ProductType string
}

// OutcomeFromGrpcCode maps a gRPC status code to an execution status, using
// the same table as the Aforo gateway plugins:
//
//	OK                                              → SUCCESS
//	Canceled                                        → CANCELLED
//	InvalidArgument, FailedPrecondition, OutOfRange → VALIDATION_FAILED
//	DeadlineExceeded                                → TIMEOUT
//	PermissionDenied, ResourceExhausted, Unauthenticated → BLOCKED
//	anything else                                   → ERROR
func OutcomeFromGrpcCode(code codes.Code) string {
	switch code {
	case codes.OK:
		return "SUCCESS"
	case codes.Canceled:
		return "CANCELLED"
	case codes.InvalidArgument, codes.FailedPrecondition, codes.OutOfRange:
		return "VALIDATION_FAILED"
	case codes.DeadlineExceeded:
		return "TIMEOUT"
	case codes.PermissionDenied, codes.ResourceExhausted, codes.Unauthenticated:
		return "BLOCKED"
	default:
		return "ERROR"
	}
}

// SetExecutionStatus overrides the execution status the interceptor records
// for the RPC whose context is ctx. Call it from inside a handler served
// through UnaryInterceptor or StreamInterceptor. It returns false (and does
// nothing) when ctx is not a metered RPC context. A blank value clears an
// earlier override, so the status falls back to the one derived from the
// handler's error.
func SetExecutionStatus(ctx context.Context, status string) bool {
	h, ok := ctx.Value(statusHolderKey{}).(*statusHolder)
	if !ok {
		return false
	}
	h.mu.Lock()
	h.value = normalizeExecutionStatus(status)
	h.mu.Unlock()
	return true
}

type statusHolderKey struct{}

type statusHolder struct {
	mu    sync.Mutex
	value string
}

func withStatusHolder(ctx context.Context) context.Context {
	return context.WithValue(ctx, statusHolderKey{}, &statusHolder{})
}

func statusFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	h, ok := ctx.Value(statusHolderKey{}).(*statusHolder)
	if !ok {
		return ""
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.value
}

// meteredStream exposes the status-holder context to streaming handlers.
type meteredStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (s *meteredStream) Context() context.Context { return s.ctx }

// maxExecutionStatusLength mirrors the ingest contract's maxLength for
// executionStatus.
const maxExecutionStatusLength = 20

// canonicalExecutionStatuses is the ingest contract's executionStatus set
// (contract/ingest-contract.json). Any other value makes the ingestor reject
// the event, so the SDK leaves the status off and keeps the event.
var canonicalExecutionStatuses = map[string]struct{}{
	"SUCCESS": {}, "PARTIAL": {}, "TIMEOUT": {}, "ERROR": {},
	"VALIDATION_FAILED": {}, "FAILED": {}, "FAILURE": {}, "CANCELLED": {},
	"PENDING": {}, "BLOCKED": {}, "HITL_REQUIRED": {},
}

// invalidExecutionStatuses counts unknown values dropped by
// normalizeExecutionStatus; it throttles the WARN log.
var invalidExecutionStatuses atomic.Int64

// normalizeExecutionStatus trims and upper-cases a status; blank becomes "".
// A value outside the canonical set (or longer than 20 chars) is WARN-logged
// and also becomes "", so the field is omitted and the rest of the event (and
// its batch) still reaches the ingestor.
func normalizeExecutionStatus(value string) string {
	s := strings.ToUpper(strings.TrimSpace(value))
	if s == "" {
		return ""
	}
	if _, ok := canonicalExecutionStatuses[s]; ok && len(s) <= maxExecutionStatusLength {
		return s
	}
	// Throttled (first, then every 1000th) so a misconfigured caller can't
	// storm the log.
	if n := invalidExecutionStatuses.Add(1); n == 1 || n%1000 == 0 {
		log.Printf("[grpcmetering] WARN: unknown executionStatus %q omitted from event (%d total). Accepted: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED.", truncateForLog(value), n)
	}
	return ""
}

// truncateForLog bounds a caller-supplied value before it is logged.
func truncateForLog(value string) string {
	const limit = 64
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}
