/**
 * @file Unit tests for EventBuffer — flush triggers, batching.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBuffer } from '../src/telemetry/EventBuffer.js';
import type { ProxyUsageEvent } from '../src/types.js';

function makeEvent(toolName: string): ProxyUsageEvent {
  return {
    customerId: 'agent_1',
    metricName: 'mcp_server.tool_invocations',
    quantity: 1,
    occurredAt: new Date().toISOString(),
    idempotencyKey: `key_${toolName}_${Date.now()}`,
    productType: 'MCP_SERVER',
    toolName,
    agentId: 'agent_1',
    sessionId: 'session_1',
    executionStatus: 'SUCCESS',
    executionDurationMs: 100,
    metadata: { proxy: true, proxyVersion: '1.0.0', transport: 'stdio', productId: 'prod_1' },
  };
}

// Stub IngestorClient
class StubClient {
  batches: ProxyUsageEvent[][] = [];
  async sendBatch(events: ProxyUsageEvent[]) {
    this.batches.push([...events]);
    return { accepted: events.length, duplicates: 0, failed: 0 };
  }
}

describe('EventBuffer', () => {
  let buffer: EventBuffer;
  let client: StubClient;

  afterEach(async () => {
    if (buffer) await buffer.shutdown();
  });

  it('flushes when count threshold is reached', async () => {
    client = new StubClient();
    buffer = new EventBuffer({
      flushCount: 3,
      flushIntervalMs: 60_000, // Very long — won't trigger during test
      client: client as any,
    });

    buffer.push(makeEvent('a'));
    buffer.push(makeEvent('b'));
    assert.equal(client.batches.length, 0);

    buffer.push(makeEvent('c')); // Triggers flush

    // Wait for async flush
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(client.batches.length, 1);
    assert.equal(client.batches[0].length, 3);
  });

  it('reports correct size', () => {
    client = new StubClient();
    buffer = new EventBuffer({
      flushCount: 100,
      flushIntervalMs: 60_000,
      client: client as any,
    });

    assert.equal(buffer.size, 0);
    buffer.push(makeEvent('a'));
    assert.equal(buffer.size, 1);
    buffer.push(makeEvent('b'));
    assert.equal(buffer.size, 2);
  });

  it('manual flush drains all events', async () => {
    client = new StubClient();
    buffer = new EventBuffer({
      flushCount: 100,
      flushIntervalMs: 60_000,
      client: client as any,
    });

    buffer.push(makeEvent('a'));
    buffer.push(makeEvent('b'));

    await buffer.flush();

    assert.equal(client.batches.length, 1);
    assert.equal(client.batches[0].length, 2);
    assert.equal(buffer.size, 0);
  });

  it('flush is a no-op when buffer is empty', async () => {
    client = new StubClient();
    buffer = new EventBuffer({
      flushCount: 100,
      flushIntervalMs: 60_000,
      client: client as any,
    });

    await buffer.flush();
    assert.equal(client.batches.length, 0);
  });

  it('shutdown stops timer and flushes remaining', async () => {
    client = new StubClient();
    buffer = new EventBuffer({
      flushCount: 100,
      flushIntervalMs: 60_000,
      client: client as any,
    });

    buffer.push(makeEvent('a'));
    buffer.push(makeEvent('b'));

    await buffer.shutdown();

    assert.equal(client.batches.length, 1);
    assert.equal(client.batches[0].length, 2);
  });

  it('sends more than 1000 buffered events as slices of at most 1000', async () => {
    client = new StubClient();
    buffer = new EventBuffer({ flushCount: 5000, flushIntervalMs: 60_000, client: client as any });

    for (let i = 0; i < 2500; i++) buffer.push(makeEvent(`t${i}`));
    await buffer.flush();

    assert.deepEqual(client.batches.map(b => b.length), [1000, 1000, 500]);
    assert.equal(buffer.size, 0);
  });

  describe('drop accounting', () => {
    const outcomeClient = (outcome: any) => ({
      bodies: [] as ProxyUsageEvent[][],
      async sendBatch() { throw new Error('sendBatchDetailed should be used'); },
      async sendBatchDetailed(events: ProxyUsageEvent[]) { this.bodies.push([...events]); return outcome; },
    });
    const make = (c: any, drops: Array<{ events: ProxyUsageEvent[]; reason: string }>) => new EventBuffer({
      flushCount: 100, flushIntervalMs: 60_000, client: c,
      onDrop: (events, reason) => drops.push({ events, reason }),
    });

    it('a batch that exhausts its retries is dropped as retry_exhausted, keys intact', async () => {
      const drops: Array<{ events: ProxyUsageEvent[]; reason: string }> = [];
      buffer = make(outcomeClient({ result: null, reason: 'retry_exhausted', message: 'HTTP 503' }), drops);
      const a = makeEvent('a');
      buffer.push(a);
      buffer.push(makeEvent('b'));
      await buffer.flush();
      assert.equal(buffer.droppedCount, 2);
      assert.equal(drops.length, 1);
      assert.equal(drops[0].reason, 'retry_exhausted');
      assert.equal(drops[0].events[0].idempotencyKey, a.idempotencyKey);
    });

    it('a non-retryable 4xx batch is dropped as rejected', async () => {
      const drops: Array<{ events: ProxyUsageEvent[]; reason: string }> = [];
      buffer = make(outcomeClient({ result: null, reason: 'rejected', message: 'HTTP 400: bad' }), drops);
      buffer.push(makeEvent('a'));
      await buffer.flush();
      assert.equal(buffer.droppedCount, 1);
      assert.equal(drops[0].reason, 'rejected');
    });

    it('per-event errors[] in a 2xx response drop only the named events', async () => {
      const drops: Array<{ events: ProxyUsageEvent[]; reason: string }> = [];
      buffer = make(outcomeClient({
        result: { accepted: 2, duplicates: 0, failed: 1, errors: [{ index: 1, message: 'Metric not found' }] },
      }), drops);
      buffer.push(makeEvent('a'));
      buffer.push(makeEvent('b'));
      buffer.push(makeEvent('c'));
      await buffer.flush();
      assert.equal(buffer.droppedCount, 1);
      assert.equal(drops.length, 1);
      assert.equal(drops[0].reason, 'rejected');
      assert.deepEqual(drops[0].events.map((e) => e.toolName), ['b']);
    });

    it('a failure count without indexes is counted but not attributed to events', async () => {
      const drops: Array<{ events: ProxyUsageEvent[]; reason: string }> = [];
      buffer = make(outcomeClient({ result: { accepted: 1, duplicates: 0, failed: 1 } }), drops);
      buffer.push(makeEvent('a'));
      buffer.push(makeEvent('b'));
      await buffer.flush();
      assert.equal(buffer.droppedCount, 1);
      assert.equal(drops.length, 0);
    });

    it('recordDrop counts invalid events and survives a throwing hook', () => {
      buffer = new EventBuffer({
        flushCount: 100, flushIntervalMs: 60_000, client: new StubClient() as any,
        onDrop: () => { throw new Error('hook bug'); },
      });
      assert.doesNotThrow(() => buffer.recordDrop([makeEvent('a')], 'invalid', 'toolName exceeds 64 chars'));
      assert.equal(buffer.droppedCount, 1);
      assert.equal(buffer.size, 0);
    });

    it('a delivered batch drops nothing', async () => {
      const drops: Array<{ events: ProxyUsageEvent[]; reason: string }> = [];
      buffer = make(outcomeClient({ result: { accepted: 1, duplicates: 0, failed: 0 } }), drops);
      buffer.push(makeEvent('a'));
      await buffer.flush();
      assert.equal(buffer.droppedCount, 0);
      assert.equal(drops.length, 0);
    });
  });
});
