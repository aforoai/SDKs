package metering

import (
	"net/http/httptest"
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

// Documents WHY generateIdempotencyKey is no longer the Track default: hashing
// the event fields makes two genuinely distinct events that share a timestamp
// collide, and the ingestor answers DUPLICATE and drops the second one.
func TestGenerateIdempotencyKey_CollidesOnSameTimestamp(t *testing.T) {
	sameMs := "2026-03-21T00:00:00.000Z"
	if generateIdempotencyKey("cust_1", "sms.sent", 1, sameMs) !=
		generateIdempotencyKey("cust_1", "sms.sent", 1, sameMs) {
		t.Fatal("expected the deterministic helper to collide — that is the bug it caused")
	}
}

// Regression: two Track calls for the same customer/metric/quantity AND the
// exact same OccurredAt are two distinct billable events and must get two
// distinct keys, or the ingestor silently drops the second (under-billing).
func TestTrack_SameInstantEventsGetDistinctKeys(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	client := newTestClient(t, ts.URL)
	defer client.Close()

	const sameInstant = "2026-03-21T00:00:00.000Z"
	for i := 0; i < 2; i++ {
		if err := client.Track(TrackEvent{
			CustomerID: "cust_1",
			MetricName: "sms.sent",
			Quantity:   1,
			OccurredAt: sameInstant,
		}); err != nil {
			t.Fatalf("Track: %v", err)
		}
	}
	client.Flush()

	evs := srv.events()
	if len(evs) != 2 {
		t.Fatalf("expected 2 events, got %d", len(evs))
	}
	if evs[0]["occurredAt"] != evs[1]["occurredAt"] {
		t.Fatalf("expected identical occurredAt, got %v / %v", evs[0]["occurredAt"], evs[1]["occurredAt"])
	}
	if evs[0]["idempotencyKey"] == evs[1]["idempotencyKey"] {
		t.Fatalf("two distinct events shared idempotency key %v — the ingestor would drop one", evs[0]["idempotencyKey"])
	}
}

// An explicit key is how a caller opts INTO dedup — it must survive verbatim.
func TestTrack_ExplicitKeyPreservedVerbatim(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	client := newTestClient(t, ts.URL)
	defer client.Close()

	for i := 0; i < 2; i++ {
		if err := client.Track(TrackEvent{
			CustomerID:     "cust_1",
			MetricName:     "sms.sent",
			Quantity:       1,
			OccurredAt:     "2026-03-21T00:00:00.000Z",
			IdempotencyKey: "caller-owned-key",
		}); err != nil {
			t.Fatalf("Track: %v", err)
		}
	}
	client.Flush()

	for i, ev := range srv.events() {
		if ev["idempotencyKey"] != "caller-owned-key" {
			t.Fatalf("event %d: expected caller-owned-key, got %v", i, ev["idempotencyKey"])
		}
	}
}
