package graphqlmetering

import (
	"crypto/sha256"
	"encoding/hex"
	"log"
)

// maxIdempotencyKeyLen is the ingestor's limit for idempotencyKey.
const maxIdempotencyKeyLen = 255

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

// truncateLabel shortens a label the SDK took from the incoming request to the
// ingestor's limit, so an over-long request is still metered. One WARN is
// logged per label name for the lifetime of this Billing.
//
// Only for protocol labels, which originate from the consumer's request or
// message. customerId, productType and config values are never shortened:
// over the limit the event is dropped with DropInvalid.
func (b *Billing) truncateLabel(label, value string, max int) string {
	if charLen(value) <= max {
		return value
	}
	if _, seen := b.truncWarned.LoadOrStore(label, struct{}{}); !seen {
		log.Printf("[graphqlmetering] WARN: %s taken from the request exceeded the ingestor's limit and was truncated to %d characters; "+
			"the event is still sent. Logged once per label.", label, max)
	}
	return truncateUTF16(value, max)
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// boundedKey builds head+component+tail as the idempotency key. A key within
// the ingestor's 255-character limit is returned unchanged. A longer one is
// never cut: the over-long component is replaced by the SHA-256 hex digest of
// its full text, so the same input always gives the same key and two inputs
// that differ anywhere give different keys. If the key is still too long (an
// over-long head), head and component are digested together. The tail (the
// millisecond timestamp and random suffix) is always kept as is.
//
// The component passed in must be the full value, before any label truncation.
func boundedKey(head, component, tail string) string {
	if k := head + component + tail; charLen(k) <= maxIdempotencyKeyLen {
		return k
	}
	if k := head + sha256Hex(component) + tail; charLen(k) <= maxIdempotencyKeyLen {
		return k
	}
	return sha256Hex(head+component) + tail
}
