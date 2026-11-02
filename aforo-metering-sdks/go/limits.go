package metering

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Client-side mirror of the ingestor's per-event field constraints.
//
// Source: dto/IngestUsageEventRequest in aforo-nextgen-usage-ingestor-service —
// the @Size and @Digits bean constraints, which are compiled into the server and
// therefore identical in every environment.
//
// Deliberately NOT mirrored: the timestamp window (max-age-days,
// future-tolerance-minutes) and the metadata cap (max-metadata-bytes) from
// validation/UsageEventValidator. Each is a per-environment property — a tenant
// may raise max-age-days to 365 for backfills — so enforcing the default here
// would make the SDK refuse usage its own server would accept and bill.
//
// Nothing here truncates or rounds: that would change what is billed. The one
// exception lives in the HTTP middleware (labels.go): endpointPath and
// httpMethod, which it reads from the incoming request, are truncated to these
// limits before Track is called, so an over-long request is still metered.
const (
	maxCustomerIDLen     = 64
	maxMetricNameLen     = 255
	maxIdempotencyKeyLen = 255
	maxProductTypeLen    = 20
	maxEndpointPathLen   = 512
	maxHTTPMethodLen     = 16

	// @Digits(integer = 14, fraction = 6) — usage_events.quantity is NUMERIC(20,6).
	maxQuantityIntegerDigits = 14
	maxQuantityDecimalPlaces = 6
)

// charLen counts UTF-16 code units, which is what the server's @Size counts
// (Java String.length()). Counting bytes would refuse multi-byte values the
// ingestor accepts.
func charLen(value string) int {
	n := 0
	for _, r := range value {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func lengthErr(field, value string, max int) error {
	n := charLen(value)
	if n <= max {
		return nil
	}
	return fmt.Errorf("%w: %s is %d characters, exceeding the ingestor's %d-character limit "+
		"(value %q); shorten it — the SDK will not truncate it, because a truncated id bills the wrong thing",
		ErrInvalidEvent, field, n, max, truncateForLog(value))
}

// quantityErr counts digits as the server's BigDecimal will, working from the
// serialized text so the check matches what actually goes on the wire.
func quantityErr(quantity float64) error {
	serialized := strconv.FormatFloat(quantity, 'f', -1, 64)
	if math.IsNaN(quantity) || math.IsInf(quantity, 0) {
		return nil // reported by the caller's own quantity check
	}
	intPart, fracPart, _ := strings.Cut(strings.TrimLeft(serialized, "-+"), ".")
	intPart = strings.TrimLeft(intPart, "0")
	if len(intPart) > maxQuantityIntegerDigits {
		return fmt.Errorf("%w: Quantity %s has %d integer digits, exceeding the ingestor's limit "+
			"of %d (usage_events.quantity is NUMERIC(20,6))",
			ErrInvalidEvent, serialized, len(intPart), maxQuantityIntegerDigits)
	}
	if len(fracPart) > maxQuantityDecimalPlaces {
		return fmt.Errorf("%w: Quantity %s has %d decimal places, exceeding the ingestor's limit "+
			"of %d; round it yourself before tracking — the SDK will not round it, because that "+
			"would change the quantity you are billed for",
			ErrInvalidEvent, serialized, len(fracPart), maxQuantityDecimalPlaces)
	}
	return nil
}

// checkFieldLimits reports the first ingestor field constraint the event breaks.
func checkFieldLimits(event *TrackEvent) error {
	for _, check := range []struct {
		field string
		value string
		max   int
	}{
		{"CustomerID", event.CustomerID, maxCustomerIDLen},
		{"MetricName", event.MetricName, maxMetricNameLen},
		{"IdempotencyKey", event.IdempotencyKey, maxIdempotencyKeyLen},
		{"ProductType", strings.TrimSpace(event.ProductType), maxProductTypeLen},
		{"EndpointPath", event.EndpointPath, maxEndpointPathLen},
		{"HTTPMethod", event.HTTPMethod, maxHTTPMethodLen},
	} {
		if err := lengthErr(check.field, check.value, check.max); err != nil {
			return err
		}
	}
	return quantityErr(event.Quantity)
}
