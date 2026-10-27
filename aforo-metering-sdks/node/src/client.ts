import { AforoOptions, TrackEvent, ResolvedEvent, FlushResult, DropReason } from './types.js';
import { TransportCore, checkBaseUrl, CoreDropReason } from './transport-core/core.js';
import { generateRandomKey } from './idempotency.js';
import { describeLimitViolation } from './limits.js';

/** Package version, sent in User-Agent. Keep in step with package.json. */
export const SDK_VERSION = '2.0.0';
const DEFAULT_BASE_URL = 'https://api.aforo.ai';
const DEFAULT_PRODUCT_TYPE = 'API';
const DEFAULT_SESSION_PRODUCT_TYPE = 'AI_AGENT';
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_METRIC = 'system.session.heartbeat';
/** Heartbeats carry no billable customer; the ingestor intercepts them before billing. */
const HEARTBEAT_CUSTOMER_ID = 'system';
const DEFAULT_TIMEOUT = 10_000;

/** Sends one heartbeat in its own request, once. Holds the API key in a closure, never on the client. */
type HeartbeatSender = (event: ResolvedEvent) => Promise<boolean>;

function makeHeartbeatSender(baseUrl: string, apiKey: string, timeoutMs: number): HeartbeatSender {
  const url = `${baseUrl}/v1/ingest/batch`;
  return async (event) => {
    try {
      const response = await (globalThis as any).fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'User-Agent': `aforo-node/${SDK_VERSION}` },
        body: JSON.stringify({ events: [event] }),
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow a redirect: it would send the API key to another host.
        redirect: 'manual',
      });
      const status = Number(response?.status);
      if (status === 0 || (status >= 300 && status < 400)) {
        console.debug(`[aforo] heartbeat not delivered: the ingestor answered HTTP ${status} (redirects are not followed; check baseUrl)`);
        return false;
      }
      return Boolean(response?.ok);
    } catch (err) {
      console.debug(`[aforo] heartbeat not delivered: ${(err as Error)?.message ?? err}`);
      return false;
    }
  };
}

/**
 * Aforo metering client.
 *
 * `track()` validates the event and puts it on a bounded queue; one background
 * flusher sends batches to the ingestor. If the ingestor is down, batches go
 * back on the queue (same idempotency keys) and are sent when it recovers.
 *
 * ```typescript
 * const client = new AforoClient({ apiKey: process.env.AFORO_API_KEY!, productType: 'API' });
 * await client.track({ customerId: 'cust_1', metricName: 'api_calls', quantity: 1 });
 * // The SDK installs no signal handlers. Flush from your own:
 * process.once('SIGTERM', async () => { await client.shutdown(); process.exit(0); });
 * ```
 */
export class AforoClient {
  private readonly core: TransportCore<ResolvedEvent>;
  private readonly sendHeartbeat!: HeartbeatSender;
  private readonly productType: string;

  // Session heartbeat state
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activeSessionId: string | null = null;
  private sessionStartedAt: number | null = null;
  private sessionProductType: string = DEFAULT_SESSION_PRODUCT_TYPE;

  constructor(options: AforoOptions) {
    if (!options || !options.apiKey) throw new Error('apiKey is required');
    const baseUrl = checkBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL, options.allowInsecureHttp === true);
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;

    this.productType = normalizeProductType(options.productType) ?? DEFAULT_PRODUCT_TYPE;
    const onDrop = options.onDrop;
    this.core = new TransportCore<ResolvedEvent>({
      baseUrl,
      apiKey: options.apiKey,
      allowInsecureHttp: options.allowInsecureHttp,
      userAgent: `aforo-node/${SDK_VERSION}`,
      flushCount: options.flushCount,
      flushIntervalMs: options.flushInterval,
      maxQueueSize: options.maxQueueSize,
      maxRetries: options.maxRetries,
      retryBaseMs: options.retryBaseMs,
      timeoutMs: timeout,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      flushOnExit: options.flushOnExit,
      logPrefix: '[aforo]',
      onDrop: onDrop ? (events, reason: CoreDropReason) => onDrop(events, reason as DropReason) : undefined,
    });
    // Non-enumerable, so inspect()/JSON never walk into the closure's owner.
    Object.defineProperty(this, 'sendHeartbeat', {
      value: makeHeartbeatSender(baseUrl, options.apiKey, timeout),
      enumerable: false,
    });
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
    if (this.core.closed || !sessionId || !String(sessionId).trim()) return;
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
    if (!sessionId || (this.core.closed && boundary === 'HEARTBEAT')) return Promise.resolve();

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

    // Sent alone and outside the usage queue; a failed heartbeat is not a
    // usage drop, so it is never counted in droppedCount or handed to onDrop.
    return this.sendHeartbeat(heartbeat).then(() => undefined, () => undefined);
  }

  // ─── Event tracking ──────────────────────────────────────────────

  /**
   * Queue a usage event. Returns at once — it never waits on HTTP and never
   * starts a request (the background flusher sends batches).
   *
   * Never throws. An event the ingestor would reject — a blank or over-long
   * `customerId` / `metricName` / `idempotencyKey`, a `quantity` that is not
   * positive or carries more than 14 integer digits / 6 decimal places, an
   * `occurredAt` that is not an ISO-8601 instant, or any other capped field
   * that is too long — is NOT queued and NOT sent. It is counted in
   * `droppedCount`, WARN-logged with the field and the limit, and passed to
   * the opt-in `onDrop` hook with reason `'invalid'`. After `shutdown()` the
   * event is counted and reported with reason `'closed'`.
   */
  async track(event: TrackEvent): Promise<void> {
    // A missing event object is reported as an invalid event, not a TypeError.
    event = (event ?? {}) as TrackEvent;

    const occurredAt = resolveOccurredAt(event.occurredAt);
    const quantity = event.quantity ?? 1;
    const productType = normalizeProductType(event.productType) ?? this.productType;
    // Minted once, here, when the event is enqueued — never at flush/retry
    // time, so a retried or requeued batch carries the same keys and the
    // ingestor deduplicates it. A caller-supplied key is passed through
    // verbatim; otherwise each event gets its own random UUID.
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

    if (this.core.closed) {
      this.core.enqueue(resolved); // reported as 'closed'
      return;
    }

    const violation = describeInvalidEvent(event, resolved);
    if (violation) {
      this.core.reportDrop([resolved], 'invalid', violation);
      return;
    }

    this.core.enqueue(resolved);
  }

  /** @internal Count and report an event a middleware could not build (reason 'invalid'). */
  reportInvalid(event: ResolvedEvent, detail: string): void {
    this.core.reportDrop([event], 'invalid', detail);
  }

  /**
   * Send everything queued now and wait for it. Runs on the single flusher —
   * never a second concurrent request. While the ingestor is down this makes
   * one attempt; unsent events stay queued.
   */
  async flush(): Promise<FlushResult> {
    const r = await this.core.flush();
    return { sent: r.sent, failed: r.failed, requeued: r.requeued, queued: r.queued };
  }

  /**
   * Stop accepting events and send what is queued, for at most
   * `shutdownTimeoutMs`. Events still queued at the deadline are counted and
   * reported through onDrop with reason 'shutdown'. Safe to call more than once.
   */
  async shutdown(): Promise<void> {
    this.stopHeartbeatTimer();
    await this.core.shutdown();
  }

  /** Number of events currently queued. */
  get bufferedCount(): number {
    return this.core.queued;
  }

  /** Total events permanently dropped (every DropReason) since creation. */
  get droppedCount(): number {
    return this.core.droppedCount;
  }

  /** Whether the client has been shut down. */
  get isShutdown(): boolean {
    return this.core.closed;
  }

  toJSON(): Record<string, unknown> {
    return { productType: this.productType, buffered: this.bufferedCount, dropped: this.droppedCount, shutdown: this.isShutdown };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `AforoClient { productType: '${this.productType}', buffered: ${this.bufferedCount}, dropped: ${this.droppedCount}, shutdown: ${this.isShutdown} }`;
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
