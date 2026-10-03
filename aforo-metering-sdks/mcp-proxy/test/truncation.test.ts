/**
 * @file The tool name comes off the proxied tools/call message. One over the
 * ingestor's 64-char limit is truncated on the event and the call is still
 * metered; over-long identity fields still drop the event as 'invalid'.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallTracker } from '../src/interceptor/ToolCallTracker.js';
import { extractToolCall } from '../src/interceptor/MessageInterceptor.js';
import { truncateToLimit } from '../src/util/idempotency.js';
import type { JsonRpcRequest, ProxyUsageEvent } from '../src/types.js';

class StubBuffer {
  events: ProxyUsageEvent[] = [];
  drops: Array<{ events: ProxyUsageEvent[]; reason: string; detail?: string }> = [];
  push(event: ProxyUsageEvent) { this.events.push(event); }
  recordDrop(events: ProxyUsageEvent[], reason: string, detail?: string) { this.drops.push({ events, reason, detail }); }
}

class StubHeartbeat {
  activeSessionId: string | null = null;
  startSession(id: string) { this.activeSessionId = id; }
}

function toolsCall(id: number, name: string, meta: Record<string, unknown> = { agent_id: 'agent_1' }): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {}, _meta: meta } } as JsonRpcRequest;
}

describe('request-derived toolName', () => {
  let buffer: StubBuffer;
  let tracker: ToolCallTracker;
  let stderr: string[];
  let realWrite: typeof process.stderr.write;

  const truncationWarnings = () => stderr.filter((line) => line.includes('truncated to'));
  /** Run one proxied tools/call through the same parse → track path the proxy uses. */
  function roundTrip(id: number, name: string, meta?: Record<string, unknown>, session = 'sess_1'): boolean {
    const call = extractToolCall(toolsCall(id, name, meta));
    assert.ok(call);
    const metered = tracker.trackRequest(call, session);
    tracker.trackResponse({ requestId: id, hasError: false, responseBytes: 1 }, session);
    return metered;
  }

  beforeEach(() => {
    buffer = new StubBuffer();
    tracker = new ToolCallTracker({
      buffer: buffer as any,
      heartbeat: new StubHeartbeat() as any,
      tenantId: 'test_tenant',
      productId: 'prod_001',
      transport: 'stdio',
    });
    stderr = [];
    realWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realWrite;
    tracker.shutdown();
  });

  it('meters a call whose tool name is over 64 chars, with the name cut to exactly 64', () => {
    const name = 'search_' + 'x'.repeat(300);
    assert.equal(roundTrip(1, name), true);

    assert.equal(buffer.drops.length, 0);
    assert.equal(buffer.events.length, 1);
    assert.equal(buffer.events[0].toolName, name.slice(0, 64));
    assert.equal(buffer.events[0].toolName?.length, 64);
    assert.equal(buffer.events[0].executionStatus, 'SUCCESS');
    assert.equal(tracker.getStats().toolCallCount, 1);
  });

  it('warns once per label across two truncated calls', () => {
    roundTrip(1, 'a'.repeat(100));
    roundTrip(2, 'b'.repeat(500));

    assert.equal(buffer.events.length, 2);
    const warnings = truncationWarnings();
    assert.equal(warnings.length, 1);
    const entry = JSON.parse(warnings[0]);
    assert.equal(entry.level, 'warn');
    assert.equal(entry.field, 'toolName');
    assert.equal(entry.limit, 64);
    assert.match(entry.msg, /truncated to 64 characters/);
  });

  it('does not warn for a name at the limit', () => {
    roundTrip(1, 'x'.repeat(64));
    assert.equal(buffer.events[0].toolName, 'x'.repeat(64));
    assert.equal(truncationWarnings().length, 0);
  });

  it('never leaves half a surrogate pair', () => {
    roundTrip(1, 't'.repeat(63) + '\u{1F600}' + 'tail');
    const sent = buffer.events[0].toolName ?? '';
    assert.equal(sent, 't'.repeat(63));
    const last = sent.charCodeAt(sent.length - 1);
    assert.equal(last >= 0xd800 && last <= 0xdbff, false);

    assert.equal(truncateToLimit('t'.repeat(62) + '\u{1F600}' + 'tail', 64), 't'.repeat(62) + '\u{1F600}');
    assert.equal(truncateToLimit('short', 64), 'short');
  });

  it('keeps a full-length idempotency key, distinct for names that share the first 64 chars', () => {
    const shared = 'tool_' + 'x'.repeat(300);
    roundTrip(1, shared + '_alpha');
    roundTrip(2, shared + '_beta');

    const [a, b] = buffer.events;
    assert.equal(a.toolName, b.toolName); // same label after the cut
    assert.match(a.idempotencyKey, /^[0-9a-f]{32}$/); // digest of the full inputs, never cut
    assert.match(b.idempotencyKey, /^[0-9a-f]{32}$/);
    assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  });

  it('still drops a call whose customerId is over 64 chars as invalid, even with an over-long tool name', () => {
    assert.equal(roundTrip(1, 'x'.repeat(300), { agent_id: 'agent_1', customer_id: 'c'.repeat(65) }), false);

    assert.equal(buffer.events.length, 0);
    assert.equal(buffer.drops.length, 1);
    assert.equal(buffer.drops[0].reason, 'invalid');
    assert.match(buffer.drops[0].detail ?? '', /customerId .* exceeds 64 chars/);
    assert.equal(buffer.drops[0].events[0].customerId, 'c'.repeat(65));
  });

  it('still drops a call whose agentId is over 36 chars as invalid', () => {
    assert.equal(roundTrip(1, 'search', { agent_id: 'a'.repeat(37) }), false);
    assert.equal(buffer.events.length, 0);
    assert.equal(buffer.drops[0].reason, 'invalid');
    assert.equal(buffer.drops[0].events[0].agentId, 'a'.repeat(37));
  });
});
