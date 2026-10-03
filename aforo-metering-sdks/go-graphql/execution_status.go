package graphqlmetering

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"sync/atomic"
)

// EventOptions carries optional per-event fields for RecordWithOptions.
type EventOptions struct {
	// ExecutionStatus is the optional outcome of the operation, used by
	// OUTCOME_BASED pricing (each event bills at the weight set for its status;
	// events without a status bill at full price). Trimmed and upper-cased by
	// the SDK; blank is treated as absent and omitted from the wire body.
	// Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED,
	// FAILED, FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED (max 20
	// chars). Any other value is WARN-logged and omitted (the rest of the event
	// is still sent), since the ingestor would reject the event.
	ExecutionStatus string

	// ProductType overrides Config.ProductType for this event. It is trimmed
	// and upper-cased; unknown values are passed through unchanged.
	ProductType string
}

// OutcomeFromGraphQLResponse derives an execution status from a GraphQL
// response body:
//
//	no errors (absent, null or [])       → SUCCESS
//	errors and non-null data             → PARTIAL
//	errors and "data" present but null   → ERROR (failed during execution)
//	errors and no "data" key             → VALIDATION_FAILED (failed before
//	                                       execution: parse/validation errors)
//
// It returns "" when the body is not a single GraphQL response object
// (not JSON, a batched array, or neither "data" nor "errors" present).
func OutcomeFromGraphQLResponse(body []byte) string {
	var resp map[string]json.RawMessage
	if err := json.Unmarshal(body, &resp); err != nil || resp == nil {
		return ""
	}
	errs, hasErrors := resp["errors"]
	data, hasData := resp["data"]
	if !hasErrors && !hasData {
		return ""
	}
	if !hasErrors || isJSONNullOrEmptyArray(errs) {
		return "SUCCESS"
	}
	if !hasData {
		return "VALIDATION_FAILED"
	}
	if !isJSONNull(data) {
		return "PARTIAL"
	}
	return "ERROR"
}

// OutcomeFromHTTPStatus derives an execution status from the HTTP status of
// a GraphQL response when the body is not available:
//
//	2xx, 3xx      → SUCCESS
//	408, 504      → TIMEOUT
//	499           → CANCELLED
//	400, 422      → VALIDATION_FAILED
//	401, 403, 429 → BLOCKED
//	other 4xx/5xx → ERROR
//
// It returns "" for anything else (e.g. 1xx), so the key is omitted.
func OutcomeFromHTTPStatus(code int) string {
	switch {
	case code >= 200 && code < 400:
		return "SUCCESS"
	case code == 408 || code == 504:
		return "TIMEOUT"
	case code == 499:
		return "CANCELLED"
	case code == 400 || code == 422:
		return "VALIDATION_FAILED"
	case code == 401 || code == 403 || code == 429:
		return "BLOCKED"
	case code >= 400 && code < 600:
		return "ERROR"
	default:
		return ""
	}
}

// SetExecutionStatus overrides the execution status the Middleware records
// for the request whose context is ctx (use r.Context() inside your GraphQL
// handler). It returns false (and does nothing) when ctx is not a metered
// request context. A blank value clears an earlier override.
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

func (h *statusHolder) get() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.value
}

func isJSONNull(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null"
}

func isJSONNullOrEmptyArray(raw json.RawMessage) bool {
	if isJSONNull(raw) {
		return true
	}
	var arr []json.RawMessage
	return json.Unmarshal(raw, &arr) == nil && len(arr) == 0
}

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
		log.Printf("[graphqlmetering] WARN: unknown executionStatus %q omitted from event (%d total). Accepted: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED.", truncateForLog(value), n)
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
