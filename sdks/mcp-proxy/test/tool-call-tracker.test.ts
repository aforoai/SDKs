/**
 * @file Unit tests for ToolCallTracker — duration tracking, error detection, stats.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallTracker } from '../src/interceptor/ToolCallTracker.js';
import type { ProxyUsageEvent } from '../src/types.js';

// Minimal stub for EventBuffer — captures pushed events
class StubBuffer {
  events: ProxyUsageEvent[] = [];
  push(event: ProxyUsageEvent) { this.events.push(event); }
  async flush() {}
  async shutdown() {}
  get size() { return this.events.length; }
}

// Minimal stub for HeartbeatEmitter
class StubHeartbeat {
  started = false;
  activeSessionId: string | null = null;
  startSession(id: string) { this.started = true; this.activeSessionId = id; }
  async stopSession() { this.started = false; this.activeSessionId = null; }
}

describe('ToolCallTracker', () => {
  let buffer: StubBuffer;
  let heartbeat: StubHeartbeat;
  let tracker: ToolCallTracker;

  beforeEach(() => {
    buffer = new StubBuffer();
    heartbeat = new StubHeartbeat();
    tracker = new ToolCallTracker({
      buffer: buffer as any,
      heartbeat: heartbeat as any,
      tenantId: 'test_tenant',
      productId: 'prod_001',
      transport: 'stdio',
    });
  });

  afterEach(() => {
    tracker.shutdown();
  });

  it('tracks a successful tool call round-trip', () => {
    const sessionId = 'proxy:stdio:abc';

    tracker.trackRequest(
      { requestId: 1, toolName: 'search', agentId: 'agent_1' },
      sessionId,
    );

    // Simulate some delay
    const matched = tracker.trackResponse(
      { requestId: 1, hasError: false, responseBytes: 256 },
      sessionId,
    );

    assert.ok(matched);
    assert.equal(buffer.events.length, 1);

    const event = buffer.events[0];
    assert.equal(event.metricName, 'mcp_server.tool_invocations');
    assert.equal(event.toolName, 'search');
    assert.equal(event.agentId, 'agent_1');
    assert.equal(event.executionStatus, 'SUCCESS');
    assert.equal(event.productType, 'MCP_SERVER');
    assert.equal(event.quantity, 1);
    assert.ok(event.executionDurationMs! >= 0);
    assert.equal((event.metadata as any).proxy, true);
    assert.equal((event.metadata as any).transport, 'stdio');
    assert.equal((event.metadata as any).responseBytes, 256);
  });

  it('tracks an error tool call', () => {
    const sessionId = 'proxy:stdio:abc';

    tracker.trackRequest(
      { requestId: 2, toolName: 'write', agentId: 'agent_2' },
      sessionId,
    );

    tracker.trackResponse(
      { requestId: 2, hasError: true, responseBytes: 50 },
      sessionId,
    );

    assert.equal(buffer.events.length, 1);
    assert.equal(buffer.events[0].executionStatus, 'ERROR');
  });

  it('returns false for unmatched response', () => {
    const matched = tracker.trackResponse(
      { requestId: 999, hasError: false, responseBytes: 0 },
      'session',
    );
    assert.equal(matched, false);
    assert.equal(buffer.events.length, 0);
  });

  it('auto-starts heartbeat on first tool call', () => {
    assert.equal(heartbeat.started, false);

    tracker.trackRequest(
      { requestId: 1, toolName: 'test', agentId: 'a' },
      'proxy:stdio:xyz',
    );

    assert.equal(heartbeat.started, true);
    assert.equal(heartbeat.activeSessionId, 'proxy:stdio:xyz');
  });

  it('does not restart heartbeat if already running', () => {
    heartbeat.activeSessionId = 'existing';

    tracker.trackRequest(
      { requestId: 1, toolName: 'test', agentId: 'a' },
      'proxy:stdio:xyz',
    );

    // Should not overwrite existing session
    assert.equal(heartbeat.activeSessionId, 'existing');
  });

  it('uses agentIdOverride when configured', () => {
    tracker.shutdown(); // Clean up the default tracker
    tracker = new ToolCallTracker({
      buffer: buffer as any,
      heartbeat: heartbeat as any,
      tenantId: 'test',
      productId: 'prod',
      transport: 'stdio',
      agentIdOverride: 'override_agent',
    });

    tracker.trackRequest(
      { requestId: 1, toolName: 'search', agentId: 'original_agent' },
      'session',
    );
    tracker.trackResponse(
      { requestId: 1, hasError: false, responseBytes: 10 },
      'session',
    );

    assert.equal(buffer.events[0].agentId, 'override_agent');
  });

  it('tracks stats correctly', () => {
    const session = 'proxy:stdio:stats';

    tracker.trackRequest({ requestId: 1, toolName: 'a', agentId: 'x' }, session);
    tracker.trackResponse({ requestId: 1, hasError: false, responseBytes: 10 }, session);

    tracker.trackRequest({ requestId: 2, toolName: 'b', agentId: 'x' }, session);
    tracker.trackResponse({ requestId: 2, hasError: true, responseBytes: 5 }, session);

    tracker.trackRequest({ requestId: 3, toolName: 'c', agentId: 'x' }, session);
    tracker.trackResponse({ requestId: 3, hasError: false, responseBytes: 20 }, session);

    const stats = tracker.getStats();
    assert.equal(stats.toolCallCount, 3);
    assert.equal(stats.errorCount, 1);
    assert.ok(stats.totalDurationMs >= 0);
  });

  it('cleans up on shutdown', () => {
    tracker.shutdown();
    // Should not throw
  });
});
