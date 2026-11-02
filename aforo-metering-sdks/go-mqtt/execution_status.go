package mqttmetering

import (
	"log"
	"strings"
	"sync/atomic"
)

// EventOptions carries optional per-event fields for the Record*WithOptions
// methods.
type EventOptions struct {
	// ExecutionStatus is the optional outcome, used by OUTCOME_BASED pricing
	// (each event bills at the weight set for its status; events without a
	// status bill at full price). Trimmed and upper-cased by the SDK; blank is
	// treated as absent and omitted from the wire body. Accepted values:
	// SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED, FAILURE,
	// CANCELLED, PENDING, BLOCKED, HITL_REQUIRED (max 20 chars). Any other value
	// is WARN-logged and omitted (the rest of the event is still sent), since
	// the ingestor would reject the event.
	//
	// The SDK never derives a status for MQTT events (the recording methods
	// carry no success or failure signal), so it is only sent when you set it.
	ExecutionStatus string

	// ProductType overrides Config.ProductType for this event. It is trimmed
	// and upper-cased; unknown values are passed through unchanged.
	ProductType string
}

// withExecutionStatus sets executionStatus on event when status is non-blank.
func withExecutionStatus(event map[string]any, status string) map[string]any {
	if event == nil {
		return nil
	}
	if s := normalizeExecutionStatus(status); s != "" {
		event["executionStatus"] = s
	}
	return event
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
		log.Printf("[mqttmetering] WARN: unknown executionStatus %q omitted from event (%d total). Accepted: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED.", truncateForLog(value), n)
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
