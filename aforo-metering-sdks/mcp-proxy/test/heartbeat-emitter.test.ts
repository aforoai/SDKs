import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HeartbeatEmitter } from '../src/telemetry/HeartbeatEmitter.js';

describe('HeartbeatEmitter', () => {
  it('tracks the session but never pushes heartbeat events into the usage buffer', async () => {
    // Heartbeats (quantity 0) fail the ingestor's @Positive check and take every
    // real tool call in the same batch down with them.
    const pushed: unknown[] = [];
    const buffer = { push: (e: unknown) => pushed.push(e) } as any;
    const hb = new HeartbeatEmitter({
      intervalMs: 1, buffer, tenantId: 't', productId: 'p', transport: 'stdio',
    });

    hb.startSession('sess_1');
    assert.equal(hb.activeSessionId, 'sess_1');
    await new Promise((r) => setTimeout(r, 20));
    await hb.stopSession();

    assert.equal(hb.activeSessionId, null);
    assert.deepEqual(pushed, []);
  });
});
