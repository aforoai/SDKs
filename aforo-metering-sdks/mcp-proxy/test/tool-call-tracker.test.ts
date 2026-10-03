/**
 * @file Unit tests for ToolCallTracker — duration tracking, error detection, stats.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EXECUTION_STATUSES, ToolCallTracker, defaultToolStatus } from '../src/interceptor/ToolCallTracker.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProxyUsageEvent } from '../src/types.js';

// Minimal stub for EventBuffer — captures pushed events
class StubBuffer {
  events: ProxyUsageEvent[] = [];
  drops: Array<{ events: ProxyUsageEvent[]; reason: string; detail?: string }> = [];
  push(event: ProxyUsageEvent) { this.events.push(event); }
  recordDrop(events: ProxyUsageEvent[], reason: string, detail?: string) { this.drops.push({ events, reason, detail }); }
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

  // ── executionStatus (P6 item 14, 2026-09-30) ──

  it('a result with isError: true is ERROR, not SUCCESS', () => {
    tracker.trackRequest({ requestId: 10, toolName: 't', agentId: 'a' }, 'sess');
    tracker.trackResponse(
      { requestId: 10, hasError: false, result: { isError: true, content: [] }, responseBytes: 5 },
      'sess',
    );
    assert.equal(buffer.events[0].executionStatus, 'ERROR');
    assert.equal(tracker.getStats().errorCount, 1);
  });

  it('isError must be literally true', () => {
    tracker.trackRequest({ requestId: 11, toolName: 't', agentId: 'a' }, 'sess');
    tracker.trackResponse(
      { requestId: 11, hasError: false, result: { isError: 'yes' }, responseBytes: 5 },
      'sess',
    );
    assert.equal(buffer.events[0].executionStatus, 'SUCCESS');
  });

  it('a JSON-RPC error is ERROR; code -32001 is TIMEOUT', () => {
    tracker.trackRequest({ requestId: 12, toolName: 't', agentId: 'a' }, 'sess');
    tracker.trackRequest({ requestId: 13, toolName: 't', agentId: 'a' }, 'sess');
    tracker.trackResponse(
      { requestId: 12, hasError: true, error: { code: -32602, message: 'Invalid params' }, responseBytes: 5 },
      'sess',
    );
    tracker.trackResponse(
      { requestId: 13, hasError: true, error: { code: -32001, message: 'Request timed out' }, responseBytes: 5 },
      'sess',
    );
    assert.deepEqual(buffer.events.map((e) => e.executionStatus), ['ERROR', 'TIMEOUT']);
  });

  it('a call with no response is metered once as TIMEOUT', () => {
    tracker.shutdown();
    tracker = new ToolCallTracker({
      buffer: buffer as any,
      heartbeat: heartbeat as any,
      tenantId: 'test_tenant',
      productId: 'prod_001',
      transport: 'stdio',
      staleCallTimeoutMs: 1000,
    });
    tracker.trackRequest({ requestId: 20, toolName: 'slow', agentId: 'a' }, 'sess_t');
    tracker.cleanupStale(Date.now() + 1001);
    assert.equal(buffer.events.length, 1);
    assert.equal(buffer.events[0].executionStatus, 'TIMEOUT');
    assert.equal(buffer.events[0].sessionId, 'sess_t');
    assert.equal(buffer.events[0].metadata?.noResponse, true);
    // A late response no longer matches — never metered twice.
    assert.equal(tracker.trackResponse({ requestId: 20, hasError: false, responseBytes: 1 }, 'sess_t'), false);
    tracker.cleanupStale(Date.now() + 5000);
    assert.equal(buffer.events.length, 1);
  });

  it('a statusResolver overrides the default; undefined, blank or a throw falls back', () => {
    tracker.shutdown();
    const calls: unknown[][] = [];
    tracker = new ToolCallTracker({
      buffer: buffer as any,
      heartbeat: heartbeat as any,
      tenantId: 'test_tenant',
      productId: 'prod_001',
      transport: 'stdio',
      statusResolver: (result, error) => {
        calls.push([result, error]);
        const r = result as { mode?: string } | undefined;
        if (r?.mode === 'partial') return ' partial ';
        if (r?.mode === 'blank') return '  ';
        if (r?.mode === 'throw') throw new Error('resolver bug');
        return undefined;
      },
    });
    const run = (id: number, result: unknown) => {
      tracker.trackRequest({ requestId: id, toolName: 't', agentId: 'a' }, 's');
      tracker.trackResponse({ requestId: id, hasError: false, result, responseBytes: 1 }, 's');
    };
    run(30, { mode: 'partial' });
    run(31, { mode: 'blank', isError: true });
    run(32, { mode: 'throw', isError: true });
    run(33, {});
    assert.deepEqual(buffer.events.map((e) => e.executionStatus), ['PARTIAL', 'ERROR', 'ERROR', 'SUCCESS']);
    assert.equal(calls.length, 4);
  });

  it('the same JSON-RPC id in two sessions is two calls', () => {
    tracker.trackRequest({ requestId: 1, toolName: 'a_tool', agentId: 'a' }, 'sess_A');
    tracker.trackRequest({ requestId: 1, toolName: 'b_tool', agentId: 'b' }, 'sess_B');
    tracker.trackResponse({ requestId: 1, hasError: false, result: { isError: true }, responseBytes: 1 }, 'sess_B');
    tracker.trackResponse({ requestId: 1, hasError: false, result: {}, responseBytes: 1 }, 'sess_A');
    assert.deepEqual(
      buffer.events.map((e) => [e.sessionId, e.toolName, e.executionStatus]),
      [['sess_B', 'b_tool', 'ERROR'], ['sess_A', 'a_tool', 'SUCCESS']],
    );
  });

  it('id 1 and id "1" are different calls', () => {
    tracker.trackRequest({ requestId: 1, toolName: 'n', agentId: 'a' }, 's');
    assert.equal(tracker.trackResponse({ requestId: '1', hasError: false, responseBytes: 1 }, 's'), false);
    assert.equal(tracker.trackResponse({ requestId: 1, hasError: false, responseBytes: 1 }, 's'), true);
  });

  it('calls still waiting at shutdown are metered once as CANCELLED', () => {
    tracker.trackRequest({ requestId: 40, toolName: 'slow', agentId: 'a' }, 'sess_s');
    tracker.shutdown();
    assert.equal(buffer.events.length, 1);
    assert.equal(buffer.events[0].executionStatus, 'CANCELLED');
    assert.equal(buffer.events[0].sessionId, 'sess_s');
    tracker.shutdown(); // afterEach calls it again — no second event
    assert.equal(buffer.events.length, 1);
  });

  it('a non-canonical or async statusResolver result falls back to the default', async () => {
    tracker.shutdown();
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    try {
      tracker = new ToolCallTracker({
        buffer: buffer as any,
        heartbeat: heartbeat as any,
        tenantId: 'test_tenant',
        productId: 'prod_001',
        transport: 'stdio',
        statusResolver: ((result: unknown) => {
          if ((result as { mode?: string }).mode === 'async') return Promise.reject(new Error('async bug'));
          return 'ok';
        }) as any,
      });
      tracker.trackRequest({ requestId: 50, toolName: 't', agentId: 'a' }, 's');
      tracker.trackResponse({ requestId: 50, hasError: false, result: { isError: true }, responseBytes: 1 }, 's');
      tracker.trackRequest({ requestId: 51, toolName: 't', agentId: 'a' }, 's');
      tracker.trackResponse({ requestId: 51, hasError: false, result: { mode: 'async' }, responseBytes: 1 }, 's');
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(buffer.events.map((e) => e.executionStatus), ['ERROR', 'SUCCESS']);
      assert.equal(unhandled, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('EXECUTION_STATUSES matches the ingest contract', () => {
    const contract = JSON.parse(readFileSync(resolve(__dirname, '../../../contract/ingest-contract.json'), 'utf8'));
    const values: string[] = contract.endpoints['/v1/ingest/batch'].eventOptionalFields.executionStatus.values;
    assert.deepEqual([...EXECUTION_STATUSES].sort(), [...values].sort());
  });

  it('every status the default can produce is canonical', () => {
    // dist/test at run time → the repo root is three levels up.
    const contract = JSON.parse(readFileSync(resolve(__dirname, '../../../contract/ingest-contract.json'), 'utf8'));
    const canonical: string[] = contract.endpoints['/v1/ingest/batch'].eventOptionalFields.executionStatus.values;
    for (const s of [
      defaultToolStatus({}, undefined),
      defaultToolStatus({ isError: true }, undefined),
      defaultToolStatus(undefined, { code: -32600, message: 'x' }),
      defaultToolStatus(undefined, { code: -32001, message: 'x' }),
    ]) {
      assert.ok(canonical.includes(s), s);
    }
  });
});

describe('ToolCallTracker attribution, productType and limits', () => {
  let buffer: StubBuffer;
  let heartbeat: StubHeartbeat & { customer?: string };
  const make = (extra: Record<string, unknown> = {}) => new ToolCallTracker({
    buffer: buffer as any, heartbeat: heartbeat as any,
    tenantId: 't', productId: 'p', transport: 'stdio', ...extra,
  });

  beforeEach(() => {
    buffer = new StubBuffer();
    heartbeat = new StubHeartbeat();
    heartbeat.startSession = function (id: string, customer?: string) {
      this.started = true; this.activeSessionId = id; this.customer = customer;
    };
  });

  it('bills _meta.customer_id, then the customerId config, then the agentId', () => {
    const tracker = make({ customerId: 'cust_cfg' });
    tracker.trackRequest({ requestId: 1, toolName: 't', agentId: 'a', customerId: 'cust_meta' }, 's');
    tracker.trackResponse({ requestId: 1, hasError: false, responseBytes: 1 }, 's');
    tracker.trackRequest({ requestId: 2, toolName: 't', agentId: 'a' }, 's');
    tracker.trackResponse({ requestId: 2, hasError: false, responseBytes: 1 }, 's');
    tracker.shutdown();

    const plain = make();
    plain.trackRequest({ requestId: 3, toolName: 't', agentId: 'agent_x' }, 's');
    plain.trackResponse({ requestId: 3, hasError: false, responseBytes: 1 }, 's');
    plain.shutdown();

    assert.deepEqual(buffer.events.map((e) => e.customerId), ['cust_meta', 'cust_cfg', 'agent_x']);
    assert.equal(heartbeat.customer, 'cust_meta'); // session customer = first call's customer
  });

  it('stamps the configured productType (default MCP_SERVER)', () => {
    const tracker = make({ productType: ' agentic_api ' });
    tracker.trackRequest({ requestId: 1, toolName: 't', agentId: 'a' }, 's');
    tracker.trackResponse({ requestId: 1, hasError: false, responseBytes: 1 }, 's');
    tracker.shutdown();
    assert.equal(buffer.events[0].productType, 'AGENTIC_API');
  });

  // Regression: the key used to be a hash of
  // agentId:sessionId:toolName:requestId:Date.now(). A client is free to re-use a
  // JSON-RPC id, and Date.now() has only millisecond resolution, so two genuinely
  // separate invocations of the same tool hashed to one key — the ingestor
  // answered DUPLICATE and silently dropped the second, under-billing the call.
  it('gives two identical tool calls in the same millisecond distinct idempotency keys', () => {
    const tracker = make();
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen; // both calls land in the same millisecond
    try {
      for (let i = 0; i < 2; i++) {
        tracker.trackRequest({ requestId: 1, toolName: 't', agentId: 'a' }, 's');
        tracker.trackResponse({ requestId: 1, hasError: false, responseBytes: 1 }, 's');
      }
    } finally {
      Date.now = realNow;
      tracker.shutdown();
    }
    assert.equal(buffer.events.length, 2);
    assert.notEqual(buffer.events[0].idempotencyKey, buffer.events[1].idempotencyKey);
  });

  it('drops calls whose agentId/customerId/sessionId exceed the ingestor limits as "invalid"', () => {
    const tracker = make();
    assert.equal(tracker.trackRequest({ requestId: 1, toolName: 'x'.repeat(65), agentId: 'a', customerId: 'c'.repeat(65) }, 's'), false);
    assert.equal(tracker.trackRequest({ requestId: 2, toolName: 't', agentId: 'a'.repeat(37) }, 's'), false);
    assert.equal(tracker.trackRequest({ requestId: 3, toolName: 't', agentId: 'a', customerId: 'c'.repeat(65) }, 's'), false);
    assert.equal(tracker.trackRequest({ requestId: 4, toolName: 't', agentId: 'a' }, 's'.repeat(65)), false);
    // An invalid call never starts the session: its customer could not be sent either.
    assert.equal(heartbeat.started, false);
    // Nothing is reported until the call's outcome is known.
    assert.equal(buffer.drops.length, 0);

    // The response is still matched, so the dropped event carries the real status.
    assert.equal(tracker.trackResponse({ requestId: 1, hasError: false, responseBytes: 1 }, 's'), true);
    assert.equal(buffer.drops.length, 1);
    assert.equal(buffer.drops[0].reason, 'invalid');
    assert.match(buffer.drops[0].detail ?? '', /customerId .* exceeds 64 chars/);
    assert.doesNotMatch(buffer.drops[0].detail ?? '', /toolName/);
    assert.equal(buffer.drops[0].events[0].executionStatus, 'SUCCESS');
    assert.ok(buffer.drops[0].events[0].idempotencyKey);

    // Calls still waiting at shutdown are dropped once each, as CANCELLED.
    tracker.shutdown();
    assert.equal(buffer.drops.length, 4);
    assert.ok(buffer.drops.every((d) => d.reason === 'invalid'));
    assert.deepEqual(buffer.drops.slice(1).map((d) => d.events[0].executionStatus), ['CANCELLED', 'CANCELLED', 'CANCELLED']);

    // Never buffered, never counted in the session stats.
    assert.equal(buffer.events.length, 0);
    assert.equal(tracker.getStats().toolCallCount, 0);
  });

  it('accepts values exactly at the ingestor limits', () => {
    const tracker = make();
    const session = 's'.repeat(64);
    assert.equal(tracker.trackRequest({ requestId: 1, toolName: 'x'.repeat(64), agentId: 'a'.repeat(36), customerId: 'c'.repeat(64) }, session), true);
    tracker.trackResponse({ requestId: 1, hasError: false, responseBytes: 1 }, session);
    tracker.shutdown();
    assert.equal(buffer.events.length, 1);
    assert.equal(buffer.drops.length, 0);
  });

  it('mints the idempotency key once per tool call, when the event is created', () => {
    const tracker = make();
    tracker.trackRequest({ requestId: 1, toolName: 't', agentId: 'a' }, 's');
    tracker.trackResponse({ requestId: 1, hasError: false, responseBytes: 1 }, 's');
    const key = buffer.events[0].idempotencyKey;
    // A second response for the same id matches nothing, so no second event or key.
    assert.equal(tracker.trackResponse({ requestId: 1, hasError: false, responseBytes: 1 }, 's'), false);
    tracker.shutdown();
    assert.equal(buffer.events.length, 1);
    assert.equal(buffer.events[0].idempotencyKey, key);
  });
});
