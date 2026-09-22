import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HeartbeatEmitter } from '../src/telemetry/HeartbeatEmitter.js';
import type { ProxyUsageEvent } from '../src/types.js';

class StubClient {
  sent: ProxyUsageEvent[] = [];
  fail = false;
  async sendSingle(event: ProxyUsageEvent) {
    this.sent.push(event);
    if (this.fail) return null;
    return { accepted: 0, duplicates: 0, failed: 0 };
  }
}

const base = { tenantId: 't', productId: 'p', transport: 'stdio' };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('HeartbeatEmitter', () => {
  it('sends heartbeats through their own single-event requests, never the usage buffer', async () => {
    const pushed: unknown[] = [];
    const buffer = { push: (e: unknown) => pushed.push(e) } as any;
    const client = new StubClient();
    const hb = new HeartbeatEmitter({ ...base, intervalMs: 60_000, client, buffer });

    hb.startSession('sess_1', 'cust_1');
    assert.equal(hb.activeSessionId, 'sess_1');
    await tick();
    await hb.stopSession();

    assert.equal(hb.activeSessionId, null);
    assert.deepEqual(pushed, []);
    assert.deepEqual(client.sent.map((e) => e.sessionBoundary), ['HEARTBEAT', 'SESSION_END']);
    for (const e of client.sent) {
      assert.equal(e.metricName, 'system.session.heartbeat');
      assert.equal(e.quantity, 1);
      assert.equal(e.customerId, 'cust_1');
      assert.equal(e.sessionId, 'sess_1');
      assert.equal(e.productType, 'MCP_SERVER');
      assert.equal((e.metadata as any).sessionId, 'sess_1');
      assert.equal((e.metadata as any).sessionBoundary, e.sessionBoundary);
      assert.equal((e.metadata as any).productType, 'MCP_SERVER');
      assert.equal(new Date(e.occurredAt).toISOString(), e.occurredAt);
    }
    assert.notEqual(client.sent[0].idempotencyKey, client.sent[1].idempotencyKey);
  });

  it('sends periodic heartbeats and stops them on stopSession', async () => {
    const client = new StubClient();
    const hb = new HeartbeatEmitter({ ...base, intervalMs: 5, client });
    hb.startSession('sess_p');
    await tick(40);
    await hb.stopSession();
    const count = client.sent.length;
    assert.ok(count >= 3, `expected several heartbeats, got ${count}`);
    await tick(30);
    assert.equal(client.sent.length, count);
  });

  it('uses the configured customer and productType, else "system"', async () => {
    const client = new StubClient();
    const hb = new HeartbeatEmitter({ ...base, intervalMs: 60_000, client, customerId: 'cust_cfg', productType: ' agentic_api ' });
    hb.startSession('sess_c', 'cust_call');
    await hb.stopSession();
    assert.ok(client.sent.every((e) => e.customerId === 'cust_cfg' && e.productType === 'AGENTIC_API'));

    const c2 = new StubClient();
    const hb2 = new HeartbeatEmitter({ ...base, intervalMs: 60_000, client: c2 });
    hb2.startSession('sess_s');
    await hb2.stopSession();
    assert.ok(c2.sent.length > 0 && c2.sent.every((e) => e.customerId === 'system'));
  });

  it('swallows delivery failures', async () => {
    const client = new StubClient();
    client.fail = true;
    const hb = new HeartbeatEmitter({ ...base, intervalMs: 60_000, client });
    hb.startSession('sess_f');
    await hb.stopSession(); // must not throw
    assert.equal(client.sent.length, 2);

    const throwing = { sendSingle: async () => { throw new Error('boom'); } };
    const hb2 = new HeartbeatEmitter({ ...base, intervalMs: 60_000, client: throwing });
    hb2.startSession('sess_t');
    await hb2.stopSession(); // must not throw
  });
});
