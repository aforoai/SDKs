package metering

import (
	"crypto/rand"
	"crypto/sha256"
	"fmt"
)

// generateIdempotencyKey produces a deterministic SHA-256 key (32 hex chars).
func generateIdempotencyKey(customerID, metricName string, quantity float64, occurredAt string) string {
	data := fmt.Sprintf("%s:%s:%v:%s", customerID, metricName, quantity, occurredAt)
	hash := sha256.Sum256([]byte(data))
	return fmt.Sprintf("%x", hash)[:32]
}

// generateRandomKey produces a random UUID v4 (no external deps).
func generateRandomKey() string {
	var uuid [16]byte
	_, _ = rand.Read(uuid[:])
	uuid[6] = (uuid[6] & 0x0f) | 0x40 // version 4
	uuid[8] = (uuid[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", uuid[0:4], uuid[4:6], uuid[6:8], uuid[8:10], uuid[10:16])
}
