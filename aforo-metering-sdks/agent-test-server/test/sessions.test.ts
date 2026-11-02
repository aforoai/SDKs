import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionStore,
  SessionCapacityExceededError,
  SessionEndedError,
  UnknownSessionError,
} from '../src/sessions.js';

test('SessionStore.create returns a distinct id + records agentId', () => {
  const store = new SessionStore({ sweepIntervalMs: 0 });
  try {
    const a = store.create({ agentId: 'agt_a' });
    const b = store.create({ agentId: 'agt_b' });
    assert.notEqual(a.id, b.id);
    assert.equal(a.agentId, 'agt_a');
    assert.equal(b.agentId, 'agt_b');
    assert.equal(store.activeCount(), 2);
  } finally {
    store.dispose();
  }
});

test('SessionStore enforces capacity — 3rd create throws SessionCapacityExceededError', () => {
  const store = new SessionStore({ capacity: 2, sweepIntervalMs: 0 });
  try {
    store.create({ agentId: 'a' });
    store.create({ agentId: 'b' });
    assert.throws(() => store.create({ agentId: 'c' }), SessionCapacityExceededError);
  } finally {
    store.dispose();
  }
});

test('SessionStore.end is idempotent and returns the same terminal state', () => {
  const store = new SessionStore({ sweepIntervalMs: 0 });
  try {
    const s = store.create({ agentId: 'agt_1' });
    const first = store.end(s.id);
    const second = store.end(s.id);
    assert.equal(first.status, 'ended');
    assert.equal(second.status, 'ended');
    assert.equal(first.endedAt, second.endedAt);
  } finally {
    store.dispose();
  }
});

test('SessionStore.recordInvocation on an ended session throws SessionEndedError', () => {
  const store = new SessionStore({ sweepIntervalMs: 0 });
  try {
    const s = store.create({ agentId: 'agt_1' });
    store.end(s.id);
    assert.throws(
      () => store.recordInvocation(s.id, { tokensIn: 1, tokensOut: 2, status: 'SUCCESS' }),
      SessionEndedError,
    );
  } finally {
    store.dispose();
  }
});

test('SessionStore.recordInvocation on unknown id throws UnknownSessionError', () => {
  const store = new SessionStore({ sweepIntervalMs: 0 });
  try {
    assert.throws(
      () => store.recordInvocation('sess_missing', { tokensIn: 1, tokensOut: 1, status: 'SUCCESS' }),
      UnknownSessionError,
    );
  } finally {
    store.dispose();
  }
});

test('SessionStore.recordInvocation bumps counters + lastActivityAt', async () => {
  const store = new SessionStore({ sweepIntervalMs: 0 });
  try {
    const s = store.create({ agentId: 'agt_1' });
    const before = s.lastActivityAt;
    // Small artificial wait so lastActivityAt advances by >= 1 ms. Written
    // as a proper async test — the earlier version returned a promise from
    // a sync callback wrapped in try/catch that couldn't actually catch
    // async rejections (code smell — production audit fix).
    await new Promise((r) => setTimeout(r, 5));
    const updated = store.recordInvocation(s.id, {
      tokensIn: 100,
      tokensOut: 250,
      status: 'SUCCESS',
    });
    assert.equal(updated.invocationCount, 1);
    assert.equal(updated.totalTokensIn, 100);
    assert.equal(updated.totalTokensOut, 250);
    assert.ok(updated.lastActivityAt >= before);
  } finally {
    store.dispose();
  }
});

test('SessionStore.sweep drops active sessions past idle timeout', () => {
  const store = new SessionStore({ idleTimeoutSec: 1, sweepIntervalMs: 0 });
  try {
    const s = store.create({ agentId: 'agt_idle' });
    assert.equal(store.activeCount(), 1);
    // Sweep with a future "now" 2s ahead — session's lastActivityAt is
    // in the past by more than idleTimeoutSec, so it should drop.
    const dropped = store.sweep(s.lastActivityAt + 2000);
    assert.equal(dropped, 1);
    assert.equal(store.activeCount(), 0);
  } finally {
    store.dispose();
  }
});

test('SessionStore.sweep retains ended sessions inside the 2× idle window', () => {
  const store = new SessionStore({ idleTimeoutSec: 60, sweepIntervalMs: 0 });
  try {
    const s = store.create({ agentId: 'agt_end' });
    store.end(s.id);
    // Sweep immediately — endedAt is very recent so should NOT be dropped.
    const dropped = store.sweep();
    assert.equal(dropped, 0);
    assert.ok(store.get(s.id));
  } finally {
    store.dispose();
  }
});

test('SessionStore.dispose stops the sweeper and clears the map', () => {
  const store = new SessionStore({ sweepIntervalMs: 0 });
  store.create({ agentId: 'a' });
  assert.equal(store.totalCount(), 1);
  store.dispose();
  assert.equal(store.totalCount(), 0);
});
