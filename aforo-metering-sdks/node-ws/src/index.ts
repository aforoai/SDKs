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
 *     ingestorUrl: 'https://ingestor.aforo.ai',
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
  productType: 'WEBSOCKET_API';
  wsConnectionId: string;
  wsDirection: 'CLIENT_TO_SERVER' | 'SERVER_TO_CLIENT';
  wsFrameType: 'TEXT' | 'BINARY' | 'PING' | 'PONG' | 'CLOSE';
  wsCloseReason?: string;
  messageCount: number;
  dataBytes: number;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export class AforoWsBilling {
  private readonly config: Required<
    Pick<AforoWsConfig, 'tenantId' | 'productId' | 'apiKey' | 'ingestorUrl'>
  >;
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
      if (!customerId) return; // no customer resolved → skip metering
      const metadata = options.extractMetadata?.(req);
      this.trackConnection(ws, { customerId, metadata });
    });
  }

  /** Track a single WebSocket connection. Returns an unsubscribe function. */
  trackConnection(
    ws: MinimalWs,
    opts: { customerId: string; metadata?: Record<string, unknown> }
  ): () => void {
    const connectionId = randomUUID();
    const start = Date.now();
    let sentCount = 0;
    let recvCount = 0;
    let sentBytes = 0;
    let recvBytes = 0;

    // Emit CONNECTION_OPENED immediately
    this.push({
      customerId: opts.customerId,
      wsConnectionId: connectionId,
      wsDirection: 'SERVER_TO_CLIENT',
      wsFrameType: 'PING', // "handshake complete" marker; not an actual frame
      messageCount: 0,
      dataBytes: 0,
      durationMs: 0,
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
          wsDirection: 'CLIENT_TO_SERVER',
          wsFrameType: isBinary ? 'BINARY' : 'TEXT',
          messageCount: 1,
          dataBytes: bytes,
          durationMs: Date.now() - start,
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
          wsDirection: 'SERVER_TO_CLIENT',
          wsFrameType: typeof data === 'string' ? 'TEXT' : 'BINARY',
          messageCount: 1,
          dataBytes: bytes,
          durationMs: Date.now() - start,
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
        wsDirection: 'SERVER_TO_CLIENT',
        wsFrameType: 'CLOSE',
        wsCloseReason: CLOSE_REASONS[code] ?? 'NORMAL_CLOSURE',
        messageCount: sentCount + recvCount,
        dataBytes: sentBytes + recvBytes,
        durationMs: Date.now() - start,
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
        wsDirection: 'SERVER_TO_CLIENT',
        wsFrameType: 'CLOSE',
        wsCloseReason: 'INTERNAL_ERROR',
        messageCount: sentCount + recvCount,
        dataBytes: sentBytes + recvBytes,
        durationMs: Date.now() - start,
        metadata: { ...(opts.metadata ?? {}), event: 'CONNECTION_ERROR', error: err.message },
      });
    });

    return () => {
      // Tracking lifetime is managed by the close handler — no manual cleanup needed.
    };
  }

  private push(partial: Omit<WsUsageEvent, 'metricName' | 'quantity' | 'occurredAt' | 'idempotencyKey' | 'productType'>): void {
    const now = new Date();
    const event: WsUsageEvent = {
      ...partial,
      metricName: partial.wsFrameType === 'CLOSE'
        ? 'websocket_api.connection_closed'
        : 'websocket_api.message',
      quantity: 1,
      occurredAt: now.toISOString(),
      idempotencyKey: `ws:${this.config.tenantId}:${partial.wsConnectionId}:${partial.wsFrameType}:${now.getTime()}:${randomSuffix()}`,
      productType: 'WEBSOCKET_API',
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
    const batch = this.buffer.splice(0, this.buffer.length);
    const body = JSON.stringify({ events: batch });
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(this.config.ingestorUrl.replace(/\/$/, '') + '/v1/ingest/events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
            'X-Tenant-Id': this.config.tenantId,
          },
          body,
        });
        if (res.ok) return;
      } catch (err) {
        if (attempt === maxRetries) {
          this.onError(err as Error);
          return;
        }
      }
      await sleep(Math.pow(2, attempt - 1) * 1000);
    }
    this.onError(new Error(`WebSocket metering flush failed after ${maxRetries} attempts (dropped ${batch.length} events)`));
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

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const WS_CLOSE_REASONS = CLOSE_REASONS;
