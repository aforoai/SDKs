// In-memory session store for the AI_AGENT test server.
//
// Sessions are first-class resources here (unlike MCP where the transport
// carries the session concept opaquely). A session tracks (agentId, tenantId,
// per-session counters, lifecycle timestamps) and is subject to two limits
// mirroring research-agent.yaml session block:
//
//   idle_timeout_minutes: 15   → SessionStore.idleTimeoutSec
//   max_concurrent_sessions: 10 → SessionStore.capacity
//
// The idle sweeper runs on a timer and drops sessions whose lastActivityAt
// is older than the idle window. `dispose()` stops the sweeper and clears
// the map — call it on shutdown so a long-running test process doesn't leak
// timers.

import crypto from 'node:crypto';
import type { ExecutionStatus } from './types.js';

export type SessionStatus = 'active' | 'ended';

export interface Session {
  id: string;
  agentId: string;
  tenantId?: string;
  startedAt: number;
  endedAt?: number;
  lastActivityAt: number;
  invocationCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  status: SessionStatus;
  metadata: Record<string, unknown>;
}

export interface SessionStoreOptions {
  /** Idle timeout in seconds. 15 min = 900. Set to 0 to disable sweeping. */
  idleTimeoutSec?: number;
  /** Sweeper tick interval (ms). Defaults to 30 000 (30s). */
  sweepIntervalMs?: number;
  /** Max concurrent ACTIVE sessions. Defaults to 100 (>> the yaml's 10 so a
   *  loadgen scenario can fan out without hitting the cap). Set 0 to disable. */
  capacity?: number;
}

const DEFAULT_IDLE_SEC = 15 * 60;
const DEFAULT_SWEEP_MS = 30_000;
const DEFAULT_CAPACITY = 100;

/** Signals a call attempted to open a session past the configured cap. */
export class SessionCapacityExceededError extends Error {
  constructor(readonly capacity: number) {
    super(`session capacity exceeded (${capacity})`);
  }
}

/** Signals a call referenced a session that never existed / was cleaned up. */
export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`unknown session: ${sessionId}`);
  }
}

/** Signals a call tried to use a session that has been ended. */
export class SessionEndedError extends Error {
  constructor(readonly sessionId: string) {
    super(`session ended: ${sessionId}`);
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly idleTimeoutSec: number;
  private readonly capacity: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SessionStoreOptions = {}) {
    this.idleTimeoutSec = opts.idleTimeoutSec ?? DEFAULT_IDLE_SEC;
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    const sweepMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    if (this.idleTimeoutSec > 0 && sweepMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
      // Don't hold the event loop open in test / CLI processes waiting for
      // the sweeper to tick. If unref exists (Node http/timers), call it.
      const t = this.sweepTimer as { unref?: () => void };
      if (typeof t.unref === 'function') t.unref();
    }
  }

  /** Open a new session. Throws SessionCapacityExceededError past the cap. */
  create(input: { agentId: string; tenantId?: string; metadata?: Record<string, unknown> }): Session {
    if (this.capacity > 0 && this.activeCount() >= this.capacity) {
      throw new SessionCapacityExceededError(this.capacity);
    }
    // 32-char hex — long enough to sound like a real id, short enough to
    // print in logs. Not crypto-grade; the session id is echoed in every
    // wire response anyway.
    const id = 'sess_' + crypto.randomBytes(12).toString('hex');
    const now = Date.now();
    const session: Session = {
      id,
      agentId: input.agentId,
      tenantId: input.tenantId,
      startedAt: now,
      lastActivityAt: now,
      invocationCount: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      status: 'active',
      metadata: input.metadata ?? {},
    };
    this.sessions.set(id, session);
    return session;
  }

  /** Fetch a session by id. Returns undefined if unknown OR already swept. */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Mark a session ended and return the final state. Idempotent — calling
   * end() on an already-ended session returns the same terminal snapshot.
   * Ending a session does NOT delete it (so subsequent GET /agent/session/{id}
   * calls can observe the final counters); it stays in the map until either
   * the sweeper drops it or dispose() clears the whole store.
   */
  end(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new UnknownSessionError(id);
    if (s.status === 'ended') return s;
    s.status = 'ended';
    s.endedAt = Date.now();
    return s;
  }

  /**
   * Record a completed invocation against a session. Bumps counters +
   * lastActivityAt so the idle sweeper doesn't drop an actively-used session.
   * Throws SessionEndedError if the session was already closed — the caller
   * should surface this as a 410 to the wire (attempting to invoke on an
   * ended session is a client bug, not a stale-cache case).
   */
  recordInvocation(
    id: string,
    args: {
      tokensIn: number;
      tokensOut: number;
      status: ExecutionStatus;
    },
  ): Session {
    const s = this.sessions.get(id);
    if (!s) throw new UnknownSessionError(id);
    if (s.status === 'ended') throw new SessionEndedError(id);
    s.invocationCount += 1;
    s.totalTokensIn += args.tokensIn;
    s.totalTokensOut += args.tokensOut;
    s.lastActivityAt = Date.now();
    // status is per-invocation only; the session as a whole stays "active"
    // regardless of whether individual invocations FAIL / BLOCK / HITL —
    // parity with a real agent runtime which can retry after a step fails.
    return s;
  }

  /** Count of sessions currently in the active state. */
  activeCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.status === 'active') n += 1;
    return n;
  }

  /** Total sessions in the store, including ended-but-not-swept. */
  totalCount(): number {
    return this.sessions.size;
  }

  /** Sweep idle-timed-out sessions. Exposed for tests. */
  sweep(now: number = Date.now()): number {
    if (this.idleTimeoutSec <= 0) return 0;
    const cutoff = now - this.idleTimeoutSec * 1000;
    let dropped = 0;
    for (const [id, s] of this.sessions) {
      // Only drop ACTIVE-but-idle sessions here. Ended sessions are
      // retained so a GET after end() can still observe the terminal state;
      // a follow-up sweep past 2× idleTimeout removes them too.
      if (s.status === 'active' && s.lastActivityAt < cutoff) {
        this.sessions.delete(id);
        dropped += 1;
        continue;
      }
      const endedAt = s.endedAt ?? 0;
      if (s.status === 'ended' && endedAt > 0 && endedAt < now - 2 * this.idleTimeoutSec * 1000) {
        this.sessions.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Stop the sweeper and clear the map. Call on shutdown. */
  dispose(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.sessions.clear();
  }
}
