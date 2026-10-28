/**
 * @file A Map with a size cap and a per-entry expiry.
 *
 * Every cache and table the proxy keeps per customer, session or call goes
 * through this so a long-running sidecar cannot grow without bound (G306):
 * entries past their expiry are dropped on read and by `sweep()`, and when the
 * map is full the least recently set entry is evicted.
 */

export interface BoundedMapOptions<K, V> {
  /** Most entries kept. Inserting past it evicts the least recently set entry. */
  maxEntries: number;
  /** Called with each entry removed to make room (not for expiry or delete). */
  onEvict?: (key: K, value: V) => void;
}

interface Slot<V> {
  value: V;
  /** Epoch ms after which the entry is gone; Infinity = no expiry. */
  expiresAt: number;
}

export class BoundedMap<K, V> {
  private readonly map = new Map<K, Slot<V>>();
  private readonly maxEntries: number;
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(options: BoundedMapOptions<K, V>) {
    if (!Number.isFinite(options.maxEntries) || options.maxEntries < 1) {
      throw new Error(`BoundedMap: maxEntries must be at least 1 (got ${options.maxEntries})`);
    }
    this.maxEntries = Math.floor(options.maxEntries);
    this.onEvict = options.onEvict;
  }

  /** The value, or undefined when absent or expired (an expired entry is removed). */
  get(key: K, now: number = Date.now()): V | undefined {
    const slot = this.map.get(key);
    if (!slot) return undefined;
    if (slot.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    return slot.value;
  }

  has(key: K, now: number = Date.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  /** Store `value`; `ttlMs` omitted or non-finite = no expiry. Re-setting moves the key to the newest position. */
  set(key: K, value: V, ttlMs?: number, now: number = Date.now()): void {
    const expiresAt = ttlMs !== undefined && Number.isFinite(ttlMs) ? now + Math.max(0, ttlMs) : Infinity;
    this.map.delete(key);
    this.map.set(key, { value, expiresAt });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const evicted = this.map.get(oldest.value)!;
      this.map.delete(oldest.value);
      this.onEvict?.(oldest.value, evicted.value);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Remove every expired entry. */
  sweep(now: number = Date.now()): void {
    for (const [key, slot] of this.map) {
      if (slot.expiresAt <= now) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }

  /** Live and not-yet-swept entries. */
  get size(): number {
    return this.map.size;
  }

  /** Entries in insertion order (expired ones included until swept). */
  *entries(): IterableIterator<[K, V]> {
    for (const [key, slot] of this.map) yield [key, slot.value];
  }
}
