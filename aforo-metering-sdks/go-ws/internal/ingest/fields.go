package ingest

import (
	"math"
	"sort"
)

// intFieldBits lists the event fields the ingestor binds to a Java short (16)
// or int (32) (dto/IngestUsageEventRequest). Jackson refuses a number that
// does not fit, and that refusal fails the WHOLE request body with 400, so one
// such value would lose every event batched with it. dataBytes is a Java long
// and is not listed.
var intFieldBits = map[string]uint{
	"statusCode":          16,
	"mqttQos":             16,
	"stepNumber":          32,
	"executionDurationMs": 32,
	"messageCount":        32,
	"gqlComplexity":       32,
	"gqlFieldCount":       32,
	"responseTimeMs":      32,
	"rateLimitRpm":        32,
	"rateLimitRpd":        32,
}

// IntFits reports whether v fits the ingestor's type for field. Fields not in
// the table always fit.
func IntFits(field string, v int64) bool {
	bits, ok := intFieldBits[field]
	if !ok {
		return true
	}
	limit := int64(1) << (bits - 1)
	return v >= -limit && v < limit
}

// FitInt reports whether v fits the ingestor's type for field. When it does
// not, the caller leaves the field off the event: FitInt logs one WARN per
// field name for the client's lifetime.
func (c *Client) FitInt(field string, v int64) bool {
	if IntFits(field, v) {
		return true
	}
	c.warnOutOfRange(field, v)
	return false
}

// FitIntFields removes from event every integer field whose value does not fit
// the ingestor's type (see FitInt) and returns the removed names. The rest of
// the event is kept.
func (c *Client) FitIntFields(event map[string]any) []string {
	var removed []string
	for field := range intFieldBits {
		raw, ok := event[field]
		if !ok {
			continue
		}
		v, isInt := asInt64(raw)
		if !isInt {
			continue
		}
		if !c.FitInt(field, v) {
			delete(event, field)
			removed = append(removed, field)
		}
	}
	sort.Strings(removed)
	return removed
}

func (c *Client) warnOutOfRange(field string, v int64) {
	if _, seen := c.rangeWarned.LoadOrStore(field, struct{}{}); !seen {
		c.logf("WARN: %s %d does not fit the ingestor's %d-bit field; it is left off the event and the event is still sent. Logged once per field.", field, v, intFieldBits[field])
	}
}

// asInt64 reads an integer-valued JSON number held in a map. A value out of
// int64 range reads as the nearest bound, which never fits a listed field.
func asInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int:
		return int64(n), true
	case int8:
		return int64(n), true
	case int16:
		return int64(n), true
	case int32:
		return int64(n), true
	case int64:
		return n, true
	case uint:
		return clampU64(uint64(n)), true
	case uint8:
		return int64(n), true
	case uint16:
		return int64(n), true
	case uint32:
		return int64(n), true
	case uint64:
		return clampU64(n), true
	case float32:
		return clampF64(float64(n))
	case float64:
		return clampF64(n)
	}
	return 0, false
}

func clampU64(n uint64) int64 {
	if n > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(n)
}

func clampF64(f float64) (int64, bool) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	if f >= math.MaxInt64 {
		return math.MaxInt64, true
	}
	if f <= math.MinInt64 {
		return math.MinInt64, true
	}
	return int64(f), true
}
