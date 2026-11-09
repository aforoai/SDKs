/**
 * @file Session lifecycle management.
 * - stdio: 1 session per process lifetime
 * - SSE: 1 session per SSE connection
 * - Streamable HTTP: 1 session per Mcp-Session-Id header. A request without
 *   one (an upstream that issues no session ids) is matched to its responses
 *   in its own short-lived session, and its calls are metered in one stable
 *   proxy session per client token (see getOrCreateStable)
 *
 * Sessions are capped and expire when idle (G306), so clients that never say
 * goodbye cannot grow the table without bound.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { TransportType } from '../types.js';
import { BoundedMap } from '../util/BoundedMap.js';
import { logger } from '../util/logger.js';

/** The ingestor's sessionId limit. */
const MAX_SESSION_ID = 64;
export const DEFAULT_MAX_SESSIONS = 10_000;
export const DEFAULT_SESSION_IDLE_MS = 60 * 60 * 1000;

export interface SessionManagerOptions {
  maxSessions?: number;
  /** A session not used for this long is forgotten (default 1 hour). */
  idleTimeoutMs?: number;
  now?: () => number;
}

export class SessionManager {
  private readonly transport: TransportType;
  private readonly sessions: BoundedMap<string, { startedAt: number }>;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private primarySessionId: string | null = null;
  /** Stable proxy session per client key (getOrCreateStable). Bounded by the number of client tokens. */
  private readonly stableSessions = new Map<string, string>();

  constructor(transport: TransportType, options: SessionManagerOptions = {}) {
    this.transport = transport;
    this.idleTimeoutMs = options.idleTimeoutMs && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : DEFAULT_SESSION_IDLE_MS;
    this.now = options.now ?? Date.now;
    this.sessions = new BoundedMap({
      maxEntries: options.maxSessions && options.maxSessions > 0 ? options.maxSessions : DEFAULT_MAX_SESSIONS,
      onEvict: (id) => logger.info('Session evicted (too many open sessions)', { sessionId: id }),
    });
  }

  /**
   * Get or create the primary session (stdio mode — one per process).
   */
  getOrCreatePrimary(): string {
    if (this.primarySessionId) return this.primarySessionId;
    this.primarySessionId = this.createSession(false);
    return this.primarySessionId;
  }

  /**
   * The stable proxy session for traffic that carries no session of its own
   * (Streamable HTTP requests without Mcp-Session-Id): one per `clientKey` —
   * the client's token label, or '' when clients are not told apart — for the
   * life of the proxy, like the stdio primary session.
   */
  getOrCreateStable(clientKey: string): string {
    const known = this.stableSessions.get(clientKey);
    if (known) return known;
    const id = this.createSession(false);
    this.stableSessions.set(clientKey, id);
    return id;
  }

  /**
   * Get or create a session for a given connection/session ID. An external id
   * longer than the ingestor allows is replaced by a stable digest of it.
   * Using a session refreshes its idle timer.
   */
  getOrCreate(externalSessionId?: string): string {
    if (externalSessionId === undefined || externalSessionId === '') return this.createSession(true);
    const id = externalSessionId.length <= MAX_SESSION_ID
      ? externalSessionId
      : `proxy:${createHash('sha256').update(externalSessionId).digest('hex').slice(0, 40)}`;
    const now = this.now();
    const existing = this.sessions.get(id, now);
    this.sessions.set(id, existing ?? { startedAt: now }, this.idleTimeoutMs, now);
    if (!existing) logger.info('Session created', { sessionId: id });
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

  /** Whether a session is open (and not idle-expired). */
  has(sessionId: string): boolean {
    return sessionId === this.primarySessionId || this.sessions.has(sessionId, this.now());
  }

  /** Forget idle sessions. */
  sweep(): void {
    this.sessions.sweep(this.now());
  }

  /** Open sessions, the stdio primary included. */
  get size(): number {
    return this.sessions.size;
  }

  /** `expires`: false for the stdio primary session, which lives as long as the process. */
  private createSession(expires: boolean): string {
    const id = `proxy:${this.transport}:${randomUUID()}`;
    const now = this.now();
    this.sessions.set(id, { startedAt: now }, expires ? this.idleTimeoutMs : undefined, now);
    logger.info('Session created', { sessionId: id });
    return id;
  }
}
