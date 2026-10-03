import { ResolvedEvent } from './types.js';

/**
 * Bounded ring buffer for usage events.
 * Thread-safe for Node.js single-threaded event loop.
 * When full, the oldest event is dropped (FIFO overflow).
 */
export class RingBuffer {
  private readonly items: ResolvedEvent[];
  private readonly capacity: number;
  private head = 0;
  private tail = 0;
  private count = 0;

  constructor(capacity: number = 10_000) {
    if (capacity < 1) throw new Error('Buffer capacity must be >= 1');
    this.capacity = capacity;
    this.items = new Array(capacity);
  }

  /** Add an event to the buffer. Returns true if added, false if overflow (oldest dropped). */
  push(event: ResolvedEvent): boolean {
    return this.pushEvict(event) === null;
  }

  /**
   * Add an event to the buffer. On overflow, returns the evicted OLDEST
   * event so the caller can surface the drop; returns null when no
   * eviction occurred.
   */
  pushEvict(event: ResolvedEvent): ResolvedEvent | null {
    let evicted: ResolvedEvent | null = null;

    if (this.count === this.capacity) {
      // Buffer full — drop oldest (advance head)
      evicted = this.items[this.head];
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }

    this.items[this.tail] = event;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;

    return evicted;
  }

  /** Drain all events from the buffer. Returns a new array and clears the buffer. */
  drain(): ResolvedEvent[] {
    if (this.count === 0) return [];

    const result: ResolvedEvent[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      result.push(this.items[idx]);
    }

    this.head = 0;
    this.tail = 0;
    this.count = 0;

    return result;
  }

  /** Drain up to `max` events from the front of the buffer. */
  drainUpTo(max: number): ResolvedEvent[] {
    if (this.count === 0 || max <= 0) return [];

    const take = Math.min(max, this.count);
    const result: ResolvedEvent[] = [];
    for (let i = 0; i < take; i++) {
      const idx = (this.head + i) % this.capacity;
      result.push(this.items[idx]);
    }

    this.head = (this.head + take) % this.capacity;
    this.count -= take;

    return result;
  }

  /** Current number of events in the buffer. */
  get size(): number {
    return this.count;
  }

  /** Whether the buffer is empty. */
  get isEmpty(): boolean {
    return this.count === 0;
  }

  /** Whether the buffer is at capacity. */
  get isFull(): boolean {
    return this.count === this.capacity;
  }
}
