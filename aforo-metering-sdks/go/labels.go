package metering

import (
	"log"
	"sync"
)

// truncateUTF16 cuts s to at most max UTF-16 code units — the unit the server's
// @Size counts (Java String.length()) — without splitting a character. A rune
// outside the BMP is two units (a surrogate pair); when only one unit of room
// is left the whole rune is left out, so the result may be max-1 units long.
func truncateUTF16(s string, max int) string {
	n := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if n+w > max {
			return s[:i] // i is a rune start, so no character is split
		}
		n += w
	}
	return s
}

// labelTruncator shortens labels the SDK derives from an incoming request to
// the ingestor's limit, so an over-long request is still metered. It logs one
// WARN per label name for its lifetime (one per middleware instance).
//
// Only for request-derived labels. Fields the SDK caller sets (CustomerID,
// MetricName, IdempotencyKey, ProductType, and any label passed to Track) are
// never shortened: checkFieldLimits drops those as invalid.
type labelTruncator struct {
	warned sync.Map
}

func (t *labelTruncator) truncate(label, value string, max int) string {
	if charLen(value) <= max {
		return value
	}
	if _, seen := t.warned.LoadOrStore(label, struct{}{}); !seen {
		log.Printf("[aforo] WARN: %s taken from the request exceeded the ingestor's limit and was truncated to %d characters; "+
			"the event is still sent. Logged once per label.", label, max)
	}
	return truncateUTF16(value, max)
}
