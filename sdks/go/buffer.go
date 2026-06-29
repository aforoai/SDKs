package metering

import "sync"

// ringBuffer is a thread-safe bounded buffer for usage events.
// When full, the oldest event is dropped.
type ringBuffer struct {
	mu       sync.Mutex
	items    []resolvedEvent
	head     int
	tail     int
	count    int
	capacity int
}

func newRingBuffer(capacity int) *ringBuffer {
	if capacity < 1 {
		panic("buffer capacity must be >= 1")
	}
	return &ringBuffer{
		items:    make([]resolvedEvent, capacity),
		capacity: capacity,
	}
}

// push adds an event. Returns true if added without overflow.
func (b *ringBuffer) push(event resolvedEvent) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	overflow := false
	if b.count == b.capacity {
		b.head = (b.head + 1) % b.capacity
		b.count--
		overflow = true
	}

	b.items[b.tail] = event
	b.tail = (b.tail + 1) % b.capacity
	b.count++

	return !overflow
}

// drain removes and returns all events.
func (b *ringBuffer) drain() []resolvedEvent {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.count == 0 {
		return nil
	}

	result := make([]resolvedEvent, b.count)
	for i := 0; i < b.count; i++ {
		idx := (b.head + i) % b.capacity
		result[i] = b.items[idx]
	}

	b.head = 0
	b.tail = 0
	b.count = 0
	return result
}

// drainUpTo removes and returns up to max events.
func (b *ringBuffer) drainUpTo(max int) []resolvedEvent {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.count == 0 || max <= 0 {
		return nil
	}

	take := b.count
	if take > max {
		take = max
	}

	result := make([]resolvedEvent, take)
	for i := 0; i < take; i++ {
		idx := (b.head + i) % b.capacity
		result[i] = b.items[idx]
	}

	b.head = (b.head + take) % b.capacity
	b.count -= take
	return result
}

func (b *ringBuffer) size() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.count
}

func (b *ringBuffer) isEmpty() bool {
	return b.size() == 0
}
