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

export interface ToolCallTrackerConfig {
  buffer: EventBuffer;
  heartbeat: HeartbeatEmitter;
  tenantId: string;
  productId: string;
  transport: string;
  agentIdOverride?: string;
}

export class ToolCallTracker {
  private readonly inFlight = new Map<string | number, InFlightCall>();
  private readonly buffer: EventBuffer;
  private readonly heartbeat: HeartbeatEmitter;
  private readonly tenantId: string;
  private readonly productId: string;
  private readonly transport: string;
  private readonly agentIdOverride?: string;
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

    // Periodically clean up stale in-flight calls
    this.cleanupTimer = setInterval(() => this.cleanupStale(), 60_000);
  }

  /**
   * Register a new tool call request — starts duration timer.
   */
  trackRequest(call: ParsedToolCall, sessionId: string): void {
    const agentId = this.agentIdOverride ?? call.agentId;

    this.inFlight.set(call.requestId, {
      toolName: call.toolName,
      agentId,
      startTime: Date.now(),
      requestId: call.requestId,
    });

    // Auto-start heartbeat on first tool call
    if (!this.heartbeat.activeSessionId) {
      this.heartbeat.startSession(sessionId);
    }

    logger.debug('Tool call started', { toolName: call.toolName, requestId: call.requestId });
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
      customerId: call.agentId,
      metricName: 'mcp_server.tool_invocations',
      quantity: 1,
      occurredAt: new Date().toISOString(),
      idempotencyKey: generateIdempotencyKey(call.agentId, sessionId, call.toolName, call.requestId),
      productType: 'MCP_SERVER',
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
