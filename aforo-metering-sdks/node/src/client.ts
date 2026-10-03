import { AforoOptions, TrackEvent, ResolvedEvent, FlushResult, DropReason } from './types.js';
import { RingBuffer } from './buffer.js';
import { Transport } from './transport.js';
import { generateRandomKey } from './idempotency.js';
import { describeLimitViolation } from './limits.js';

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
  private readonly onDrop?: (events: ResolvedEvent[], reason: DropReason) => void;

  // Drop accounting — events permanently lost (overflow eviction, failed
  // batch, or an event that failed client-side validation)
  private dropped = 0;
  private overflowDrops = 0;
  private invalidDrops = 0;

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private closed = false;
  private pendingFlush: Promise<FlushResult> | null = null;

  // Session heartbeat state
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activeSessionId: string | null = null;
  private sessionStartedAt: number | null = null;
  private sessionProductType: string = DEFAULT_SESSION_PRODUCT_TYPE;

  // Kept so shutdown() can deregister — otherwise every client leaks a
  // SIGTERM/SIGINT once-listener for the life of the process.
  private readonly signalHandler: () => void;

  constructor(options: AforoOptions) {
    if (!options.apiKey) throw new Error('apiKey is required');

    this.flushCount = Math.max(1, Math.min(options.flushCount ?? DEFAULT_FLUSH_COUNT, MAX_BATCH_SIZE));
    this.productType = normalizeProductType(options.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.flushInterval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT;
    this.onDrop = options.onDrop;

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

    // Register graceful shutdown handlers (deregistered in shutdown())
    this.signalHandler = () => {
      this.shutdown().catch(() => {});
    };
    process.once('SIGTERM', this.signalHandler);
    process.once('SIGINT', this.signalHandler);
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

    // Sent alone and outside the usage buffer; a failed heartbeat is not a
    // usage drop, so it is never counted in droppedCount or handed to onDrop.
    return this.transport.sendSingleBestEffort(heartbeat).then(() => undefined, () => undefined);
  }

  // ─── Event tracking ──────────────────────────────────────────────

  /**
   * Enqueue a usage event for batched delivery.
   * Returns immediately — does not await HTTP.
   * Triggers a flush if the buffer reaches flushCount.
   *
   * Throws only when the client is shut down. An event the ingestor would
   * reject — a blank or over-long `customerId` / `metricName` /
   * `idempotencyKey`, a `quantity` that is not positive or carries more than
   * 14 integer digits / 6 decimal places, an `occurredAt` that is not an
   * ISO-8601 instant, or any other capped field that is too long — is NOT
   * buffered and NOT sent. It is counted in `droppedCount`, WARN-logged with
   * the field, the limit and the offending value, and passed to the opt-in
   * `onDrop` hook with reason `'invalid'`. Limits the server makes
   * configurable (event age, clock skew, metadata size) are left to the
   * server. See `limits.ts` for the limits and where each one comes from.
   */
  async track(event: TrackEvent): Promise<void> {
    if (this.closed) {
      throw new Error('AforoClient is shut down — cannot track new events');
    }

    // A missing event object is reported as an invalid event, not a TypeError.
    event = (event ?? {}) as TrackEvent;

    const occurredAt = resolveOccurredAt(event.occurredAt);
    const quantity = event.quantity ?? 1;
    const productType = normalizeProductType(event.productType) ?? this.productType;
    // Minted once, here, when the event is enqueued — never at flush/retry
    // time, so a retried batch carries the same keys and the ingestor
    // deduplicates it. A caller-supplied key is passed through verbatim;
    // otherwise each event gets its own random UUID (no caller key = dedup
    // opt-out). A deterministic hash of the event fields would make two
    // genuinely distinct events in the same millisecond collide, and the
    // ingestor would silently drop the second. Minted before the validity
    // check so a dropped event reaches onDrop with its key.
    const idempotencyKey = event.idempotencyKey ?? generateRandomKey();

    const resolved: ResolvedEvent = {
      customerId: event.customerId,
      metricName: event.metricName,
      quantity,
      idempotencyKey,
      occurredAt,
      productType,
      ...(event.metadata ? { metadata: event.metadata } : {}),
      ...(event.endpointPath !== undefined ? { endpointPath: event.endpointPath } : {}),
      ...(event.httpMethod !== undefined ? { httpMethod: event.httpMethod } : {}),
      ...(event.statusCode !== undefined ? { statusCode: event.statusCode } : {}),
      ...(event.responseTimeMs !== undefined ? { responseTimeMs: event.responseTimeMs } : {}),
    };
    const executionStatus = normalizeExecutionStatus(event.executionStatus);
    if (executionStatus) {
      if (CANONICAL_EXECUTION_STATUSES.has(executionStatus)) {
        resolved.executionStatus = executionStatus;
      } else {
        // The ingestor rejects an event carrying an unknown status, so an
        // unknown value is reported and the field omitted (the event still
        // bills, at full weight) instead of losing the event.
        warnUnknownExecutionStatus(executionStatus);
      }
    }

    const violation = describeInvalidEvent(event, resolved);
    if (violation) {
      // Not buffered, not sent, never thrown: an un-awaited rejected track()
      // would crash the process on the hot path. Same shape as every other drop.
      this.recordDrop([resolved], 'invalid', violation);
      return;
    }

    this.enqueue(resolved);

    // Trigger flush if buffer threshold reached
    if (this.buffer.size >= this.flushCount) {
      this.flush().catch(() => {});
    }
  }

  /** Buffer an event; surface the evicted-oldest event if the push overflowed. */
  private enqueue(resolved: ResolvedEvent): void {
    const evicted = this.buffer.pushEvict(resolved);
    if (evicted) {
      this.recordDrop([evicted], 'overflow');
    }
  }

  /**
   * Account for permanently lost events: bump the counter, WARN-log, and
   * invoke the opt-in onDrop hook. Overflow logs are throttled (first, then
   * every 1000th eviction) so sustained overflow can't storm the log;
   * failed-batch drops log every time (bounded by flush cadence).
   */
  private recordDrop(events: ResolvedEvent[], reason: DropReason, detail?: string): void {
    if (events.length === 0) return;
    this.dropped += events.length;

    if (reason === 'invalid') {
      // Throttled like overflow: a tight loop of bad events can't storm the log.
      this.invalidDrops += events.length;
      if (this.invalidDrops === 1 || this.invalidDrops % 1000 === 0) {
        console.warn(
          `[aforo] Invalid event dropped — ${detail ?? 'failed validation'} ` +
          `(${this.invalidDrops} invalid, ${this.dropped} total dropped). It was not sent.`,
        );
      }
    } else if (reason === 'overflow') {
      this.overflowDrops += events.length;
      if (this.overflowDrops === 1 || this.overflowDrops % 1000 === 0) {
        console.warn(
          `[aforo] Buffer overflow: oldest event dropped (${this.dropped} total dropped). ` +
          `Consider raising maxQueueSize or checking ingest connectivity.`,
        );
      }
    } else {
      console.warn(
        `[aforo] Dropped ${events.length} event(s) — ${reason}` +
        `${detail ? `: ${detail}` : ''} (${this.dropped} total dropped).`,
      );
    }

    if (this.onDrop) {
      try {
        this.onDrop(events, reason);
      } catch {
        // A hook bug must never break tracking/flushing.
      }
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

      if (result.failed > 0) {
        // The batch was already drained from the buffer — without this it
        // vanishes silently. Surface it (counter + WARN + opt-in hook).
        // A partially accepted batch drops only the events the server
        // rejected: by index when the response names them; otherwise they are
        // counted and logged but not handed to onDrop (which ones is unknown).
        if (result.sent > 0 || result.rejected) {
          if (result.rejected) {
            const lost = result.rejected.map((r) => batch[r.index]).filter(Boolean);
            this.recordDrop(lost, 'rejected', result.message);
          } else {
            this.dropped += result.failed;
            console.warn(
              `[aforo] Ingestor rejected ${result.failed} of ${batch.length} event(s) in a batch` +
              `${result.message ? `: ${result.message}` : ''} (${this.dropped} total dropped).`,
            );
          }
        } else {
          this.recordDrop(batch, result.reason ?? 'retry_exhausted', result.message);
        }
      }
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

    // Deregister signal handlers so repeated create/shutdown cycles don't
    // accumulate process listeners (safe if already fired — once() removed it).
    process.removeListener('SIGTERM', this.signalHandler);
    process.removeListener('SIGINT', this.signalHandler);

    // Stop session heartbeats
    this.stopHeartbeatTimer();

    // Clear periodic flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush with timeout. The escape-hatch timer MUST be cleared once the
    // race settles — left dangling it holds the event loop open for up to
    // shutdownTimeoutMs after a clean shutdown, delaying process exit in
    // short-lived producers (CLIs, jobs, serverless handlers).
    let escapeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => {
          escapeTimer = setTimeout(resolve, this.shutdownTimeoutMs);
        }),
      ]);
    } finally {
      if (escapeTimer) clearTimeout(escapeTimer);
    }
  }

  /** Number of events currently buffered. */
  get bufferedCount(): number {
    return this.buffer.size;
  }

  /** Total events permanently dropped (overflow, failed batches, server-rejected and invalid events) since creation. */
  get droppedCount(): number {
    return this.dropped;
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

/** Shorten an offending value for a log line. */
function clip(value: unknown): string {
  return String(value).slice(0, 80);
}

/**
 * First reason the ingestor would reject this event, or null when it is
 * acceptable. Required fields and quantity sign first, then the size limits.
 */
function describeInvalidEvent(event: TrackEvent, resolved: ResolvedEvent): string | null {
  for (const field of ['customerId', 'metricName'] as const) {
    const value = (event as any)?.[field];
    if (value === undefined || value === null || !String(value).trim()) {
      return `${field} is required (got "${clip(value)}")`;
    }
  }
  const quantity = resolved.quantity;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    return `quantity must be a positive number (> 0), got "${clip(quantity)}"`;
  }
  if (typeof resolved.occurredAt !== 'string') {
    return `occurredAt must be an ISO-8601 string or epoch milliseconds, got "${clip(resolved.occurredAt)}"`;
  }
  return describeLimitViolation({
    customerId: resolved.customerId,
    metricName: resolved.metricName,
    quantity,
    idempotencyKey: resolved.idempotencyKey,
    occurredAt: resolved.occurredAt,
    productType: resolved.productType,
    endpointPath: resolved.endpointPath,
    httpMethod: resolved.httpMethod,
  });
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function resolveOccurredAt(value?: string | number): string {
  if (!value) return new Date().toISOString();
  if (typeof value === 'number') {
    const date = new Date(value);
    // An out-of-range epoch must not throw from track(); it is reported as invalid.
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  return value;
}

/**
 * Statuses the ingestor accepts (contract/ingest-contract.json, max 20 chars).
 * Anything else would make it reject the event.
 */
const CANONICAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  'SUCCESS', 'PARTIAL', 'TIMEOUT', 'ERROR', 'VALIDATION_FAILED', 'FAILED',
  'FAILURE', 'CANCELLED', 'PENDING', 'BLOCKED', 'HITL_REQUIRED',
]);

// Warn once per distinct bad value (bounded) so a misconfigured static status
// can't storm the log on every request.
const MAX_WARNED_STATUSES = 100;
const warnedStatuses = new Set<string>();

function warnUnknownExecutionStatus(value: string): void {
  if (warnedStatuses.has(value)) return;
  if (warnedStatuses.size < MAX_WARNED_STATUSES) warnedStatuses.add(value);
  console.warn(
    `[aforo] Unknown executionStatus "${value.slice(0, 40)}" — field omitted from the event. ` +
    `Expected one of: ${[...CANONICAL_EXECUTION_STATUSES].join(', ')}.`,
  );
}

/** Trim + upper-case; blank/absent → undefined (key omitted from the wire body). */
function normalizeExecutionStatus(value?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}
