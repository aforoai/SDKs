/**
 * @file Tracks in-flight tool calls (request ID → start time).
 * On matching response, computes duration, detects errors, emits telemetry.
 */

import type { InFlightCall, JsonRpcError, ProxyUsageEvent, ToolStatusResolver } from '../types.js';
import type { EventBuffer } from '../telemetry/EventBuffer.js';
import type { HeartbeatEmitter } from '../telemetry/HeartbeatEmitter.js';
import type { ParsedToolCall, ParsedToolResponse } from './MessageInterceptor.js';
import { generateIdempotencyKey, truncateToLimit } from '../util/idempotency.js';
import { logger } from '../util/logger.js';
import { PROXY_VERSION } from '../version.js';

const STALE_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** Ingestor field limits (IngestUsageEventRequest). */
const MAX_CUSTOMER_ID = 64;
const MAX_AGENT_ID = 36;
const MAX_TOOL_NAME = 64;
const MAX_SESSION_ID = 64;

/** Shorten an offending value for a log line. */
function clip(value: unknown): string {
  return String(value).slice(0, 80);
}

/** The 11 statuses the ingestor accepts; anything else rejects the event. */
export const EXECUTION_STATUSES: readonly string[] = [
  'SUCCESS', 'PARTIAL', 'TIMEOUT', 'ERROR', 'VALIDATION_FAILED', 'FAILED',
  'FAILURE', 'CANCELLED', 'PENDING', 'BLOCKED', 'HITL_REQUIRED',
];

/** JSON-RPC error code the MCP SDKs use for a request timeout (ErrorCode.RequestTimeout). */
export const MCP_REQUEST_TIMEOUT = -32001;

/**
 * Default executionStatus for a tool call seen on the wire:
 * - JSON-RPC error with code -32001 (request timeout), or no response within
 *   the response timeout (default 5 minutes) → TIMEOUT
 * - any other JSON-RPC error → ERROR
 * - a result with `isError: true`, the normal way an MCP tool reports
 *   failure → ERROR
 * - otherwise → SUCCESS
 *
 * ERROR rather than FAILURE for `isError` results: whether a tool throws or
 * returns `isError` should not change the bill, and ERROR is what every
 * gateway and SDK sends for a call that ran and failed.
 */
export function defaultToolStatus(result: unknown, error: JsonRpcError | undefined): string {
  if (error != null) return error.code === MCP_REQUEST_TIMEOUT ? 'TIMEOUT' : 'ERROR';
  if (result && typeof result === 'object' && (result as { isError?: unknown }).isError === true) {
    return 'ERROR';
  }
  return 'SUCCESS';
}

export interface ToolCallTrackerConfig {
  buffer: EventBuffer;
  heartbeat: HeartbeatEmitter;
  tenantId: string;
  productId: string;
  transport: string;
  agentIdOverride?: string;
  statusResolver?: ToolStatusResolver;
  /** How long a call may wait for its response before it is metered as
   * TIMEOUT (default 5 minutes). */
  staleCallTimeoutMs?: number;
  /** Customer billed when a call carries no `_meta.customer_id` (else the agentId is billed). */
  customerId?: string;
  /** productType stamped on tool events (default MCP_SERVER). */
  productType?: string;
}

export class ToolCallTracker {
  /** Keyed by session + JSON-RPC id: ids are only unique within one client's
   * session, so two sessions both sending id 1 must not overwrite each other. */
  private readonly inFlight = new Map<string, InFlightCall>();
  private readonly buffer: EventBuffer;
  private readonly heartbeat: HeartbeatEmitter;
  private readonly tenantId: string;
  private readonly productId: string;
  private readonly transport: string;
  private readonly agentIdOverride?: string;
  private readonly statusResolver?: ToolStatusResolver;
  private readonly staleCallTimeoutMs: number;
  private readonly customerId?: string;
  private readonly productType: string;
  private cleanupTimer: ReturnType<typeof setInterval>;
  /** Request-derived labels already reported as truncated (one WARN per label). */
  private readonly truncationWarned = new Set<string>();
  private toolCallCount = 0;
  private errorCount = 0;
  private totalDurationMs = 0;

  constructor(config: ToolCallTrackerConfig) {
    this.buffer = config.buffer;
    this.heartbeat = config.heartbeat;
    this.tenantId = config.tenantId;
    this.productId = config.productId;
    this.transport = config.transport;
    this.agentIdOverride = config.agentIdOverride;
    this.statusResolver = config.statusResolver;
    this.staleCallTimeoutMs = config.staleCallTimeoutMs && config.staleCallTimeoutMs > 0
      ? config.staleCallTimeoutMs
      : STALE_CALL_TIMEOUT_MS;
    this.customerId = config.customerId?.trim() || undefined;
    this.productType = config.productType?.trim().toUpperCase() || 'MCP_SERVER';

    // Sweep often enough that a timed-out call is metered within ~10% of the
    // timeout (every 60s at the 5-minute default). unref: the sweep alone
    // must not keep the process alive.
    const sweepMs = Math.max(1_000, Math.min(60_000, Math.floor(this.staleCallTimeoutMs / 10)));
    this.cleanupTimer = setInterval(() => this.cleanupStale(), sweepMs);
    this.cleanupTimer.unref?.();
  }

  private static key(sessionId: string, requestId: string | number): string {
    // typeof keeps id 1 and id "1" apart — JSON-RPC echoes the id's type.
    return `${sessionId}\u0000${typeof requestId}:${requestId}`;
  }

  /**
   * Customer billed for a call: `_meta.customer_id`, else the configured
   * customerId, else the agent id.
   */
  resolveCustomerId(call: { agentId: string; customerId?: string }): string {
    return call.customerId || this.customerId || (this.agentIdOverride ?? call.agentId);
  }

  /**
   * Register a new tool call request — starts duration timer.
   *
   * The tool name comes off the proxied `tools/call` message. One longer than
   * the ingestor's 64-char limit is cut to 64 on the event and the call is
   * still metered (dropping it would let a client avoid metering with a long
   * name); the idempotency key is derived from the full name.
   *
   * Returns false when the call's event would be rejected by the ingestor --
   * agentId over 36 chars, customerId over 64 or sessionId over 64. The call
   * is still tracked so its outcome is known, but when it completes its event
   * is not buffered or sent: it is counted as dropped, WARN-logged and passed
   * to onDrop with reason 'invalid'. Never throws.
   */
  trackRequest(call: ParsedToolCall, sessionId: string): boolean {
    const agentId = this.agentIdOverride ?? call.agentId;
    const customerId = this.resolveCustomerId(call);

    const toolName = this.requestLabel('toolName', call.toolName, MAX_TOOL_NAME);

    const problems: string[] = [];
    if (agentId.length > MAX_AGENT_ID) problems.push(`agentId "${clip(agentId)}" exceeds ${MAX_AGENT_ID} chars`);
    if (customerId.length > MAX_CUSTOMER_ID) problems.push(`customerId "${clip(customerId)}" exceeds ${MAX_CUSTOMER_ID} chars`);
    if (sessionId.length > MAX_SESSION_ID) problems.push(`sessionId "${clip(sessionId)}" exceeds ${MAX_SESSION_ID} chars`);
    const invalid = problems.length > 0 ? problems.join(', ') : undefined;

    this.inFlight.set(ToolCallTracker.key(sessionId, call.requestId), {
      toolName,
      keyToolName: call.toolName,
      agentId,
      customerId,
      startTime: Date.now(),
      requestId: call.requestId,
      sessionId,
      ...(invalid ? { invalid } : {}),
    });

    if (invalid) {
      logger.debug('Tool call will not be metered', { toolName: clip(toolName), requestId: call.requestId, invalid });
      return false;
    }

    // Auto-start the session (and its heartbeats) on the first tool call
    if (!this.heartbeat.activeSessionId) {
      this.heartbeat.startSession(sessionId, customerId);
    }

    logger.debug('Tool call started', { toolName, requestId: call.requestId });
    return true;
  }

  /**
   * Bound a label read off the proxied message to the ingestor's limit. The
   * event is still sent; one WARN per label name for the life of the proxy.
   */
  private requestLabel(field: string, value: string, max: number): string {
    if (typeof value !== 'string' || value.length <= max) return value;
    if (!this.truncationWarned.has(field)) {
      this.truncationWarned.add(field);
      logger.warn(
        `${field} in the request was longer than the ingestor's limit and was truncated to ${max} characters; `
          + 'the event is still sent (logged once per label)',
        { field, limit: max },
      );
    }
    return truncateToLimit(value, max);
  }

  /**
   * Match a response to an in-flight tool call. Emits telemetry event.
   * Returns true if matched, false if response doesn't correspond to a tracked call.
   */
  trackResponse(response: ParsedToolResponse, sessionId: string): boolean {
    const key = ToolCallTracker.key(sessionId, response.requestId);
    const call = this.inFlight.get(key);
    if (!call) return false;

    this.inFlight.delete(key);

    const durationMs = Date.now() - call.startTime;
    // hasError without an error object (older callers) still counts as a
    // JSON-RPC error response.
    const error = response.error ?? (response.hasError ? { code: -32603, message: 'JSON-RPC error' } : undefined);
    const status = this.resolveStatus(response.result, error);
    this.emit(call, sessionId, status, durationMs, response.responseBytes);
    return true;
  }

  private resolveStatus(result: unknown, error: JsonRpcError | undefined): string {
    if (this.statusResolver) {
      try {
        const custom: unknown = this.statusResolver(result, error);
        if (custom && typeof (custom as { then?: unknown }).then === 'function') {
          // Can't be awaited without delaying metering; swallow its eventual
          // rejection so it can't crash the proxy, and use the default.
          (custom as Promise<unknown>).then(undefined, () => undefined);
          logger.warn('statusResolver returned a Promise; it must be synchronous. Using the default status');
        } else if (typeof custom === 'string' && custom.trim()) {
          const status = custom.trim().toUpperCase();
          if (EXECUTION_STATUSES.includes(status)) return status;
          logger.warn('statusResolver returned a value that is not an execution status; using the default', { value: custom });
        }
      } catch (err) {
        logger.warn('statusResolver threw; using the default status', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return defaultToolStatus(result, error);
  }

  private emit(
    call: InFlightCall,
    sessionId: string,
    status: string,
    durationMs: number,
    responseBytes?: number,
  ): void {
    const event: ProxyUsageEvent = {
      customerId: call.customerId,
      metricName: 'mcp_server.tool_invocations',
      quantity: 1,
      occurredAt: new Date().toISOString(),
      // Minted here, once per tool call, when its event is created. Flush
      // retries and onDrop replays reuse it; it is never re-minted. Derived
      // from the request's full tool name, not the truncated label.
      idempotencyKey: generateIdempotencyKey(call.agentId, sessionId, call.keyToolName ?? call.toolName, call.requestId),
      productType: this.productType,
      toolName: call.toolName,
      agentId: call.agentId,
      sessionId,
      executionStatus: status,
      executionDurationMs: durationMs,
      metadata: {
        productId: this.productId,
        transport: this.transport,
        proxy: true,
        proxyVersion: PROXY_VERSION,
        ...(responseBytes !== undefined ? { responseBytes } : { noResponse: true }),
      },
    };

    if (call.invalid) {
      // Not buffered, not sent: reported as a drop (counter + WARN + onDrop).
      this.buffer.recordDrop([event], 'invalid', call.invalid);
      return;
    }

    this.toolCallCount++;
    this.totalDurationMs += durationMs;
    if (status !== 'SUCCESS') this.errorCount++;

    this.buffer.push(event);

    logger.debug('Tool call completed', {
      toolName: call.toolName,
      requestId: call.requestId,
      durationMs,
      status,
    });
  }

  /**
   * Get session summary stats for the SESSION_END event.
   */
  getStats(): { toolCallCount: number; errorCount: number; totalDurationMs: number } {
    return {
      toolCallCount: this.toolCallCount,
      errorCount: this.errorCount,
      totalDurationMs: this.totalDurationMs,
    };
  }

  /**
   * Stops the sweep and meters every call still waiting for a response as
   * CANCELLED — the proxy is going away, so the client will never get it.
   * Call before the event buffer's final flush.
   */
  shutdown(): void {
    clearInterval(this.cleanupTimer);
    const now = Date.now();
    for (const [key, call] of this.inFlight) {
      this.inFlight.delete(key);
      this.emit(call, call.sessionId ?? '', 'CANCELLED', now - call.startTime);
    }
  }

  /**
   * A call with no response after staleCallTimeoutMs is metered as TIMEOUT
   * (before 2026-09-30 it was dropped and never metered). If the response
   * arrives later it no longer matches an in-flight call, so it can't be
   * metered twice.
   */
  cleanupStale(now: number = Date.now()): void {
    for (const [key, call] of this.inFlight) {
      if (now - call.startTime > this.staleCallTimeoutMs) {
        logger.warn('No response for tool call; metering it as TIMEOUT', { requestId: call.requestId, toolName: call.toolName });
        this.inFlight.delete(key);
        const timeoutMarker: JsonRpcError = { code: MCP_REQUEST_TIMEOUT, message: 'no response from MCP server' };
        this.emit(call, call.sessionId ?? '', this.resolveStatus(undefined, timeoutMarker), now - call.startTime);
      }
    }
  }
}
