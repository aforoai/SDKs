/**
 * @file Session lifecycle management.
 * - stdio: 1 session per process lifetime
 * - SSE: 1 session per SSE connection
 * - Streamable HTTP: 1 session per Mcp-Session-Id header (fallback to connection-scoped)
 */

import { randomUUID } from 'node:crypto';
import type { TransportType } from '../types.js';
import { logger } from '../util/logger.js';

export class SessionManager {
  private readonly transport: TransportType;
  private readonly sessions = new Map<string, { startedAt: number }>();
  private primarySessionId: string | null = null;

  constructor(transport: TransportType) {
    this.transport = transport;
  }

  /**
   * Get or create the primary session (stdio mode — one per process).
   */
  getOrCreatePrimary(): string {
    if (this.primarySessionId) return this.primarySessionId;
    this.primarySessionId = this.createSession();
    return this.primarySessionId;
  }

  /**
   * Get or create a session for a given connection/session ID.
   * For SSE/HTTP transports.
   */
  getOrCreate(externalSessionId?: string): string {
    const id = externalSessionId ?? this.createSession();
    if (!this.sessions.has(id)) {
      this.sessions.set(id, { startedAt: Date.now() });
      logger.info('Session created', { sessionId: id });
    }
    return id;
  }

  /**
   * End a session.
   */
  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.primarySessionId === sessionId) {
      this.primarySessionId = null;
    }
    logger.info('Session ended', { sessionId });
  }

  private createSession(): string {
    const id = `proxy:${this.transport}:${randomUUID()}`;
    this.sessions.set(id, { startedAt: Date.now() });
    logger.info('Session created', { sessionId: id });
    return id;
  }
}
