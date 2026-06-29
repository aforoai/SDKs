package com.aforo.metering;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Thread-safe bounded buffer for usage events.
 *
 * <p>Uses {@link ConcurrentLinkedQueue} for lock-free enqueue/dequeue
 * with an {@link AtomicInteger} tracking size. When capacity is exceeded,
 * the oldest event is dropped.</p>
 */
public class RingBuffer {

    private final ConcurrentLinkedQueue<ResolvedEvent> queue = new ConcurrentLinkedQueue<>();
    private final AtomicInteger size = new AtomicInteger(0);
    private final int capacity;

    public RingBuffer(int capacity) {
        if (capacity < 1) throw new IllegalArgumentException("Buffer capacity must be >= 1");
        this.capacity = capacity;
    }

    /**
     * Add an event. Returns true if added without overflow, false if oldest was dropped.
     */
    public boolean push(ResolvedEvent event) {
        queue.add(event);
        int newSize = size.incrementAndGet();

        if (newSize > capacity) {
            queue.poll(); // Drop oldest
            size.decrementAndGet();
            return false;
        }
        return true;
    }

    /**
     * Drain all events from the buffer.
     */
    public List<ResolvedEvent> drain() {
        List<ResolvedEvent> result = new ArrayList<>();
        ResolvedEvent e;
        while ((e = queue.poll()) != null) {
            result.add(e);
            size.decrementAndGet();
        }
        return result;
    }

    /**
     * Drain up to {@code max} events from the front.
     */
    public List<ResolvedEvent> drainUpTo(int max) {
        List<ResolvedEvent> result = new ArrayList<>();
        for (int i = 0; i < max; i++) {
            ResolvedEvent e = queue.poll();
            if (e == null) break;
            result.add(e);
            size.decrementAndGet();
        }
        return result;
    }

    public int size() { return size.get(); }
    public boolean isEmpty() { return size.get() == 0; }
}
