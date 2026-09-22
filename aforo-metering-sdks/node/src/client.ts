import { AforoOptions, TrackEvent, ResolvedEvent, FlushResult } from './types';
import { RingBuffer } from './buffer';
import { Transport } from './transport';
import { generateIdempotencyKey } from './idempotency';

const DEFAULT_BASE_URL = 'https://api.aforo.ai';
const DEFAULT_PRODUCT_TYPE = 'API';
const DEFAULT_SESSION_PRODUCT_TYPE = 'AI_AGENT';
/** Ingestor hard limit on events per batch request (IngestBatchRequest @Size(max = 1000)). */
const MAX_BATCH_SIZE = 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_METRIC = 'system.session.heartbeat';
/** Heartbeats carry no billable customer; the ingestor intercepts them before billing. */
const HEARTBEAT_CUSTOMER_ID = 'system';
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
 * const client = new AforoClient({ apiKey: 'your-key', productType: 'API' });
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
  private readonly productType: string;

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private closed = false;
  private pendingFlush: Promise<FlushResult> | null = null;

  // Session heartbeat state
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activeSessionId: string | null = null;
  private sessionStartedAt: number | null = null;
  private sessionProductType: string = DEFAULT_SESSION_PRODUCT_TYPE;

  constructor(options: AforoOptions) {
    if (!options.apiKey) throw new Error('apiKey is required');

    this.flushCount = Math.max(1, Math.min(options.flushCount ?? DEFAULT_FLUSH_COUNT, MAX_BATCH_SIZE));
    this.productType = normalizeProductType(options.productType) ?? DEFAULT_PRODUCT_TYPE;
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

  // ─── Session lifecycle with heartbeat ─────────────────────────────

  /**
   * Start a session and emit `system.session.heartbeat` events: one now, then
   * every 30s until `endSession()` / `shutdown()`.
   *
   * Each heartbeat is POSTed in its own request (`{"events":[heartbeat]}`),
   * never mixed into a usage batch, so it always takes the ingestor's
   * synchronous path, where it is intercepted before billing. Heartbeats are
   * best-effort: sent once, failures ignored, never affecting usage delivery.
   * The timer is unref'd so it never keeps the process alive.
   *
   * @param sessionId - Unique session identifier
   * @param productType - Product type for the session (default AI_AGENT)
   */
  startSession(sessionId: string, productType: string = DEFAULT_SESSION_PRODUCT_TYPE): void {
    if (this.closed || !sessionId || !String(sessionId).trim()) return;
    this.stopHeartbeatTimer();
    this.activeSessionId = String(sessionId);
    this.sessionStartedAt = Date.now();
    this.sessionProductType = normalizeProductType(productType) ?? DEFAULT_SESSION_PRODUCT_TYPE;

    this.emitSessionHeartbeat('HEARTBEAT');

    this.heartbeatTimer = setInterval(() => this.emitSessionHeartbeat('HEARTBEAT'), HEARTBEAT_INTERVAL_MS);
    if (this.heartbeatTimer && typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * End the current session: stop heartbeats, send a final SESSION_END
   * heartbeat (in its own request, best-effort) and flush buffered usage.
   */
  async endSession(): Promise<void> {
    this.stopHeartbeatTimer();
    const end = this.activeSessionId ? this.emitSessionHeartbeat('SESSION_END') : Promise.resolve();
    this.activeSessionId = null;
    this.sessionStartedAt = null;
    await Promise.all([end, this.flush()]);
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private emitSessionHeartbeat(boundary: 'HEARTBEAT' | 'SESSION_END'): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId || (this.closed && boundary === 'HEARTBEAT')) return Promise.resolve();

    const now = Date.now();
    const occurredAt = new Date(now).toISOString();
    const heartbeat: ResolvedEvent = {
      customerId: HEARTBEAT_CUSTOMER_ID,
      metricName: HEARTBEAT_METRIC,
      // quantity must be > 0 to pass the ingestor's bean validation; the
      // heartbeat is intercepted before billing and never counted as usage.
      quantity: 1,
      idempotencyKey: `hb:${boundary === 'SESSION_END' ? 'end:' : ''}${sessionId}:${now}:${randomSuffix()}`.slice(0, 255),
      occurredAt,
      productType: this.sessionProductType,
      sessionId,
      sessionBoundary: boundary,
      metadata: {
        sessionId,
        sessionBoundary: boundary,
        productType: this.sessionProductType,
        heartbeatType: boundary === 'SESSION_END' ? 'SESSION_END' : 'PERIODIC',
        uptimeMs: now - (this.sessionStartedAt ?? now),
        sdkLanguage: 'node',
      },
    };

    return this.transport.sendSingleBestEffort(heartbeat).then(() => undefined, () => undefined);
  }

  // ─── Event tracking ──────────────────────────────────────────────

  /**
   * Enqueue a usage event for batched delivery.
   * Returns immediately — does not await HTTP.
   * Triggers a flush if the buffer reaches flushCount.
   *
   * Throws if `customerId` or `metricName` is blank, or if `quantity` is not
   * a positive number: the ingestor would reject the event and, because it
   * validates a batch as a whole, every other event batched with it.
   */
  async track(event: TrackEvent): Promise<void> {
    if (this.closed) {
      throw new Error('AforoClient is shut down — cannot track new events');
    }

    if (event.customerId === undefined || event.customerId === null || !String(event.customerId).trim()) {
      throw new Error('customerId is required');
    }
    if (event.metricName === undefined || event.metricName === null || !String(event.metricName).trim()) {
      throw new Error('metricName is required');
    }

    const occurredAt = resolveOccurredAt(event.occurredAt);
    const quantity = event.quantity ?? 1;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('quantity must be a positive number (> 0)');
    }

    const resolved: ResolvedEvent = {
      customerId: event.customerId,
      metricName: event.metricName,
      quantity,
      idempotencyKey: event.idempotencyKey
        ?? generateIdempotencyKey(event.customerId, event.metricName, quantity, occurredAt),
      occurredAt,
      productType: normalizeProductType(event.productType) ?? this.productType,
      ...(event.metadata ? { metadata: event.metadata } : {}),
      ...(event.endpointPath !== undefined ? { endpointPath: event.endpointPath } : {}),
      ...(event.httpMethod !== undefined ? { httpMethod: event.httpMethod } : {}),
      ...(event.statusCode !== undefined ? { statusCode: event.statusCode } : {}),
      ...(event.responseTimeMs !== undefined ? { responseTimeMs: event.responseTimeMs } : {}),
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

    // Stop session heartbeats
    this.stopHeartbeatTimer();

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

function normalizeProductType(value?: string | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function resolveOccurredAt(value?: string | number): string {
  if (!value) return new Date().toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return value;
}
