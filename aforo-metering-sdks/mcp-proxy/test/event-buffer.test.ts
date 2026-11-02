/**
 * @file EventBuffer on the shared transport core, against the repo's
 * fault-injecting mock ingestor (real HTTP): flush triggers, batching, the
 * single flusher, and drop accounting — an outage re-queues with the same
 * keys, a non-retryable 4xx drops as 'rejected', per-event `retryable`
 * failures are re-sent, a slow answer past the timeout is retried, shutdown
 * honours its deadline, and overflow drops the oldest while the ingestor is down.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBuffer, type EventBufferConfig } from '../src/telemetry/EventBuffer.js';
import type { DropReason, ProxyUsageEvent } from '../src/types.js';
import { startMockIngestor, waitUntil, type MockIngestor } from './support/mock-ingestor.js';

let seq = 0;
function makeEvent(toolName: string): ProxyUsageEvent {
  return {
    customerId: 'cust_1',
    metricName: 'mcp_server.tool_invocations',
    quantity: 1,
    occurredAt: new Date().toISOString(),
    idempotencyKey: `key_${toolName}_${++seq}`,
    productType: 'MCP_SERVER',
    toolName,
    agentId: 'agent_1',
    sessionId: 'session_1',
    executionStatus: 'SUCCESS',
    executionDurationMs: 100,
    metadata: { proxy: true, proxyVersion: '2.1.0', transport: 'stdio', productId: 'prod_1' },
  };
}

describe('EventBuffer (mock ingestor)', () => {
  let mock: MockIngestor;
  let buffers: EventBuffer[] = [];
  let drops: Array<{ events: ProxyUsageEvent[]; reason: DropReason }> = [];

  before(async () => { mock = await startMockIngestor(); });
  after(async () => { await mock.close(); });
  beforeEach(async () => { await mock.reset(); drops = []; });
  afterEach(async () => {
    await fetch(`${mock.url}/__control/faults`, { method: 'DELETE' });
    for (const b of buffers) await b.shutdown();
    buffers = [];
  });

  function make(extra: Partial<EventBufferConfig> = {}): EventBuffer {
    const b = new EventBuffer({
      baseUrl: mock.url, apiKey: 'sk_test', tenantId: 't1',
      flushIntervalMs: 3_600_000, maxRetries: 0,
      onDrop: (events, reason) => drops.push({ events, reason }),
      ...extra,
    });
    buffers.push(b);
    return b;
  }

  it('flushes when the count threshold is reached, without an explicit flush', async () => {
    const b = make({ flushCount: 3 });
    for (const t of ['a', 'b', 'c']) b.push(makeEvent(t));
    const state = await mock.waitFor((s) => s.acceptedCount === 3);
    assert.equal(state.requests.length, 1);
    assert.equal(b.size, 0);
  });

  it('reports the queue size and drains it on flush', async () => {
    const b = make({ flushCount: 100 });
    b.push(makeEvent('a'));
    b.push(makeEvent('b'));
    assert.equal(b.size, 2);
    const r = await b.flush();
    assert.equal(r.sent, 2);
    assert.equal(b.size, 0);
  });

  it('flush is a no-op when nothing is queued', async () => {
    const b = make();
    const r = await b.flush();
    assert.equal(r.sent, 0);
    assert.equal((await mock.state()).requests.length, 0);
  });

  it('shutdown sends what is queued', async () => {
    const b = make({ flushCount: 100 });
    b.push(makeEvent('a'));
    await b.shutdown();
    assert.equal((await mock.state()).acceptedCount, 1);
  });

  it('sends more than 1000 queued events as requests of at most 1000, one at a time', async () => {
    const b = make({ flushCount: 5000 });
    for (let i = 0; i < 2500; i++) b.push(makeEvent(`t${i}`));
    await b.flush();
    const state = await mock.state();
    assert.deepEqual(state.requests.map((r) => r.eventCount), [1000, 1000, 500]);
    assert.equal(state.maxInFlight, 1);
  });

  it('sends X-API-Key and X-Tenant-Id, never Authorization', async () => {
    let headers: Record<string, string> = {};
    const b = make({
      fetch: async (url, init) => { headers = init.headers; return fetch(url, init); },
    });
    b.push(makeEvent('a'));
    await b.flush();
    assert.equal(headers['X-API-Key'], 'sk_test');
    assert.equal(headers['X-Tenant-Id'], 't1');
    assert.equal(headers.Authorization, undefined);
    assert.match(headers['User-Agent'], /^aforo-mcp-proxy\//);
  });

  describe('drop accounting', () => {
    it('an outage re-queues the batch with the same keys; nothing is dropped', async () => {
      const b = make();
      await mock.faults([{ status: 503, times: 1 }]);
      const events = [makeEvent('a'), makeEvent('b')];
      for (const e of events) b.push(e);
      const first = await b.flush();
      assert.equal(first.requeued, 2);
      assert.equal(b.droppedCount, 0);
      assert.deepEqual(drops, []);
      await b.flush();
      const state = await mock.state();
      assert.deepEqual(state.events.map((e) => e.idempotencyKey), events.map((e) => e.idempotencyKey));
    });

    it('401 is an outage, not a drop', async () => {
      const b = make();
      await mock.faults([{ status: 401, times: 1 }]);
      b.push(makeEvent('a'));
      await b.flush();
      assert.deepEqual(drops, []);
      assert.equal((await b.flush()).sent, 1);
    });

    it('a non-retryable 4xx batch is dropped as rejected, not retried', async () => {
      const b = make({ maxRetries: 3 });
      await mock.faults([{ status: 422, times: 1 }]);
      b.push(makeEvent('a'));
      await b.flush();
      assert.equal(drops.length, 1);
      assert.equal(drops[0].reason, 'rejected');
      assert.equal(b.droppedCount, 1);
      assert.equal((await mock.state()).requests.length, 1);
    });

    it('per-event errors: retryable ones are re-sent, the others dropped as rejected', async () => {
      const b = make();
      await mock.faults([{ perEvent: [{ index: 0, message: 'busy', retryable: true }, { index: 1, message: 'unknown metric', retryable: false }] }]);
      for (const t of ['a', 'b', 'c']) b.push(makeEvent(t));
      const first = await b.flush();
      assert.deepEqual([first.sent, first.failed, first.requeued], [1, 1, 1]);
      assert.deepEqual(drops.map((d) => [d.reason, d.events[0].toolName]), [['rejected', 'b']]);
      await b.flush();
      assert.deepEqual((await mock.state()).events.map((e) => e.toolName).sort(), ['a', 'c']);
    });

    it('a response slower than the request timeout is retried, not lost', async () => {
      const b = make({ timeoutMs: 100 });
      await mock.faults([{ delayMs: 600, times: 1 }]);
      b.push(makeEvent('slow'));
      assert.equal((await b.flush()).requeued, 1);
      assert.equal((await b.flush()).sent, 1);
      assert.deepEqual(drops, []);
    });

    it('shutdown while a request hangs stops at the deadline and reports the leftovers', async () => {
      const b = make({ shutdownTimeoutMs: 300 });
      await mock.faults([{ hang: true, times: -1 }]);
      b.push(makeEvent('a'));
      b.push(makeEvent('b'));
      const started = Date.now();
      await b.shutdown();
      assert.ok(Date.now() - started < 3000);
      assert.deepEqual(drops.map((d) => [d.reason, d.events.length]), [['shutdown', 2]]);
      b.push(makeEvent('late'));
      assert.equal(drops[1].reason, 'closed');
    });

    it('while the ingestor is down the queue is bounded: overflow drops the oldest', async () => {
      const b = make({ maxQueueSize: 2 });
      await mock.faults([{ status: 503, times: -1 }]);
      b.push(makeEvent('first'));
      b.push(makeEvent('second'));
      await b.flush();
      b.push(makeEvent('third'));
      assert.deepEqual(drops.map((d) => [d.reason, d.events[0].toolName]), [['overflow', 'first']]);
      assert.equal(b.size, 2);
    });

    it('recordDrop counts invalid events and survives a throwing hook', () => {
      const b = make({ onDrop: () => { throw new Error('hook bug'); } });
      b.recordDrop([makeEvent('x')], 'invalid', 'agentId too long');
      assert.equal(b.droppedCount, 1);
    });

    it('a delivered batch drops nothing', async () => {
      const b = make();
      b.push(makeEvent('a'));
      await b.flush();
      await waitUntil(async () => (await mock.state()).acceptedCount === 1);
      assert.equal(b.droppedCount, 0);
      assert.deepEqual(drops, []);
    });
  });
});
