/**
 * @file Session tracker (formerly the heartbeat emitter).
 *
 * Heartbeats are NOT sent. This used to push `system.session.heartbeat` events
 * (customerId = tenantId, quantity 0) into the usage batch every 30s plus
 * SESSION_START / SESSION_END markers. The ingestor validates every event in a
 * batch -- quantity must be positive -- and rejects the whole batch with 400
 * when one event is invalid, so each heartbeat took every real tool call
 * batched with it down. The ingestor has no dedicated heartbeat endpoint, so
 * there is nowhere correct to send them. The class name and config are kept so
 * existing wiring and `heartbeatIntervalMs` configs keep working (the interval
 * is now ignored).
 */

import type { EventBuffer } from './EventBuffer.js';
import { logger } from '../util/logger.js';

export interface HeartbeatConfig {
  /** @deprecated Ignored: heartbeats are not sent. */
  intervalMs: number;
  /** @deprecated Unused: nothing is pushed into the usage buffer. */
  buffer: EventBuffer;
  tenantId: string;
  productId: string;
  transport: string;
}

export class HeartbeatEmitter {
  private sessionId: string | null = null;

  constructor(_config: HeartbeatConfig) {}

  startSession(sessionId: string): void {
    if (this.sessionId) return; // Already tracking a session

    this.sessionId = sessionId;
    logger.info('Session started', { sessionId });
  }

  async stopSession(): Promise<void> {
    if (!this.sessionId) return;

    logger.info('Session stopped', { sessionId: this.sessionId });
    this.sessionId = null;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }
}
