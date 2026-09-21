import { AforoOptions, TrackEvent, ResolvedEvent, FlushResult } from './types';
import { RingBuffer } from './buffer';
import { Transport } from './transport';
import { generateIdempotencyKey } from './idempotency';

const DEFAULT_BASE_URL = 'https://ingest.aforo.ai';
const DEFAULT_FLUSH_COUNT = 50;
const DEFAULT_FLUSH_INTERVAL = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT = 5_000;

/**
 * Aforo metering client.
 *
 * Enqueues usage events into a ring buffer, flushes them in batches
 * to the Aforo ingestor service via HTTP. Non-blocking — `track()`
 * returns immediately, flushing happens in the background.
 *
 * ```typescript
 * const client = new AforoClient({ apiKey: 'your-key' });
 * await client.track({ customerId: 'cust_1', metricName: 'api_calls', quantity: 1 });
 * // On shutdown:
 * await client.shutdown();
 * ```
 */
export class AforoClient {
  private readonly buffer: RingBuffer;
  private readonly transport: Transport;
  private readonly flushCount: number;
  private readonly flushInterval: number;
  private readonly shutdownTimeoutMs: number;

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private closed = false;
  private pendingFlush: Promise<FlushResult> | null = null;

  constructor(options: AforoOptions) {
    if (!options.apiKey) throw new Error('apiKey is required');

    this.flushCount = options.flushCount ?? DEFAULT_FLUSH_COUNT;
    this.flushInterval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT;

    this.buffer = new RingBuffer(options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);

    this.transport = new Transport({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: options.apiKey,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBaseMs: options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    });

    // Start periodic flush timer
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushInterval);

    // Unref the timer so it doesn't prevent Node from exiting
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      this.flushTimer.unref();
    }

    // Register graceful shutdown handlers
    const shutdownHandler = () => {
      this.shutdown().catch(() => {});
    };
    process.once('SIGTERM', shutdownHandler);
    process.once('SIGINT', shutdownHandler);
  }

  // ─── Session lifecycle (deprecated no-ops) ──────────────────────────

  /**
   * @deprecated No longer emits anything; kept so existing callers compile.
   *
   * This used to push `system.session.heartbeat` events (customerId "system",
   * quantity 0) into the usage batch every 30s. The ingestor validates every
   * event in a batch -- quantity must be positive and the metric must be in the
   * tenant's catalog -- and fails the whole batch with 400 when one event is
   * invalid, so each heartbeat took every real usage event batched with it down.
   * The ingestor has no dedicated heartbeat endpoint, so heartbeats are not sent.
   */
  startSession(_sessionId: string, _productType: string = 'AI_AGENT'): void {
    // Intentionally empty: see the deprecation note above.
  }

  /**
   * @deprecated Equivalent to `flush()`; no SESSION_END event is sent (see
   * `startSession`).
   */
  async endSession(): Promise<void> {
    await this.flush();
  }

  // ─── Event tracking ──────────────────────────────────────────────

  /**
   * Enqueue a usage event for batched delivery.
   * Returns immediately — does not await HTTP.
   * Triggers a flush if the buffer reaches flushCount.
   */
  async track(event: TrackEvent): Promise<void> {
    if (this.closed) {
      throw new Error('AforoClient is shut down — cannot track new events');
    }

    const occurredAt = resolveOccurredAt(event.occurredAt);
    const quantity = event.quantity ?? 1;

    const resolved: ResolvedEvent = {
      customerId: event.customerId,
      metricName: event.metricName,
      quantity,
      idempotencyKey: event.idempotencyKey
        ?? generateIdempotencyKey(event.customerId, event.metricName, quantity, occurredAt),
      occurredAt,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    };

    this.buffer.push(resolved);

    // Trigger flush if buffer threshold reached
    if (this.buffer.size >= this.flushCount) {
      this.flush().catch(() => {});
    }
  }

  /**
   * Force-flush all buffered events to the ingestor.
   * Safe to call concurrently — only one flush runs at a time.
   */
  async flush(): Promise<FlushResult> {
    if (this.flushing && this.pendingFlush) {
      return this.pendingFlush;
    }

    this.flushing = true;
    this.pendingFlush = this.doFlush();

    try {
      return await this.pendingFlush;
    } finally {
      this.flushing = false;
      this.pendingFlush = null;
    }
  }

  private async doFlush(): Promise<FlushResult> {
    let totalSent = 0;
    let totalFailed = 0;

    while (!this.buffer.isEmpty) {
      const batch = this.buffer.drainUpTo(this.flushCount);
      if (batch.length === 0) break;

      const result = await this.transport.send(batch);
      totalSent += result.sent;
      totalFailed += result.failed;
    }

    return { sent: totalSent, failed: totalFailed };
  }

  /**
   * Flush remaining events and stop the client.
   * After shutdown, track() will throw.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Clear periodic flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush with timeout
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, this.shutdownTimeoutMs)),
    ]);
  }

  /** Number of events currently buffered. */
  get bufferedCount(): number {
    return this.buffer.size;
  }

  /** Whether the client has been shut down. */
  get isShutdown(): boolean {
    return this.closed;
  }
}

function resolveOccurredAt(value?: string | number): string {
  if (!value) return new Date().toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return value;
}
