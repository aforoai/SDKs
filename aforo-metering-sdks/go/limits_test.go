package metering

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// The ingestor's compiled-in field limits, enforced before an event is buffered.
// An event that breaks one is rejected server-side and never billed; since the
// SDK flushes in the background, that rejection reaches nobody.

func testClient(t *testing.T) *AforoClient {
	t.Helper()
	// A closed port: these tests assert on what Track accepts, and no flush
	// should ever reach a real ingestor.
	c := NewClient(Options{
		APIKey:        "sk_test_limits",
		BaseURL:       "http://127.0.0.1:1",
		FlushCount:    1000000,
		FlushInterval: time.Hour,
		RetryBase:     time.Millisecond,
	})
	t.Cleanup(func() { c.Close() })
	return c
}

func validEvent() TrackEvent {
	return TrackEvent{CustomerID: "cust_1", MetricName: "api_calls", Quantity: 1}
}

func TestStringLengthLimits(t *testing.T) {
	cases := []struct {
		field string
		max   int
		set   func(*TrackEvent, string)
	}{
		{"CustomerID", 64, func(e *TrackEvent, v string) { e.CustomerID = v }},
		{"MetricName", 255, func(e *TrackEvent, v string) { e.MetricName = v }},
		{"IdempotencyKey", 255, func(e *TrackEvent, v string) { e.IdempotencyKey = v }},
	}
	for _, tc := range cases {
		t.Run(tc.field, func(t *testing.T) {
			c := testClient(t)

			atLimit := validEvent()
			tc.set(&atLimit, strings.Repeat("x", tc.max))
			if err := c.Track(atLimit); err != nil {
				t.Fatalf("event at the limit should be accepted, got %v", err)
			}

			over := validEvent()
			tc.set(&over, strings.Repeat("x", tc.max+1))
			err := c.Track(over)
			if !errors.Is(err, ErrInvalidEvent) {
				t.Fatalf("event over the limit should be rejected, got %v", err)
			}
			if !strings.Contains(err.Error(), tc.field) {
				t.Errorf("error should name the field, got %q", err)
			}
		})
	}
}

func TestQuantityDigitLimits(t *testing.T) {
	c := testClient(t)

	if err := c.Track(TrackEvent{CustomerID: "c", MetricName: "m", Quantity: 1.123456}); err != nil {
		t.Fatalf("6 decimal places is the limit and should be accepted, got %v", err)
	}
	// Rounding would silently change what the customer is billed, so it is rejected.
	if err := c.Track(TrackEvent{CustomerID: "c", MetricName: "m", Quantity: 1.1234567}); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("7 decimal places should be rejected, got %v", err)
	}
	if err := c.Track(TrackEvent{CustomerID: "c", MetricName: "m", Quantity: 1e15}); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("15 integer digits should be rejected, got %v", err)
	}
}

func TestServerConfigurableLimitsAreLeftToTheServer(t *testing.T) {
	// max-age-days and max-metadata-bytes are per-environment properties;
	// enforcing their defaults here would refuse usage a deployment configured
	// differently would accept and bill.
	c := testClient(t)
	old := validEvent()
	old.OccurredAt = "2020-01-01T00:00:00Z"
	if err := c.Track(old); err != nil {
		t.Fatalf("an old timestamp is the server's call, got %v", err)
	}
	big := validEvent()
	big.Metadata = map[string]interface{}{"blob": strings.Repeat("x", 20000)}
	if err := c.Track(big); err != nil {
		t.Fatalf("large metadata is the server's call, got %v", err)
	}
}

// The server's @Size counts characters, not bytes: a 64-character multi-byte
// customer id is 128 bytes and must still be accepted.
func TestLengthLimitsCountCharactersNotBytes(t *testing.T) {
	c := testClient(t)
	ev := validEvent()
	ev.CustomerID = strings.Repeat("é", 64)
	if err := c.Track(ev); err != nil {
		t.Fatalf("64 multi-byte characters should be accepted, got %v", err)
	}
	ev.CustomerID = strings.Repeat("é", 65)
	if err := c.Track(ev); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("65 characters should be rejected, got %v", err)
	}
}

// An over-limit event follows the drop-observability shape as well as
// returning ErrInvalidEvent.
func TestOverLimitEventIsCountedAndHandedToOnDrop(t *testing.T) {
	var got []DropReason
	c := NewClient(Options{
		APIKey: "sk_test_limits", BaseURL: "http://127.0.0.1:1",
		FlushInterval: time.Hour, RetryBase: time.Millisecond,
		OnDrop: func(_ []TrackEvent, r DropReason) { got = append(got, r) },
	})
	t.Cleanup(func() { c.Close() })
	over := validEvent()
	over.MetricName = strings.Repeat("m", 256)
	if err := c.Track(over); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("want ErrInvalidEvent, got %v", err)
	}
	if c.DroppedCount() != 1 || c.BufferedCount() != 0 {
		t.Errorf("DroppedCount=%d BufferedCount=%d, want 1 and 0", c.DroppedCount(), c.BufferedCount())
	}
	if len(got) != 1 || got[0] != DropInvalid {
		t.Errorf("OnDrop reasons = %v, want [invalid]", got)
	}
}
