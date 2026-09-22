/**
 * @aforo/ws-metering — Aforo WebSocket Metering SDK
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
 *   import { AforoWsBilling } from '@aforo/ws-metering';
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
}

export interface WrapServerOptions {
  /** Extract Aforo customer ID from the upgrade request. */
  extractCustomerId: (req: any) => string | undefined;
  /** Optional per-connection metadata (product-defined tags). */
  extractMetadata?: (req: any) => Record<string, unknown> | undefined;
  /** Product type for connections accepted by this server. Default: the client-level `productType`. */
  productType?: string;
}

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

const SDK_VERSION = '1.0.0';
/** Default top-level `productType` for this SDK. */
export const DEFAULT_PRODUCT_TYPE = 'WEBSOCKET_API';
/** Upper bound on a server-requested Retry-After wait. */
const MAX_RETRY_AFTER_MS = 30_000;
/** The ingestor rejects batch requests with more than 1000 events. */
const MAX_BATCH_EVENTS = 1000;
/** usage-ingestor limits (IngestUsageEventRequest). */
const MAX_CUSTOMER_ID = 64;
const MAX_IDEMPOTENCY_KEY = 255;

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

interface WsUsageEvent {
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

  private buffer: WsUsageEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

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
    this.startTimer();
  }

  /** Wrap a `ws` WebSocketServer (or any object emitting 'connection' events). */
  wrapServer(wss: MinimalWss, options: WrapServerOptions): void {
    wss.on('connection', (ws, req) => {
      const customerId = options.extractCustomerId(req);
      if (!customerId || !customerId.trim()) return; // no customer resolved → skip metering
      const metadata = options.extractMetadata?.(req);
      this.trackConnection(ws, { customerId, metadata, productType: options.productType });
    });
  }

  /** Track a single WebSocket connection. Returns an unsubscribe function. */
  trackConnection(
    ws: MinimalWs,
    opts: { customerId: string; metadata?: Record<string, unknown>; productType?: string }
  ): () => void {
    if (!opts.customerId || !opts.customerId.trim()) return () => {};
    if (opts.customerId.length > MAX_CUSTOMER_ID) {
      this.onError(new Error(`WebSocket metering: customerId longer than ${MAX_CUSTOMER_ID} chars; connection not metered`));
      return () => {};
    }
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
      });
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
      });
    });

    return () => {
      // Tracking lifetime is managed by the close handler — no manual cleanup needed.
    };
  }

  private push(partial: Omit<WsUsageEvent, 'metricName' | 'quantity' | 'occurredAt' | 'idempotencyKey'>): void {
    const now = new Date();
    const event: WsUsageEvent = {
      ...partial,
      metricName: partial.wsFrameType === 'CLOSE'
        ? 'websocket_api.connection_closed'
        : 'websocket_api.message',
      quantity: 1,
      occurredAt: now.toISOString(),
      // Tail-trimmed to the ingestor's limit, keeping the unique millis:random suffix.
      idempotencyKey: `ws:${this.config.tenantId}:${partial.wsConnectionId}:${partial.wsFrameType}:${now.getTime()}:${randomSuffix()}`.slice(-MAX_IDEMPOTENCY_KEY),
      metadata: {
        ...(partial.metadata ?? {}),
        sdkVersion: SDK_VERSION,
        productId: this.config.productId,
      },
    };
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
      let delayMs = Math.pow(2, attempt - 1) * 1000;
      try {
        const res = await fetch(this.config.ingestorUrl.replace(/\/$/, '') + '/v1/ingest/batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.config.apiKey,
            'X-Tenant-Id': this.config.tenantId,
          },
          body,
        });
        if (res.ok) {
          await this.reportPartialFailures(res);
          return;
        }
        if (!isRetryableStatus(res.status)) {
          const { details } = await readErrorMessages(res);
          this.onError(new Error(`WebSocket metering batch rejected with HTTP ${res.status}${details ? ` — ${details}` : ''} (dropped ${batch.length} events, not retried)`));
          return;
        }
        delayMs = parseRetryAfter(res) ?? delayMs;
      } catch (err) {
        if (attempt === maxRetries) {
          this.onError(err as Error);
          return;
        }
      }
      if (attempt < maxRetries) await sleep(delayMs);
    }
    this.onError(new Error(`WebSocket metering flush failed after ${maxRetries} attempts (dropped ${batch.length} events)`));
  }

  /** A 202 can still carry per-event rejections: `{accepted, duplicates, failed, errors:[{index, message}]}`. */
  private async reportPartialFailures(res: Response): Promise<void> {
    const { failed, details } = await readErrorMessages(res);
    if (failed && failed > 0) {
      this.onError(new Error(`Aforo ingestor rejected ${failed} event(s)${details ? ` — ${details}` : ''}`));
    }
  }

  private startTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    // Unref so the background timer never blocks host-process exit (final flush still needs shutdown()).
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      this.flushTimer.unref();
    }
    if (typeof (this.flushTimer as any).unref === 'function') (this.flushTimer as any).unref();
  }

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

/** Trim + uppercase a product type; blank/non-string → undefined (unknown values pass through). */
function normalizeProductType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
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

/** Reads the ingestor's `errors[].message` entries (first 5) from a response body, if any. */
async function readErrorMessages(res: Response): Promise<{ failed?: number; details: string }> {
  if (typeof (res as any)?.json !== 'function') return { details: '' };
  try {
    const body: any = await res.json();
    const details = Array.isArray(body?.errors)
      ? body.errors.slice(0, 5).map((e: any) => `#${e?.index}: ${e?.message}`).join('; ')
      : typeof body?.message === 'string' ? body.message : '';
    return { failed: typeof body?.failed === 'number' ? body.failed : undefined, details };
  } catch {
    return { details: '' }; // Non-JSON or empty body — nothing to report.
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const WS_CLOSE_REASONS = CLOSE_REASONS;
