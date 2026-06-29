package metering

import (
	"regexp"
	"testing"
)

func TestGenerateIdempotencyKey_Deterministic(t *testing.T) {
	k1 := generateIdempotencyKey("cust_1", "api_calls", 1, "2026-03-21")
	k2 := generateIdempotencyKey("cust_1", "api_calls", 1, "2026-03-21")
	if k1 != k2 {
		t.Fatalf("expected deterministic keys, got %s != %s", k1, k2)
	}
}

func TestGenerateIdempotencyKey_DifferentInputs(t *testing.T) {
	k1 := generateIdempotencyKey("cust_1", "api_calls", 1, "2026-03-21")
	k2 := generateIdempotencyKey("cust_2", "api_calls", 1, "2026-03-21")
	if k1 == k2 {
		t.Fatal("expected different keys for different inputs")
	}
}

func TestGenerateIdempotencyKey_32HexChars(t *testing.T) {
	key := generateIdempotencyKey("cust_1", "metric", 5, "2026-01-01")
	if len(key) != 32 {
		t.Fatalf("expected 32 chars, got %d", len(key))
	}
	matched, _ := regexp.MatchString(`^[0-9a-f]{32}$`, key)
	if !matched {
		t.Fatalf("expected hex string, got %s", key)
	}
}

func TestGenerateRandomKey_Unique(t *testing.T) {
	k1 := generateRandomKey()
	k2 := generateRandomKey()
	if k1 == k2 {
		t.Fatal("expected unique random keys")
	}
}
