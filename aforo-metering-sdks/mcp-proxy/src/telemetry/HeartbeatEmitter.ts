/**
 * @file Session heartbeat emitter.
 *
 * Sends `system.session.heartbeat` events for the active session: one when the
 * session starts, one every `intervalMs`, and a final SESSION_END on stop.
 *
 * Heartbeats are intercepted by the ingestor before billing, but only on its
 * synchronous batch path -- a batch larger than the ingestor's batch threshold
 * goes to the high-throughput engine, which does not intercept them -- and every
 * event must still pass bean validation (quantity > 0, non-blank customerId). So
 * each heartbeat carries quantity 1 and is POSTed in its OWN request
 * (`{"events":[heartbeat]}`), never pushed into the usage buffer. Heartbeats are
 * best-effort: sent once, failures logged and ignored, never affecting usage
 * delivery. The timer is unref'd so it never keeps the process alive.
 */

import type { ProxyUsageEvent, BatchIngestResponse } from '../types.js';
import type { EventBuffer } from './EventBuffer.js';
import { generateHeartbeatKey } from '../util/idempotency.js';
import { logger } from '../util/logger.js';

const PROXY_VERSION = '1.0.0';
/** customerId on heartbeats when no customer is known; heartbeats are never billed. */
export const HEARTBEAT_FALLBACK_CUSTOMER_ID = 'system';

/** The part of IngestorClient the emitter needs. */
export interface HeartbeatSender {
  sendSingle(event: ProxyUsageEvent): Promise<BatchIngestResponse | null>;
}

export interface HeartbeatConfig {
  intervalMs: number;
  /** Sends each heartbeat in its own request (the IngestorClient). */
  client: HeartbeatSender;
  /** @deprecated Unused: heartbeats are never pushed into the usage buffer. */
  buffer?: EventBuffer;
  tenantId: string;
  productId: string;
  transport: string;
  /** Configured customer (AFORO_CUSTOMER_ID); preferred heartbeat customerId. */
  customerId?: string;
  /** productType reported on heartbeats (default MCP_SERVER). */
  productType?: string;
}

export class HeartbeatEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly client: HeartbeatSender;
  private readonly productId: string;
  private readonly transport: string;
  private readonly customerId?: string;
  private readonly productType: string;
  private sessionId: string | null = null;
  private sessionStartedAt: number | null = null;
  private sessionCustomerId: string | null = null;

  constructor(config: HeartbeatConfig) {
    this.intervalMs = config.intervalMs;
    this.client = config.client;
    this.productId = config.productId;
    this.transport = config.transport;
    this.customerId = config.customerId?.trim() || undefined;
    this.productType = config.productType?.trim().toUpperCase() || 'MCP_SERVER';
  }

  /**
   * Start the session and its heartbeats. `customerId` (e.g. the first tool
   * call's customer) is used when no customer is configured.
   */
  startSession(sessionId: string, customerId?: string): void {
    if (this.sessionId) return; // Already tracking a session

    this.sessionId = sessionId;
    this.sessionStartedAt = Date.now();
    this.sessionCustomerId = customerId?.trim() || null;
    logger.info('Session started', { sessionId });

    void this.emit('HEARTBEAT');
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => { void this.emit('HEARTBEAT'); }, this.intervalMs);
      if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) this.timer.unref();
    }
  }

  /** Stop heartbeats and send a final SESSION_END (best-effort; resolves when it was sent or failed). */
  async stopSession(): Promise<void> {
    if (!this.sessionId) return;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const end = this.emit('SESSION_END');

    logger.info('Session stopped', { sessionId: this.sessionId });
    this.sessionId = null;
    this.sessionStartedAt = null;
    this.sessionCustomerId = null;
    await end;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  private async emit(boundary: 'HEARTBEAT' | 'SESSION_END'): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;

    const customerId = this.customerId ?? this.sessionCustomerId ?? HEARTBEAT_FALLBACK_CUSTOMER_ID;
    const now = Date.now();
    let processMemoryMb: number | undefined;
    try {
      processMemoryMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    } catch {
      // Not available in all runtimes
    }

    const event: ProxyUsageEvent = {
      customerId,
      metricName: 'system.session.heartbeat',
      // quantity 0 fails @Positive validation; heartbeats are never billed.
      quantity: 1,
      occurredAt: new Date(now).toISOString(),
      idempotencyKey: generateHeartbeatKey(sessionId),
      productType: this.productType,
      sessionId,
      sessionBoundary: boundary,
      executionStatus: 'SUCCESS',
      metadata: {
        sessionId,
        sessionBoundary: boundary,
        productType: this.productType,
        heartbeatType: boundary === 'HEARTBEAT' ? 'PERIODIC' : 'SESSION_END',
        uptimeMs: now - (this.sessionStartedAt ?? now),
        productId: this.productId,
        transport: this.transport,
        proxy: true,
        proxyVersion: PROXY_VERSION,
        ...(processMemoryMb != null ? { processMemoryMb } : {}),
      },
    };

    try {
      const result = await this.client.sendSingle(event);
      if (!result) {
        logger.debug('Heartbeat not delivered — ignored', { sessionId, boundary });
      } else if (result.killedSessionIds?.includes(sessionId)) {
        logger.warn('Ingestor reports this session as killed', { sessionId });
      }
    } catch (err) {
      logger.debug('Heartbeat failed — ignored', { sessionId, error: (err as Error).message });
    }
  }
}
