/**
 * @aforoai/ws-metering — Aforo WebSocket Metering SDK
 *
 * Wraps WebSocket server connections to emit three classes of billing events:
 *   - CONNECTION_OPENED  — once on upgrade completion (wsFrameType OPEN,
 *                          metric websocket_api.connection_opened)
 *   - MESSAGE            — one event per frame (direction + bytes + type)
 *   - CONNECTION_CLOSED  — once per connection, carrying aggregated counters +
 *                          duration: on close, on a socket error, when an idle
 *                          connection is swept, or at shutdown
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
 *     // Who is billed, from identity your app verified at upgrade time.
 *     customerResolver: (req) => sessionStore.customerFor(req),
 *   });
 *
 *   // The SDK installs no signal handlers. Flush from your own:
 *   process.once('SIGTERM', async () => { await billing.shutdown(); process.exit(0); });
 */

import { randomUUID } from 'node:crypto';
import { TransportCore, CoreDropReason } from './transport-core/core';

/** What onError receives for delivery problems: branch on `kind`, read `events`. */
export { CoreTransportError, type CoreErrorKind } from './transport-core/core';

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
  /** Allow a plain http:// ingestorUrl on a non-local host. Default false (https required). */
  allowInsecureHttp?: boolean;
  /** Events per request (default 500, max 1000). Reaching it wakes the background sender. */
  flushCount?: number;
  /** The background sender also runs this often, in ms (default 5000). */
  flushIntervalMs?: number;
  /** Queue capacity (default 10 000). The oldest event is dropped on overflow. */
  maxQueueSize?: number;
  /** Retries per batch before the breaker opens (default 3). */
  maxRetries?: number;
  /** Total deadline per request, in ms (default 10 000). */
  timeoutMs?: number;
  /** How long shutdown() keeps sending, in ms (default 5000). */
  shutdownTimeoutMs?: number;
  /** Send queued events on the process 'beforeExit' event (default true). */
  flushOnExit?: boolean;
  /** If true, emit one MESSAGE event per frame. If false (default) only aggregate on close. */
  perFrameEvents?: boolean;
  /**
   * Close a tracked connection that saw no frame for this long, in ms
   * (default 3 600 000 = 1 hour): it gets a CONNECTION_CLOSED with close
   * reason ABNORMAL_CLOSURE and metadata `closedBy: "sdk_idle_timeout"`. This
   * keeps the open-connection map bounded when a socket dies without a close
   * event. Must be a positive number; 0 means the default.
   */
  connectionIdleTimeoutMs?: number;
  /** Callback for delivery problems (rejected batches, ingestor outages) and bad executionStatus values. */
  onError?: (error: Error) => void;
  /**
   * Opt-in hook receiving events that were permanently dropped (see
   * DropReason). Events keep their idempotency keys,
   * so persisting and re-submitting them after recovery is dedup-safe.
   * Exceptions thrown by the hook are swallowed. Default: none (drops are
   * still counted in droppedCount and WARN-logged).
   */
  onDrop?: (events: WsUsageEvent[], reason: DropReason) => void;
}

/**
 * Why events were permanently dropped. `overflow`: the queue was full and the
 * oldest event was evicted. `rejected`: the ingestor refused the batch
 * (non-retryable 4xx) or individual events of an accepted batch. `invalid`:
 * the event failed a client-side check, or the customer resolver returned no
 * customer. `shutdown`: still queued when the shutdown deadline passed.
 * `closed`: recorded after shutdown(). `retry_exhausted`: kept for
 * compatibility, not produced by 2.x — an outage keeps events queued.
 */
export type DropReason = 'overflow' | 'retry_exhausted' | 'rejected' | 'invalid' | 'shutdown' | 'closed';

export interface WrapServerOptions {
  /**
   * Who is billed for a connection, from identity your app verified on the
   * upgrade request (session cookie, verified token). Required unless
   * `trustCustomerHeader` is true. Returning nothing drops the connection's
   * opening event as 'invalid' (counted); the connection is not affected.
   */
  customerResolver?: (req: any) => string | undefined | null;
  /** @deprecated Use `customerResolver` (same signature). */
  extractCustomerId?: (req: any) => string | undefined | null;
  /**
   * Bill the `x-customer-id` header of the upgrade request. Any client can
   * set that header, so only turn this on behind a proxy you control that
   * sets it. Default false.
   */
  trustCustomerHeader?: boolean;
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
  /** `ws` takes (data, cb) or (data, options, cb); every argument is passed through. */
  send(data: any, ...rest: any[]): void;
  readyState?: number;
}

/** Minimal WebSocketServer surface — matches `ws` WebSocketServer. */
interface MinimalWss {
  on(event: 'connection', fn: (ws: MinimalWs, req: any) => void): void;
}

const SDK_VERSION = '2.0.0';
/** Default for AforoWsConfig.connectionIdleTimeoutMs: one hour. */
export const DEFAULT_CONNECTION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** One tracked connection: its counters and how to bill its close. */
interface OpenConnection {
  lastActivity: number;
  /** Emit CONNECTION_CLOSED once; returns false when it was already closed. */
  close(code: number, closedBy?: string): boolean;
}
/** Default top-level `productType` for this SDK. */
export const DEFAULT_PRODUCT_TYPE = 'WEBSOCKET_API';
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
  wsFrameType: 'OPEN' | 'TEXT' | 'BINARY' | 'PING' | 'PONG' | 'CLOSE';
  wsCloseReason?: string;
  messageCount: number;
  dataBytes: number;
  executionDurationMs: number;
  metadata?: Record<string, unknown>;
  /** Normalized (trimmed, upper-cased) execution status; omitted when not set. */
  executionStatus?: string;
}

export class AforoWsBilling {
  private readonly config: Required<Pick<AforoWsConfig, 'tenantId' | 'productId'>>;
  private readonly productType: string;
  private readonly perFrameEvents: boolean;
  private readonly onError: (error: Error) => void;
  private readonly core: TransportCore<WsUsageEvent>;
  private readonly idleTimeoutMs: number;
  private readonly connections = new Map<string, OpenConnection>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private shutdownPromise: Promise<void> | null = null;

  constructor(config: AforoWsConfig) {
    const idle = config.connectionIdleTimeoutMs;
    if (idle !== undefined && (typeof idle !== 'number' || !Number.isFinite(idle) || idle < 0)) {
      throw new Error(
        `[aforo-ws] connectionIdleTimeoutMs must be a positive number of milliseconds (got ${String(idle)}); ` +
          'without it connections that die without a close event are never released.',
      );
    }
    this.idleTimeoutMs = idle ? idle : DEFAULT_CONNECTION_IDLE_TIMEOUT_MS;
    this.config = {
      tenantId: config.tenantId,
      productId: config.productId,
    };
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.perFrameEvents = config.perFrameEvents ?? false;
    this.onError = config.onError ?? ((err) => console.error('[aforo-ws]', err.message));
    const onDrop = config.onDrop;
    // The core is the only holder of the API key.
    this.core = new TransportCore<WsUsageEvent>({
      baseUrl: config.ingestorUrl,
      apiKey: config.apiKey,
      allowInsecureHttp: config.allowInsecureHttp,
      headers: { 'X-Tenant-Id': config.tenantId },
      userAgent: `aforo-ws-metering/${SDK_VERSION}`,
      flushCount: config.flushCount,
      flushIntervalMs: config.flushIntervalMs,
      maxQueueSize: config.maxQueueSize,
      maxRetries: config.maxRetries,
      timeoutMs: config.timeoutMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      flushOnExit: config.flushOnExit,
      logPrefix: '[aforo-ws]',
      onError: (err) => this.reportError(err),
      onDrop: onDrop ? (events, reason: CoreDropReason) => onDrop(events, reason as DropReason) : undefined,
    });
    const every = Math.min(60_000, Math.max(1_000, Math.floor(this.idleTimeoutMs / 4)));
    this.sweepTimer = setInterval(() => this.sweepIdleConnections(), every);
    this.sweepTimer.unref?.();
  }

  /** Connections being tracked: opened and not yet closed by the socket, the idle sweep or shutdown(). */
  get openConnections(): number {
    return this.connections.size;
  }

  /**
   * Close every tracked connection idle longer than `connectionIdleTimeoutMs`
   * at `now` (CONNECTION_CLOSED, ABNORMAL_CLOSURE, `closedBy: "sdk_idle_timeout"`).
   * Runs on a timer; callable directly. Returns how many it closed.
   */
  sweepIdleConnections(now: number = Date.now()): number {
    const cutoff = now - this.idleTimeoutMs;
    let closed = 0;
    for (const conn of Array.from(this.connections.values())) {
      if (conn.lastActivity <= cutoff && conn.close(1006, 'sdk_idle_timeout')) closed++;
    }
    return closed;
  }

  /**
   * Wrap a `ws` WebSocketServer (or any object emitting 'connection' events).
   * Throws when neither `customerResolver` nor `trustCustomerHeader: true` is given.
   */
  wrapServer(wss: MinimalWss, options: WrapServerOptions): void {
    const resolver = options?.customerResolver ?? options?.extractCustomerId;
    const trustHeader = options?.trustCustomerHeader === true;
    if (typeof resolver !== 'function' && !trustHeader) {
      throw new Error(
        '[aforo-ws] wrapServer needs a customerResolver: (req) => the Aforo customer id from identity your app ' +
          'verified on the upgrade request. To bill the x-customer-id header instead — only safe behind a proxy ' +
          'that sets it — pass trustCustomerHeader: true.',
      );
    }
    wss.on('connection', (ws, req) => {
      let customerId: string | undefined;
      try {
        customerId = textOrUndefined(typeof resolver === 'function' ? resolver(req) : undefined);
        if (!customerId && trustHeader) customerId = textOrUndefined(headerValue(req?.headers?.['x-customer-id']));
      } catch (err) {
        this.reportError(new Error(`[aforo-ws] customerResolver threw: ${(err as Error)?.message ?? err}`));
      }
      const metadata = options.extractMetadata?.(req);
      const status = options.executionStatus;
      this.trackConnection(ws, {
        customerId: customerId ?? '',
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
    const connectionId = randomUUID();
    const productType = normalizeProductType(opts.productType) ?? this.productType;
    if (typeof opts.customerId !== 'string' || !opts.customerId.trim()) {
      // No customer: the connection is not metered. Counted as one 'invalid' drop.
      this.core.reportDrop(
        [this.buildEvent({
          customerId: typeof opts.customerId === 'string' ? opts.customerId : '',
          wsConnectionId: connectionId,
          productType,
          wsDirection: 'SERVER_TO_CLIENT',
          wsFrameType: 'OPEN',
          messageCount: 0,
          dataBytes: 0,
          executionDurationMs: 0,
          metadata: { ...(opts.metadata ?? {}), event: 'CONNECTION_OPENED' },
        })],
        'invalid',
        'customer resolver returned no customer; the connection is not metered',
      );
      return () => {};
    }
    const openEvent = {
      customerId: opts.customerId,
      wsConnectionId: connectionId,
      productType,
      wsDirection: 'SERVER_TO_CLIENT' as const,
      wsFrameType: 'OPEN' as const, // handshake complete; not a frame on the wire
      messageCount: 0,
      dataBytes: 0,
      executionDurationMs: 0,
      metadata: { ...(opts.metadata ?? {}), event: 'CONNECTION_OPENED' },
    };
    if (this.shutdownPromise) {
      // Shutting down: a connection opened now could never get its CONNECTION_CLOSED.
      this.core.reportDrop([this.buildEvent(openEvent)], 'closed', 'connection opened after shutdown(); not metered');
      return () => {};
    }
    const start = Date.now();
    let sentCount = 0;
    let recvCount = 0;
    let sentBytes = 0;
    let recvBytes = 0;
    let closed = false;
    const conn: OpenConnection = {
      lastActivity: start,
      close: (code, closedBy) => {
        if (closed) return false;
        closed = true;
        this.connections.delete(connectionId);
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
            ...(closedBy ? { closedBy } : {}),
          },
        }, opts.executionStatus);
        return true;
      },
    };
    this.connections.set(connectionId, conn);

    // Emit CONNECTION_OPENED immediately
    this.push(openEvent);

    ws.on('message', (data: any, isBinary?: boolean) => {
      if (closed) return;
      conn.lastActivity = Date.now();
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
    ws.send = (data: any, ...rest: any[]) => {
      if (closed) return origSend(data, ...rest);
      conn.lastActivity = Date.now();
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
      return origSend(data, ...rest);
    };

    // opts.executionStatus is the connection's outcome: only the closing events
    // below carry it (same as the Python SDK), never OPENED or per-frame events.
    // 'error' is normally followed by 'close': bill the connection once,
    // with whichever of the two arrives first (or the idle sweep / shutdown).
    ws.on('close', (code: number) => {
      // CONNECTION_CLOSED with aggregated counters — this is the billing anchor.
      conn.close(code);
    });

    ws.on('error', (err: Error) => {
      if (closed) return;
      closed = true;
      this.connections.delete(connectionId);
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
        metadata: { ...(opts.metadata ?? {}), event: 'CONNECTION_ERROR', error: String(err?.message ?? err).slice(0, 200) },
      }, opts.executionStatus);
    });

    return () => {
      // Tracking lifetime is managed by the close handler, the idle sweep and shutdown().
    };
  }

  /** Fill in the fields every event carries. */
  private buildEvent(
    partial: Omit<WsUsageEvent, 'metricName' | 'quantity' | 'occurredAt' | 'idempotencyKey' | 'executionStatus'>,
  ): WsUsageEvent {
    const now = new Date();
    return {
      ...partial,
      metricName: partial.wsFrameType === 'CLOSE'
        ? 'websocket_api.connection_closed'
        : partial.wsFrameType === 'OPEN'
          ? 'websocket_api.connection_opened'
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
  }

  private push(
    partial: Omit<WsUsageEvent, 'metricName' | 'quantity' | 'occurredAt' | 'idempotencyKey' | 'executionStatus'>,
    executionStatus?: ExecutionStatusOption
  ): void {
    const event = this.buildEvent(partial);
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
      this.core.reportDrop([event], 'invalid', invalid.problem);
      return;
    }

    // Queue only; the core's single background sender does the HTTP.
    this.core.enqueue(event);
  }

  /** Invoke onError; a hook bug must never break metering or flushing. */
  private reportError(err: Error): void {
    try {
      this.onError(err);
    } catch (hookErr) {
      console.debug('[aforo-ws] onError hook threw', hookErr);
    }
  }

  /** Number of events permanently dropped since this instance was created (every DropReason). */
  get droppedCount(): number {
    return this.core.droppedCount;
  }

  /** Number of events waiting to be sent. */
  get queuedCount(): number {
    return this.core.queued;
  }

  /** Send what is queued now and wait for it (one request at a time; never concurrent). */
  async flush(): Promise<{ sent: number; failed: number; requeued: number; queued: number }> {
    return this.core.flush();
  }

  /**
   * Bill every connection still open with a CONNECTION_CLOSED (close code
   * 1001, GOING_AWAY, metadata `closedBy: "sdk_shutdown"`), stop accepting
   * events and send what is queued, for at most `shutdownTimeoutMs`. Events
   * still queued then are dropped with reason 'shutdown' (counted, passed to
   * onDrop). A connection opened from now on is reported as 'closed' and not
   * tracked. Calling it again returns the first call's promise. Call it from
   * your SIGTERM handler.
   */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = (async () => {
        clearInterval(this.sweepTimer);
        for (const conn of Array.from(this.connections.values())) conn.close(1001, 'sdk_shutdown');
        await this.core.shutdown();
      })();
    }
    return this.shutdownPromise;
  }

  toJSON(): Record<string, unknown> {
    return { tenantId: this.config.tenantId, productId: this.config.productId, queued: this.queuedCount, dropped: this.droppedCount };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `AforoWsBilling { tenantId: '${this.config.tenantId}', productId: '${this.config.productId}', queued: ${this.queuedCount}, dropped: ${this.droppedCount} }`;
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




function textOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function headerValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}


export const WS_CLOSE_REASONS = CLOSE_REASONS;
