// Transport-agnostic AI_AGENT test-server dispatcher.
//
// Each transport (HTTP, stdio, SSE) parses a raw request into a typed
// operation, calls the matching handle*() method here, and writes the
// response back over its wire. No transport concerns leak into this module.
//
// Design mirrors mcp-test-server's McpTestServer — one class, one method
// per operation, clean separation from the transports so a test can drive
// the server directly without booting a listener.

import crypto from 'node:crypto';
import { callCapability, hasCapability, listCapabilities } from './capabilities.js';
import {
  SessionStore,
  SessionCapacityExceededError,
  SessionEndedError,
  UnknownSessionError,
  type SessionStoreOptions,
} from './sessions.js';
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  EndSessionResponse,
  GetSessionResponse,
  InvokeRequest,
  InvokeResponse,
} from './types.js';

export interface ServerOptions {
  /** Reported on GET /health and the startup banner. Defaults to package name. */
  serverName?: string;
  /** Reported on GET /health. */
  serverVersion?: string;
  /**
   * When true, capability handlers sleep their per-capability simulated
   * latency before returning. Off by default so scenarios can push maximum
   * TPS without artificial delay; enable via CLI for demo runs.
   */
  simulateLatency?: boolean;
  /** SessionStore overrides — capacity, idle timeout, sweep interval. */
  sessionOptions?: SessionStoreOptions;
}

const DEFAULT_NAME = '@aforoai/agent-test-server';
const DEFAULT_VERSION = '0.1.0';

/** Discriminated result — every dispatch returns one of these three. */
export type DispatchResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'error'; status: number; code: string; message: string };

export class AgentTestServer {
  private readonly startedAt = Date.now();
  private readonly store: SessionStore;

  constructor(private readonly opts: ServerOptions = {}) {
    this.store = new SessionStore(opts.sessionOptions);
  }

  /** Human-readable server identity — mirrors mcp-test-server's initialize. */
  info(): { name: string; version: string } {
    return {
      name: this.opts.serverName ?? DEFAULT_NAME,
      version: this.opts.serverVersion ?? DEFAULT_VERSION,
    };
  }

  /** Uptime in seconds — used by GET /health. */
  uptimeSec(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /** List canonical capabilities — used by GET /agent/capabilities. */
  capabilities(): { name: string; description: string }[] {
    return listCapabilities();
  }

  // ── Session lifecycle ──────────────────────────────────────────────────

  createSession(req: CreateSessionRequest): DispatchResult<CreateSessionResponse> {
    if (!req || typeof req.agentId !== 'string' || req.agentId.length === 0) {
      return { kind: 'error', status: 400, code: 'missing_field', message: 'agentId is required' };
    }
    let session;
    try {
      session = this.store.create({
        agentId: req.agentId,
        tenantId: req.tenantId,
        metadata: req.metadata,
      });
    } catch (err) {
      if (err instanceof SessionCapacityExceededError) {
        return {
          kind: 'error',
          status: 429,
          code: 'session_capacity_exceeded',
          message: err.message,
        };
      }
      throw err;
    }
    return {
      kind: 'ok',
      value: {
        sessionId: session.id,
        agentId: session.agentId,
        startedAt: new Date(session.startedAt).toISOString(),
        idleTimeoutSec: this.opts.sessionOptions?.idleTimeoutSec ?? 15 * 60,
      },
    };
  }

  getSession(sessionId: string): DispatchResult<GetSessionResponse> {
    const s = this.store.get(sessionId);
    if (!s) {
      return { kind: 'error', status: 404, code: 'unknown_session', message: `unknown session: ${sessionId}` };
    }
    return {
      kind: 'ok',
      value: {
        sessionId: s.id,
        agentId: s.agentId,
        startedAt: new Date(s.startedAt).toISOString(),
        invocationCount: s.invocationCount,
        totalTokensIn: s.totalTokensIn,
        totalTokensOut: s.totalTokensOut,
        status: s.status,
      },
    };
  }

  endSession(sessionId: string): DispatchResult<EndSessionResponse> {
    try {
      const s = this.store.end(sessionId);
      return {
        kind: 'ok',
        value: {
          sessionId: s.id,
          agentId: s.agentId,
          endedAt: new Date(s.endedAt ?? Date.now()).toISOString(),
          invocationCount: s.invocationCount,
          totalTokensIn: s.totalTokensIn,
          totalTokensOut: s.totalTokensOut,
        },
      };
    } catch (err) {
      if (err instanceof UnknownSessionError) {
        return { kind: 'error', status: 404, code: 'unknown_session', message: err.message };
      }
      throw err;
    }
  }

  // ── Invocation ─────────────────────────────────────────────────────────

  async invoke(req: InvokeRequest): Promise<DispatchResult<InvokeResponse>> {
    if (!req || typeof req.sessionId !== 'string' || req.sessionId.length === 0) {
      return { kind: 'error', status: 400, code: 'missing_field', message: 'sessionId is required' };
    }
    if (typeof req.capability !== 'string' || req.capability.length === 0) {
      return { kind: 'error', status: 400, code: 'missing_field', message: 'capability is required' };
    }
    // input is optional but when present MUST be an object — mirrors MCP's
    // params.arguments guard in mcp-test-server. A bare string / number /
    // array here would coerce through `String(input.url ?? '')` in the
    // capability handler and produce a nonsense response like a summary
    // of URL="undefined"; better to refuse at the boundary with a specific
    // 400 the caller can act on.
    if (
      req.input !== undefined &&
      (req.input === null ||
        typeof req.input !== 'object' ||
        Array.isArray(req.input))
    ) {
      return {
        kind: 'error',
        status: 400,
        code: 'missing_field',
        message: 'input must be an object if present',
      };
    }

    // Check the session first — an unknown session should 404 even if the
    // capability name is bogus, because the client's session-management logic
    // is the more likely bug (session id typos, cleaned-up sessions, etc.).
    const existing = this.store.get(req.sessionId);
    if (!existing) {
      return { kind: 'error', status: 404, code: 'unknown_session', message: `unknown session: ${req.sessionId}` };
    }
    if (existing.status === 'ended') {
      return { kind: 'error', status: 410, code: 'session_ended', message: `session ended: ${req.sessionId}` };
    }
    if (!hasCapability(req.capability)) {
      return {
        kind: 'error',
        status: 404,
        code: 'unknown_capability',
        message: `unknown capability: ${req.capability}`,
      };
    }

    const result = await callCapability(req.capability, req.input ?? {}, {
      simulateLatency: this.opts.simulateLatency,
    });

    try {
      this.store.recordInvocation(req.sessionId, {
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        status: result.executionStatus,
      });
    } catch (err) {
      // Extremely narrow race: session ended between the check above and
      // now. Return 410 so the client resyncs its view.
      if (err instanceof SessionEndedError) {
        return { kind: 'error', status: 410, code: 'session_ended', message: err.message };
      }
      if (err instanceof UnknownSessionError) {
        return { kind: 'error', status: 404, code: 'unknown_session', message: err.message };
      }
      throw err;
    }

    return {
      kind: 'ok',
      value: {
        invocationId: 'inv_' + crypto.randomBytes(10).toString('hex'),
        sessionId: req.sessionId,
        capability: req.capability,
        output: result.output,
        executionStatus: result.executionStatus,
        executionDurationMs: result.executionDurationMs,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      },
    };
  }

  /** Test hook — used by http.test.ts to force a sweep without waiting. */
  sweepSessions(): number {
    return this.store.sweep();
  }

  /** Stop timers + clear session state. Call on shutdown. */
  dispose(): void {
    this.store.dispose();
  }
}
