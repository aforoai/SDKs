package metering

import "testing"

func makeEvent(n int) resolvedEvent {
	return resolvedEvent{
		CustomerID:     "cust_" + string(rune('0'+n)),
		MetricName:     "api_calls",
		Quantity:       1,
		IdempotencyKey: "key",
		OccurredAt:     "2026-03-21T00:00:00Z",
	}
}

func TestRingBuffer_PushAndDrain(t *testing.T) {
	buf := newRingBuffer(10)
	buf.push(makeEvent(1))
	buf.push(makeEvent(2))
	buf.push(makeEvent(3))

	if buf.size() != 3 {
		t.Fatalf("expected size 3, got %d", buf.size())
	}

	items := buf.drain()
	if len(items) != 3 {
		t.Fatalf("expected 3 items, got %d", len(items))
	}
	if buf.size() != 0 {
		t.Fatalf("expected empty after drain, got %d", buf.size())
	}
}

func TestRingBuffer_Overflow(t *testing.T) {
	buf := newRingBuffer(3)
	buf.push(makeEvent(1))
	buf.push(makeEvent(2))
	buf.push(makeEvent(3))

	ok := buf.push(makeEvent(4))
	if ok {
		t.Fatal("expected overflow (false), got true")
	}
	if buf.size() != 3 {
		t.Fatalf("expected size 3 after overflow, got %d", buf.size())
	}

	items := buf.drain()
	if items[0].CustomerID != "cust_2" {
		t.Fatalf("expected oldest dropped, got %s", items[0].CustomerID)
	}
}

func TestRingBuffer_DrainUpTo(t *testing.T) {
	buf := newRingBuffer(100)
	for i := 0; i < 10; i++ {
		buf.push(makeEvent(i))
	}

	batch := buf.drainUpTo(3)
	if len(batch) != 3 {
		t.Fatalf("expected 3, got %d", len(batch))
	}
	if buf.size() != 7 {
		t.Fatalf("expected 7 remaining, got %d", buf.size())
	}
}

func TestRingBuffer_DrainEmpty(t *testing.T) {
	buf := newRingBuffer(10)
	items := buf.drain()
	if items != nil {
		t.Fatal("expected nil from empty drain")
	}
}

func TestRingBuffer_PanicOnZeroCapacity(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on zero capacity")
		}
	}()
	newRingBuffer(0)
}
