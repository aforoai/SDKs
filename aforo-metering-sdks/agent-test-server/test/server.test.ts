import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentTestServer } from '../src/server.js';
import { listCapabilities, hasCapability } from '../src/capabilities.js';

test('info() returns package name + version', () => {
  const s = new AgentTestServer();
  const info = s.info();
  assert.match(info.name, /agent-test-server/);
  assert.equal(typeof info.version, 'string');
  s.dispose();
});

test('capabilities() returns the 5 canonical capabilities matching research-agent.yaml', () => {
  const s = new AgentTestServer();
  const names = s.capabilities().map((c) => c.name).sort();
  assert.deepEqual(names, [
    'answer_question',
    'extract_entities',
    'rank_sources',
    'summarize_url',
    'verify_claim',
  ]);
  s.dispose();
});

test('listCapabilities and hasCapability are consistent', () => {
  for (const c of listCapabilities()) {
    assert.equal(hasCapability(c.name), true, `hasCapability(${c.name}) should be true`);
  }
  assert.equal(hasCapability('does_not_exist'), false);
});

test('createSession succeeds and returns a sess_ prefixed id', () => {
  const s = new AgentTestServer();
  const r = s.createSession({ agentId: 'agt_1' });
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.match(r.value.sessionId, /^sess_[0-9a-f]{24}$/);
    assert.equal(r.value.agentId, 'agt_1');
    assert.equal(typeof r.value.startedAt, 'string');
  }
  s.dispose();
});

test('createSession rejects missing agentId with 400 missing_field', () => {
  const s = new AgentTestServer();
  const r = s.createSession({} as { agentId: string });
  assert.equal(r.kind, 'error');
  if (r.kind === 'error') {
    assert.equal(r.status, 400);
    assert.equal(r.code, 'missing_field');
  }
  s.dispose();
});

test('createSession enforces capacity cap → 429 session_capacity_exceeded', () => {
  const s = new AgentTestServer({ sessionOptions: { capacity: 2 } });
  s.createSession({ agentId: 'a1' });
  s.createSession({ agentId: 'a2' });
  const overflow = s.createSession({ agentId: 'a3' });
  assert.equal(overflow.kind, 'error');
  if (overflow.kind === 'error') {
    assert.equal(overflow.status, 429);
    assert.equal(overflow.code, 'session_capacity_exceeded');
  }
  s.dispose();
});

test('getSession returns 404 unknown_session for a bogus id', () => {
  const s = new AgentTestServer();
  const r = s.getSession('sess_does_not_exist');
  assert.equal(r.kind, 'error');
  if (r.kind === 'error') {
    assert.equal(r.status, 404);
    assert.equal(r.code, 'unknown_session');
  }
  s.dispose();
});

test('invoke dispatches summarize_url and records tokens on the session', async () => {
  const s = new AgentTestServer();
  const create = s.createSession({ agentId: 'agt_x' });
  assert.equal(create.kind, 'ok');
  if (create.kind !== 'ok') return;
  const sessionId = create.value.sessionId;

  const r = await s.invoke({
    sessionId,
    capability: 'summarize_url',
    input: { url: 'https://example.com/article', length: 'short' },
  });
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.value.capability, 'summarize_url');
    assert.equal(r.value.executionStatus, 'SUCCESS');
    assert.ok(r.value.tokensIn > 0);
    assert.ok(r.value.tokensOut > 0);
    assert.match(r.value.invocationId, /^inv_[0-9a-f]{20}$/);
  }

  const view = s.getSession(sessionId);
  if (view.kind === 'ok') {
    assert.equal(view.value.invocationCount, 1);
    assert.ok(view.value.totalTokensIn > 0);
  }
  s.dispose();
});

test('invoke returns 404 for unknown session before checking the capability', async () => {
  const s = new AgentTestServer();
  const r = await s.invoke({
    sessionId: 'sess_missing',
    capability: 'summarize_url',
    input: { url: 'https://x' },
  });
  assert.equal(r.kind, 'error');
  if (r.kind === 'error') {
    assert.equal(r.status, 404);
    assert.equal(r.code, 'unknown_session');
  }
  s.dispose();
});

test('invoke returns 404 for a valid session with an unknown capability', async () => {
  const s = new AgentTestServer();
  const create = s.createSession({ agentId: 'agt_1' });
  if (create.kind !== 'ok') return;
  const r = await s.invoke({
    sessionId: create.value.sessionId,
    capability: 'not_a_real_capability',
  });
  assert.equal(r.kind, 'error');
  if (r.kind === 'error') {
    assert.equal(r.status, 404);
    assert.equal(r.code, 'unknown_capability');
  }
  s.dispose();
});

test('invoke returns 410 session_ended after end()', async () => {
  const s = new AgentTestServer();
  const create = s.createSession({ agentId: 'agt_1' });
  if (create.kind !== 'ok') return;
  const sessionId = create.value.sessionId;
  s.endSession(sessionId);
  const r = await s.invoke({ sessionId, capability: 'summarize_url', input: { url: 'https://x' } });
  assert.equal(r.kind, 'error');
  if (r.kind === 'error') {
    assert.equal(r.status, 410);
    assert.equal(r.code, 'session_ended');
  }
  s.dispose();
});

test('endSession is idempotent — calling twice returns the same terminal snapshot', () => {
  const s = new AgentTestServer();
  const create = s.createSession({ agentId: 'agt_1' });
  if (create.kind !== 'ok') return;
  const sessionId = create.value.sessionId;
  const first = s.endSession(sessionId);
  const second = s.endSession(sessionId);
  assert.equal(first.kind, 'ok');
  assert.equal(second.kind, 'ok');
  if (first.kind === 'ok' && second.kind === 'ok') {
    assert.equal(first.value.sessionId, second.value.sessionId);
    assert.equal(first.value.invocationCount, second.value.invocationCount);
  }
  s.dispose();
});

test('verify_claim returns HITL_REQUIRED when require_hitl=true', async () => {
  const s = new AgentTestServer();
  const create = s.createSession({ agentId: 'agt_1' });
  if (create.kind !== 'ok') return;
  const r = await s.invoke({
    sessionId: create.value.sessionId,
    capability: 'verify_claim',
    input: { claim: 'The sky is blue', sources: ['https://s1'], require_hitl: true },
  });
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.value.executionStatus, 'HITL_REQUIRED');
  }
  s.dispose();
});

test('capability handlers are deterministic — same input, same output', async () => {
  const s = new AgentTestServer();
  const create = s.createSession({ agentId: 'agt_1' });
  if (create.kind !== 'ok') return;

  const first = await s.invoke({
    sessionId: create.value.sessionId,
    capability: 'summarize_url',
    input: { url: 'https://example.com/x', length: 'medium' },
  });
  const second = await s.invoke({
    sessionId: create.value.sessionId,
    capability: 'summarize_url',
    input: { url: 'https://example.com/x', length: 'medium' },
  });
  if (first.kind === 'ok' && second.kind === 'ok') {
    // Everything except invocationId (which is a random hex) must be equal.
    assert.deepEqual(first.value.output, second.value.output);
    assert.equal(first.value.executionDurationMs, second.value.executionDurationMs);
    assert.equal(first.value.tokensIn, second.value.tokensIn);
    assert.equal(first.value.tokensOut, second.value.tokensOut);
  }
  s.dispose();
});
