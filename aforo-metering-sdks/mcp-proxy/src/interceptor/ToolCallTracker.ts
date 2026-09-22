/**
 * @file Tracks in-flight tool calls (request ID → start time).
 * On matching response, computes duration, detects errors, emits telemetry.
 */

import type { InFlightCall, ProxyUsageEvent } from '../types.js';
import type { EventBuffer } from '../telemetry/EventBuffer.js';
import type { HeartbeatEmitter } from '../telemetry/HeartbeatEmitter.js';
import type { ParsedToolCall, ParsedToolResponse } from './MessageInterceptor.js';
import { generateIdempotencyKey } from '../util/idempotency.js';
import { logger } from '../util/logger.js';

const PROXY_VERSION = '1.0.0';
const STALE_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** Ingestor field limits (IngestUsageEventRequest). */
const MAX_CUSTOMER_ID = 64;
const MAX_AGENT_ID = 36;
const MAX_TOOL_NAME = 64;

export interface ToolCallTrackerConfig {
  buffer: EventBuffer;
  heartbeat: HeartbeatEmitter;
  tenantId: string;
  productId: string;
  transport: string;
  agentIdOverride?: string;
  /** Customer billed when a call carries no `_meta.customer_id` (else the agentId is billed). */
  customerId?: string;
  /** productType stamped on tool events (default MCP_SERVER). */
  productType?: string;
}

export class ToolCallTracker {
  private readonly inFlight = new Map<string | number, InFlightCall>();
  private readonly buffer: EventBuffer;
  private readonly heartbeat: HeartbeatEmitter;
  private readonly tenantId: string;
  private readonly productId: string;
  private readonly transport: string;
  private readonly agentIdOverride?: string;
  private readonly customerId?: string;
  private readonly productType: string;
  private cleanupTimer: ReturnType<typeof setInterval>;
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
    this.customerId = config.customerId?.trim() || undefined;
    this.productType = config.productType?.trim().toUpperCase() || 'MCP_SERVER';

    // Periodically clean up stale in-flight calls
    this.cleanupTimer = setInterval(() => this.cleanupStale(), 60_000);
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
   * Returns false (and meters nothing) when the event would be rejected by the
   * ingestor -- toolName over 64 chars, agentId over 36 or customerId over 64 --
   * because one invalid event fails the whole batch it is sent in.
   */
  trackRequest(call: ParsedToolCall, sessionId: string): boolean {
    const agentId = this.agentIdOverride ?? call.agentId;
    const customerId = this.resolveCustomerId(call);

    const problems: string[] = [];
    if (call.toolName.length > MAX_TOOL_NAME) problems.push(`toolName exceeds ${MAX_TOOL_NAME} chars`);
    if (agentId.length > MAX_AGENT_ID) problems.push(`agentId exceeds ${MAX_AGENT_ID} chars`);
    if (customerId.length > MAX_CUSTOMER_ID) problems.push(`customerId exceeds ${MAX_CUSTOMER_ID} chars`);
    if (problems.length > 0) {
      logger.warn('Tool call not metered', { toolName: call.toolName, requestId: call.requestId, problems });
      return false;
    }

    this.inFlight.set(call.requestId, {
      toolName: call.toolName,
      agentId,
      customerId,
      startTime: Date.now(),
      requestId: call.requestId,
    });

    // Auto-start the session (and its heartbeats) on the first tool call
    if (!this.heartbeat.activeSessionId) {
      this.heartbeat.startSession(sessionId, customerId);
    }

    logger.debug('Tool call started', { toolName: call.toolName, requestId: call.requestId });
    return true;
  }

  /**
   * Match a response to an in-flight tool call. Emits telemetry event.
   * Returns true if matched, false if response doesn't correspond to a tracked call.
   */
  trackResponse(response: ParsedToolResponse, sessionId: string): boolean {
    const call = this.inFlight.get(response.requestId);
    if (!call) return false;

    this.inFlight.delete(response.requestId);

    const durationMs = Date.now() - call.startTime;
    const status = response.hasError ? 'ERROR' : 'SUCCESS';

    this.toolCallCount++;
    this.totalDurationMs += durationMs;
    if (response.hasError) this.errorCount++;

    const event: ProxyUsageEvent = {
      customerId: call.customerId,
      metricName: 'mcp_server.tool_invocations',
      quantity: 1,
      occurredAt: new Date().toISOString(),
      idempotencyKey: generateIdempotencyKey(call.agentId, sessionId, call.toolName, call.requestId),
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
        responseBytes: response.responseBytes,
      },
    };

    this.buffer.push(event);

    logger.debug('Tool call completed', {
      toolName: call.toolName,
      requestId: call.requestId,
      durationMs,
      status,
    });

    return true;
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

  shutdown(): void {
    clearInterval(this.cleanupTimer);
  }

  private cleanupStale(): void {
    const now = Date.now();
    for (const [id, call] of this.inFlight) {
      if (now - call.startTime > STALE_CALL_TIMEOUT_MS) {
        logger.warn('Cleaning up stale in-flight call', { requestId: id, toolName: call.toolName });
        this.inFlight.delete(id);
      }
    }
  }
}
