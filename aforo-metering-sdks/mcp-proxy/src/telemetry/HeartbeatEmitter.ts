/**
 * @file Session heartbeat emitter — 30s periodic heartbeats with
 * SESSION_START / HEARTBEAT / SESSION_END boundary markers.
 * Pattern reused from aforo-metering-sdks/node-mcp/src/index.ts
 */

import type { ProxyUsageEvent } from '../types.js';
import type { EventBuffer } from './EventBuffer.js';
import { generateHeartbeatKey } from '../util/idempotency.js';
import { logger } from '../util/logger.js';

const PROXY_VERSION = '1.0.0';

export interface HeartbeatConfig {
  intervalMs: number;
  buffer: EventBuffer;
  tenantId: string;
  productId: string;
  transport: string;
}

export class HeartbeatEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly buffer: EventBuffer;
  private readonly tenantId: string;
  private readonly productId: string;
  private readonly transport: string;
  private sessionId: string | null = null;
  private sessionStartedAt: number | null = null;

  constructor(config: HeartbeatConfig) {
    this.intervalMs = config.intervalMs;
    this.buffer = config.buffer;
    this.tenantId = config.tenantId;
    this.productId = config.productId;
    this.transport = config.transport;
  }

  startSession(sessionId: string): void {
    if (this.timer) return; // Already running

    this.sessionId = sessionId;
    this.sessionStartedAt = Date.now();

    // Emit SESSION_START immediately
    this.emit('SESSION_START');

    // Then periodic heartbeats
    this.timer = setInterval(() => this.emit('HEARTBEAT'), this.intervalMs);
    logger.info('Heartbeat started', { sessionId, intervalMs: this.intervalMs });
  }

  async stopSession(): Promise<void> {
    if (!this.sessionId) return;

    // Emit final SESSION_END
    this.emit('SESSION_END');

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    logger.info('Heartbeat stopped', { sessionId: this.sessionId });
    this.sessionId = null;
    this.sessionStartedAt = null;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  private emit(boundary: 'SESSION_START' | 'HEARTBEAT' | 'SESSION_END'): void {
    if (!this.sessionId) return;

    let processMemoryMb: number | undefined;
    try {
      processMemoryMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    } catch {
      // Not available in all runtimes
    }

    const event: ProxyUsageEvent = {
      customerId: this.tenantId,
      metricName: 'system.session.heartbeat',
      quantity: 0,
      occurredAt: new Date().toISOString(),
      idempotencyKey: generateHeartbeatKey(this.sessionId),
      productType: 'MCP_SERVER',
      agentId: '',
      sessionId: this.sessionId,
      sessionBoundary: boundary,
      executionStatus: 'SUCCESS',
      metadata: {
        productId: this.productId,
        transport: this.transport,
        proxy: true,
        proxyVersion: PROXY_VERSION,
        heartbeatType: boundary === 'HEARTBEAT' ? 'PERIODIC' : boundary,
        uptimeMs: Date.now() - (this.sessionStartedAt ?? Date.now()),
        ...(processMemoryMb != null ? { processMemoryMb } : {}),
      },
    };

    this.buffer.push(event);
  }
}
