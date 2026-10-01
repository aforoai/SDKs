/**
 * @aforoai/ws-metering — Aforo WebSocket Metering SDK
 *
 * Wraps WebSocket server connections to emit three classes of billing events:
 *   - CONNECTION_OPENED  — once on upgrade completion
 *   - MESSAGE            — one event per frame (direction + bytes + type)
 *   - CONNECTION_CLOSED  — once on close, carrying aggregated counters + duration
 *
 * Works with the `ws` library out of the box (wrap WebSocketServer), or use
 * trackConnection() directly for Fastify-WebSocket, Socket.io, Deno, Bun, or
 * anything else that exposes the standard WebSocket event surface.
 *
 * Usage:
 *   import { WebSocketServer } from 'ws';
 *   import { AforoWsBilling } from '@aforoai/ws-metering';
 *
 *   const billing = new AforoWsBilling({
 *     tenantId: 'tenant_acme',
 *     productId: 'prod_ws_market_feed',
 *     apiKey: process.env.AFORO_API_KEY!,
 *     ingestorUrl: 'https://api.aforo.ai',
 *     // productType defaults to 'WEBSOCKET_API'
 *   });
 *
 *   const wss = new WebSocketServer({ port: 8080 });
 *   billing.wrapServer(wss, {
 *     extractCustomerId: (req) => req.headers['x-customer-id'] as string,
 *   });
 */

import { randomUUID } from 'node:crypto';

export interface AforoWsConfig {
  tenantId: string;
  productId: string;
  apiKey: string;
  ingestorUrl: string;
  /**
   * Aforo product type sent as top-level `productType` on every event (trimmed + uppercased).
   * Default: `WEBSOCKET_API`. Override per integration via `wrapServer(wss, { productType })` / `trackConnection(ws, { productType })`.
   */
  productType?: string;
  /** How many events to buffer before flushing (default 100 — WS is high-volume). */
  flushCount?: number;
  /** Max interval in ms before a partial batch is flushed (default 3000). */
  flushIntervalMs?: number;
  /** If true, emit one MESSAGE event per frame. If false (default) only aggregate on close. */
  perFrameEvents?: boolean;
  /** Callback for terminal flush failures. */
  onError?: (error: Error) => void;
  /**
   * Opt-in hook receiving events that were permanently dropped (retry
   * exhaustion, a rejection by the ingestor, or a failed client-side check —
   * see DropReason). Events keep their idempotency keys,
   * so persisting and re-submitting them after recovery is dedup-safe.
   * Exceptions thrown by the hook are swallowed. Default: none (drops are
   * still counted in droppedCount and WARN-logged).
   */
  onDrop?: (events: WsUsageEvent[], reason: DropReason) => void;
}

/**
 * Why events were permanently dropped. `retry_exhausted`: the ingestor stayed
 * unreachable / kept answering 408, 429 or 5xx. `rejected`: the ingestor
 * refused the batch (non-retryable 4xx) or individual events of an accepted
 * batch. `invalid`: the event failed a client-side check and was never sent.
 * The buffer is unbounded (drained at flush start), so unlike the core SDK
 * there is no 'overflow' reason here.
 */
export type DropReason = 'retry_exhausted' | 'rejected' | 'invalid';

export interface WrapServerOptions {
  /** Extract Aforo customer ID from the upgrade request. */
  extractCustomerId: (req: any) => string | undefined;
  /** Optional per-connection metadata (product-defined tags). */
  extractMetadata?: (req: any) => Record<string, unknown> | undefined;
  /**
   * Optional outcome of the request (used by OUTCOME_BASED pricing, which bills
   * each event at the weight set for its status). Events without a status bill
   * at full price. Trimmed and upper-cased by the SDK; blank is treated as absent.
   * Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED,
   * FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED (max 20 chars). Any other
   * value — or a Promise from an async resolver — is reported through `onError`
   * and left off the event (the event is still sent), because the server would
   * reject the event.
   *
   * This is the outcome of the CONNECTION: it is set on the closing event only
   * (CONNECTION_CLOSED, and the synthetic close emitted on a socket error).
   * CONNECTION_OPENED and per-frame MESSAGE events never carry it, so a status
   * meant for the connection (e.g. ERROR on an abnormal close) can't zero out
   * every frame under OUTCOME_BASED pricing. WebSocket frames carry no
   * success/failure signal, so the SDK never derives one: pass a fixed string,
   * or a synchronous function called with the closing event (and the upgrade
   * request) that returns the status or undefined.
   */
  executionStatus?: string | ((event: WsUsageEvent, req: any) => string | undefined);
  /** Product type for connections accepted by this server. Default: the client-level `productType`. */
  productType?: string;
}

/** Options for trackConnection(). */
export interface TrackConnectionOptions {
  customerId: string;
  metadata?: Record<string, unknown>;
  /**
   * Optional outcome of the request (used by OUTCOME_BASED pricing, which bills
   * each event at the weight set for its status). Events without a status bill
   * at full price. Trimmed and upper-cased by the SDK; blank is treated as absent.
   * Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED,
   * FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED (max 20 chars). Any other
   * value — or a Promise from an async resolver — is reported through `onError`
   * and left off the event (the event is still sent), because the server would
   * reject the event.
   *
   * The outcome of the connection, set on its closing event only
   * (CONNECTION_CLOSED, or the synthetic close on a socket error) — never on
   * CONNECTION_OPENED or per-frame events. Never derived by the SDK: pass a
   * fixed string, or a synchronous function called with the closing event that
   * returns the status or undefined.
   */
  executionStatus?: string | ((event: WsUsageEvent) => string | undefined);
  /** Product type for this connection's events (trimmed + uppercased). Default: the client-level `productType`. */
  productType?: string;
}

type ExecutionStatusOption = TrackConnectionOptions['executionStatus'];

/** Minimal WebSocket surface — matches `ws` WebSocket, Fastify socket, Deno, Bun. */
interface MinimalWs {
  on(event: 'message', fn: (data: any, isBinary?: boolean) => void): void;
  on(event: 'close', fn: (code: number, reason: Buffer | string) => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
  send(data: any, cb?: (err?: Error) => void): void;
  readyState?: number;
}

/** Minimal WebSocketServer surface — matches `ws` WebSocketServer. */
interface MinimalWss {
  on(event: 'connection', fn: (ws: MinimalWs, req: any) => void): void;
}

const SDK_VERSION = '1.2.1';
/** Default top-level `productType` for this SDK. */
export const DEFAULT_PRODUCT_TYPE = 'WEBSOCKET_API';
/** Upper bound on a server-requested Retry-After wait. */
const MAX_RETRY_AFTER_MS = 30_000;
/** The ingestor rejects batch requests with more than 1000 events. */
const MAX_BATCH_EVENTS = 1000;
/** usage-ingestor limits (IngestUsageEventRequest). */
const MAX_CUSTOMER_ID = 64;
const MAX_IDEMPOTENCY_KEY = 255;
const MAX_PRODUCT_TYPE = 20;

// Close reason code → descriptor enum label
const CLOSE_REASONS: Record<number, string> = {
  1000: 'NORMAL_CLOSURE',
  1001: 'GOING_AWAY',
  1002: 'PROTOCOL_ERROR',
  1003: 'UNSUPPORTED_DATA',
  1005: 'NORMAL_CLOSURE',     // no status
  1006: 'ABNORMAL_CLOSURE',
  1007: 'PROTOCOL_ERROR',
  1008: 'POLICY_VIOLATION',
  1009: 'MESSAGE_TOO_BIG',
  1011: 'INTERNAL_ERROR',
  1012: 'GOING_AWAY',
  4000: 'IDLE_TIMEOUT',       // common app-level range
};

export interface WsUsageEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
  idempotencyKey: string;
  productType: string;
  wsConnectionId: string;
  wsDirection: 'CLIENT_TO_SERVER' | 'SERVER_TO_CLIENT';
  wsFrameType: 'TEXT' | 'BINARY' | 'PING' | 'PONG' | 'CLOSE';
  wsCloseReason?: string;
  messageCount: number;
  dataBytes: number;
  executionDurationMs: number;
  metadata?: Record<string, unknown>;
  /** Normalized (trimmed, upper-cased) execution status; omitted when not set. */
  executionStatus?: string;
}

export class AforoWsBilling {
  private readonly config: Required<
    Pick<AforoWsConfig, 'tenantId' | 'productId' | 'apiKey' | 'ingestorUrl'>
  >;
  private readonly productType: string;
  private readonly flushCount: number;
  private readonly flushIntervalMs: number;
  private readonly perFrameEvents: boolean;
  private readonly onError: (error: Error) => void;

  private readonly onDrop?: (events: WsUsageEvent[], reason: DropReason) => void;

  private buffer: WsUsageEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dropped = 0;
  /** Invalid-event count per field, for WARN throttling. */
  private readonly invalidSeen = new Map<string, number>();

  constructor(config: AforoWsConfig) {
    this.config = {
      tenantId: config.tenantId,
      productId: config.productId,
      apiKey: config.apiKey,
      ingestorUrl: config.ingestorUrl,
    };
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.flushCount = config.flushCount ?? 100;
    this.flushIntervalMs = config.flushIntervalMs ?? 3000;
    this.perFrameEvents = config.perFrameEvents ?? false;
    this.onError = config.onError ?? ((err) => console.error('[aforo-ws]', err.message));
    this.onDrop = config.onDrop;
    this.startTimer();
  }

  /** Wrap a `ws` WebSocketServer (or any object emitting 'connection' events). */
  wrapServer(wss: MinimalWss, options: WrapServerOptions): void {
    wss.on('connection', (ws, req) => {
      const customerId = options.extractCustomerId(req);
      if (!customerId || !customerId.trim()) return; // no customer resolved → skip metering
      const metadata = options.extractMetadata?.(req);
      const status = options.executionStatus;
      this.trackConnection(ws, {
        customerId,
        metadata,
        executionStatus: typeof status === 'function' ? (event) => status(event, req) : status,
        productType: options.productType,
      });
    });
  }

  /** Track a single WebSocket connection. Returns an unsubscribe function. */
  trackConnection(
    ws: MinimalWs,
    opts: TrackConnectionOptions
  ): () => void {
    // No customer resolved — the connection is not billable, not a drop.
    if (typeof opts.customerId !== 'string' || !opts.customerId.trim()) return () => {};
    const connectionId = randomUUID();
    const productType = normalizeProductType(opts.productType) ?? this.productType;
    const start = Date.now();
    let sentCount = 0;
    let recvCount = 0;
    let sentBytes = 0;
    let recvBytes = 0;

    // Emit CONNECTION_OPENED immediately
    this.push({
      customerId: opts.customerId,
      wsConnectionId: connectionId,
      productType,
      wsDirection: 'SERVER_TO_CLIENT',
      wsFrameType: 'PING', // "handshake complete" marker; not an actual frame
      messageCount: 0,
      dataBytes: 0,
      executionDurationMs: 0,
      metadata: { ...(opts.metadata ?? {}), event: 'CONNECTION_OPENED' },
    });

    ws.on('message', (data: any, isBinary?: boolean) => {
      recvCount++;
      const bytes = estimateBytes(data);
      recvBytes += bytes;
      if (this.perFrameEvents) {
        this.push({
          customerId: opts.customerId,
          wsConnectionId: connectionId,
          productType,
          wsDirection: 'CLIENT_TO_SERVER',
          wsFrameType: isBinary ? 'BINARY' : 'TEXT',
          messageCount: 1,
          dataBytes: bytes,
          executionDurationMs: Date.now() - start,
          metadata: opts.metadata,
        });
      }
    });

    // Wrap send() to count outbound frames
    const origSend = ws.send.bind(ws);
    ws.send = (data: any, cb?: (err?: Error) => void) => {
      sentCount++;
      const bytes = estimateBytes(data);
      sentBytes += bytes;
      if (this.perFrameEvents) {
        this.push({
          customerId: opts.customerId,
          wsConnectionId: connectionId,
          productType,
          wsDirection: 'SERVER_TO_CLIENT',
          wsFrameType: typeof data === 'string' ? 'TEXT' : 'BINARY',
          messageCount: 1,
          dataBytes: bytes,
          executionDurationMs: Date.now() - start,
          metadata: opts.metadata,
        });
      }
      return origSend(data, cb);
    };

    // opts.executionStatus is the connection's outcome: only the closing events
    // below carry it (same as the Python SDK), never OPENED or per-frame events.
    ws.on('close', (code: number) => {
      // Emit CONNECTION_CLOSED with aggregated counters — this is the billing anchor.
      this.push({
        customerId: opts.customerId,
        wsConnectionId: connectionId,
        productType,
        wsDirection: 'SERVER_TO_CLIENT',
        wsFrameType: 'CLOSE',
        wsCloseReason: CLOSE_REASONS[code] ?? 'NORMAL_CLOSURE',
        messageCount: sentCount + recvCount,
        dataBytes: sentBytes + recvBytes,
        executionDurationMs: Date.now() - start,
        metadata: {
          ...(opts.metadata ?? {}),
          event: 'CONNECTION_CLOSED',
          sentCount,
          recvCount,
          sentBytes,
          recvBytes,
          closeCode: code,
        },
      }, opts.executionStatus);
    });

    ws.on('error', (err: Error) => {
      this.push({
        customerId: opts.customerId,
        wsConnectionId: connectionId,
        productType,
        wsDirection: 'SERVER_TO_CLIENT',
        wsFrameType: 'CLOSE',
        wsCloseReason: 'INTERNAL_ERROR',
        messageCount: sentCount + recvCount,
        dataBytes: sentBytes + recvBytes,
        executionDurationMs: Date.now() - start,
        metadata: { ...(opts.metadata ?? {}), event: 'CONNECTION_ERROR', error: err.message },
      }, opts.executionStatus);
    });

    return () => {
      // Tracking lifetime is managed by the close handler — no manual cleanup needed.
    };
  }

  private push(
    partial: Omit<WsUsageEvent, 'metricName' | 'quantity' | 'occurredAt' | 'idempotencyKey' | 'executionStatus'>,
    executionStatus?: ExecutionStatusOption
  ): void {
    const now = new Date();
    const event: WsUsageEvent = {
      ...partial,
      metricName: partial.wsFrameType === 'CLOSE'
        ? 'websocket_api.connection_closed'
        : 'websocket_api.message',
      quantity: 1,
      occurredAt: now.toISOString(),
      // Minted once, here. SDK-generated; tail-trimmed to the ingestor's limit,
      // keeping the unique millis:random suffix.
      idempotencyKey: `ws:${this.config.tenantId}:${partial.wsConnectionId}:${partial.wsFrameType}:${now.getTime()}:${randomSuffix()}`.slice(-MAX_IDEMPOTENCY_KEY),
      metadata: {
        ...(partial.metadata ?? {}),
        sdkVersion: SDK_VERSION,
        productId: this.config.productId,
      },
    };
    const checked = checkExecutionStatus(resolveExecutionStatus(executionStatus, event));
    if (checked.problem) this.reportError(new Error(`[aforo-ws] ${checked.problem}`));
    if (checked.status) event.executionStatus = checked.status;

    // An event the ingestor would reject is not sent (one bad event fails its
    // whole batch): it is dropped here with reason 'invalid', never thrown
    // into the socket handlers.
    const invalid =
      tooLong('customerId', event.customerId, MAX_CUSTOMER_ID) ??
      tooLong('productType', event.productType, MAX_PRODUCT_TYPE);
    if (invalid) {
      this.recordInvalid(event, invalid);
      return;
    }

    this.buffer.push(event);
    if (this.buffer.length >= this.flushCount) {
      void this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const pending = this.buffer.splice(0, this.buffer.length);
    // The ingestor accepts at most MAX_BATCH_EVENTS events per request.
    for (let i = 0; i < pending.length; i += MAX_BATCH_EVENTS) {
      await this.send(pending.slice(i, i + MAX_BATCH_EVENTS));
    }
  }

  private async send(batch: WsUsageEvent[]): Promise<void> {
    // Serialized once, so every retry re-sends the same idempotencyKeys.
    const body = JSON.stringify({ events: batch });
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      let res: Response | undefined;
      let networkError: Error | undefined;
      try {
        res = await fetch(this.config.ingestorUrl.replace(/\/$/, '') + '/v1/ingest/batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.config.apiKey,
            'X-Tenant-Id': this.config.tenantId,
          },
          body,
        });
      } catch (err) {
        networkError = err as Error;
      }

      if (res) {
        if (res.ok) {
          await this.handlePartialFailures(res, batch);
          return;
        }
        if (!isRetryableStatus(res.status)) {
          // 4xx other than 408/429: the same body would be refused again.
          const { details } = await readBatchResult(res, batch.length);
          this.recordDrop(batch, 'rejected');
          this.reportError(new Error(`WebSocket metering batch rejected with HTTP ${res.status}${details ? ` — ${details}` : ''} (dropped ${batch.length} events, not retried)`));
          return;
        }
        delayMs = parseRetryAfter(res) ?? delayMs;
      } else if (attempt === maxRetries) {
        this.recordDrop(batch, 'retry_exhausted');
        this.reportError(networkError ?? new Error('WebSocket metering request failed'));
        return;
      }
      if (attempt < maxRetries) await sleep(delayMs);
    }
    // Not re-queued: dropping avoids unbounded memory growth.
    this.recordDrop(batch, 'retry_exhausted');
    this.reportError(new Error(`WebSocket metering flush failed after ${maxRetries} attempts (dropped ${batch.length} events)`));
  }

  /**
   * A 2xx can still carry per-event rejections:
   * `{accepted, duplicates, failed, errors:[{index, message}]}`. Events the
   * response names by index are dropped with reason 'rejected'; a `failed`
   * count the response does not attribute to an index is counted only.
   */
  private async handlePartialFailures(res: Response, batch: WsUsageEvent[]): Promise<void> {
    const { failed, details, indexes } = await readBatchResult(res, batch.length);
    if (failed <= 0) return;
    if (indexes.length > 0) this.recordDrop(indexes.map((i) => batch[i]), 'rejected');
    const unattributed = Math.min(failed, batch.length) - indexes.length;
    if (unattributed > 0) {
      this.dropped += unattributed;
      console.warn(
        `[aforo-ws] Dropped ${unattributed} event(s) — rejected, not identified by the ingestor (${this.dropped} total dropped).`,
      );
    }
    this.reportError(new Error(`Aforo ingestor rejected ${failed} event(s)${details ? ` — ${details}` : ''}`));
  }

  /** Invoke onError; a hook bug must never break metering or flushing. */
  private reportError(err: Error): void {
    try {
      this.onError(err);
    } catch {
      // ignore
    }
  }

  /** Number of events permanently dropped since this instance was created. */
  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Account for permanently lost events: bump the counter, WARN-log, and
   * invoke the opt-in onDrop hook. The buffer is drained at flush start, so
   * drops here are bounded by flush cadence — no log throttle needed.
   */
  private recordDrop(events: WsUsageEvent[], reason: DropReason): void {
    this.dropped += events.length;
    console.warn(
      `[aforo-ws] Dropped ${events.length} event(s) — ${reason} (${this.dropped} total dropped).`,
    );
    this.notifyDrop(events, reason);
  }

  /**
   * Account for an event that failed a client-side check: never buffered,
   * never sent. Runs on the hot path, so the WARN is throttled per field
   * (first occurrence, then every 1000th).
   */
  private recordInvalid(event: WsUsageEvent, invalid: InvalidField): void {
    this.dropped += 1;
    const seen = (this.invalidSeen.get(invalid.field) ?? 0) + 1;
    this.invalidSeen.set(invalid.field, seen);
    if (seen === 1 || seen % 1000 === 0) {
      console.warn(
        `[aforo-ws] Dropped 1 event — invalid: ${invalid.problem} ` +
          `(${seen} for ${invalid.field}, ${this.dropped} total dropped).`,
      );
    }
    this.notifyDrop([event], 'invalid');
  }

  private notifyDrop(events: WsUsageEvent[], reason: DropReason): void {
    if (!this.onDrop) return;
    try {
      this.onDrop(events, reason);
    } catch {
      // A hook bug must never break metering or flushing.
    }
  }

  private startTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    // Unref so the background timer never blocks host-process exit (final flush still needs shutdown()).
    if (typeof (this.flushTimer as any).unref === 'function') (this.flushTimer as any).unref();
  }

  /** Flush any buffered events and stop the background timer. Call before process exit. */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function estimateBytes(data: any): number {
  if (data == null) return 0;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer?.(data)) return data.length;
  if (data?.byteLength != null) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((s, d) => s + estimateBytes(d), 0);
  return 0;
}

/** Statuses the Aforo ingestor accepts (contract/ingest-contract.json, max 20 chars). */
const CANONICAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  'SUCCESS', 'PARTIAL', 'TIMEOUT', 'ERROR', 'VALIDATION_FAILED', 'FAILED',
  'FAILURE', 'CANCELLED', 'PENDING', 'BLOCKED', 'HITL_REQUIRED',
]);

/**
 * Check a caller-supplied status. `{ status }` when canonical; `{ problem }`
 * when it has to be left off the event (an unknown value would make the
 * ingestor reject the event; a Promise from an async resolver can't be
 * awaited on this path); `{}` when blank or absent.
 */
function checkExecutionStatus(value: unknown): { status?: string; problem?: string } {
  if (value !== null && typeof value === 'object' && typeof (value as any).then === 'function') {
    // Swallow a later rejection so it doesn't surface as an unhandled rejection.
    (value as PromiseLike<unknown>).then(undefined, () => {});
    return { problem: 'executionStatus resolver returned a Promise — resolvers must be synchronous; field omitted' };
  }
  const status = normalizeExecutionStatus(value);
  if (!status) return {};
  if (!CANONICAL_EXECUTION_STATUSES.has(status)) {
    return {
      problem: `unknown executionStatus "${status.slice(0, 40)}" — field omitted. ` +
        `Expected one of: ${[...CANONICAL_EXECUTION_STATUSES].join(', ')}`,
    };
  }
  return { status };
}

/** Trim + upper-case; blank/absent → undefined (key omitted from the wire body). */
function normalizeExecutionStatus(value?: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

function resolveExecutionStatus(option: ExecutionStatusOption, event: WsUsageEvent): unknown {
  if (typeof option !== 'function') return option;
  try {
    return option(event);
  } catch {
    return undefined; // a resolver bug must never break metering
  }
}

/** Trim + uppercase a product type; blank/non-string → undefined (unknown values pass through). */
function normalizeProductType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

/** A client-side check an event failed: which field, and a message naming the limit and the value. */
interface InvalidField {
  field: string;
  problem: string;
}

/** The offending value for a WARN line, cut to 80 chars. */
function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);
}

/** Limits mirror the ingestor's IngestUsageEventRequest; over-limit values are never truncated. */
function tooLong(field: string, value: unknown, max: number): InvalidField | undefined {
  if (typeof value !== 'string' || value.length <= max) return undefined;
  return { field, problem: `${field} is ${value.length} chars, limit ${max}: ${preview(value)}` };
}

/** Network errors, 408, 429 and 5xx are transient; every other 4xx (400/401/403/422...) is not. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Retry-After (delta-seconds or HTTP date) in ms, capped at MAX_RETRY_AFTER_MS. */
function parseRetryAfter(res: Response): number | undefined {
  const raw = (res as any)?.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  return undefined;
}

/**
 * Reads the ingestor's batch response body, if any: the `failed` count, the
 * first 5 `errors[].message` entries, and the batch indexes `errors[]` names.
 */
async function readBatchResult(
  res: Response,
  batchSize: number,
): Promise<{ failed: number; details: string; indexes: number[] }> {
  const none = { failed: 0, details: '', indexes: [] };
  if (typeof (res as any)?.json !== 'function') return none;
  try {
    const body: any = unwrapEnvelope(await res.json());
    const errors: any[] | undefined = Array.isArray(body?.errors) ? body.errors : undefined;
    const details = errors
      ? errors.slice(0, 5).map((e: any) => `#${e?.index}: ${e?.message}`).join('; ')
      : typeof body?.message === 'string' ? body.message : '';
    const indexes = [
      ...new Set(
        (errors ?? [])
          .map((e: any) => e?.index)
          .filter((i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < batchSize),
      ),
    ].sort((a, b) => a - b);
    const failed = typeof body?.failed === 'number' && body.failed > 0 ? body.failed : 0;
    return { failed, details, indexes };
  } catch {
    return none; // Non-JSON or empty body — nothing to report.
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const WS_CLOSE_REASONS = CLOSE_REASONS;

/**
 * The ingestor wraps every 2xx JSON body in `{success, data, meta}`. Returns
 * the inner `data` object when present, else the body unchanged (bare shape).
 */
function unwrapEnvelope(body: any): any {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body.data : undefined;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : body;
}
