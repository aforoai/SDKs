/**
 * Tests for {@link AforoAgent} — the AI Agent Metering SDK.
 *
 * Approach: pluggable {@code fetchImpl} captures every outbound POST so we
 * can assert on event payload shape, batching cadence, and session lifecycle
 * markers without standing up a mock HTTP server.
 */
import { AforoAgent, AgentSession } from './index';

interface CapturedRequest {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function makeFetch() {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (async (url: any, init: any) => {
    calls.push({
      url: typeof url === 'string' ? url : url.toString(),
      body: init?.body ? JSON.parse(init.body as string) : null,
      headers: (init?.headers as Record<string, string>) || {},
    });
    return new Response('{}', { status: 200 }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const baseConfig = (override?: Partial<ConstructorParameters<typeof AforoAgent>[0]>) => ({
  tenantId: 'tenant_test',
  productId: 'prod_test',
  apiKey: 'sk_test_abcdef',
  customerId: 'cust_test',
  flushBatchSize: 100, // suppress auto-batch flush for most tests
  flushIntervalMs: 9_999_999, // and the timer
  ...override,
});

describe('AforoAgent — config validation', () => {
  test('throws when tenantId missing', () => {
    expect(() => new AforoAgent({ tenantId: '', productId: 'p', apiKey: 'k' } as any))
        .toThrow('tenantId is required');
  });
  test('throws when productId missing', () => {
    expect(() => new AforoAgent({ tenantId: 't', productId: '', apiKey: 'k' } as any))
        .toThrow('productId is required');
  });
  test('throws when apiKey missing', () => {
    expect(() => new AforoAgent({ tenantId: 't', productId: 'p', apiKey: '' } as any))
        .toThrow('apiKey is required');
  });
});

describe('AforoAgent — session lifecycle', () => {
  test('startSession emits session_start event with framework metadata', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({
      agentId: 'agt_001',
      framework: 'CLAUDE',
      modelProvider: 'ANTHROPIC',
      modelName: 'claude-sonnet-4-6',
    });
    await agent.flush();
    expect(calls).toHaveLength(1);
    const events = (calls[0].body as any).events;
    expect(events).toHaveLength(1);
    expect(events[0].metadata.eventType).toBe('agent_session_start');
    expect(events[0].metricName).toBe('session_count');
    expect(events[0].productType).toBe('AI_AGENT');
    expect(events[0].customerId).toBe('cust_test');
    expect(events[0].agentId).toBe('agt_001');
    expect(events[0].sessionId).toBe(session.sessionId);
    expect(events[0].metadata.framework).toBe('CLAUDE');
    expect(events[0].metadata.modelProvider).toBe('ANTHROPIC');
    expect(events[0].metadata.modelName).toBe('claude-sonnet-4-6');
  });

  test('session.recordStep stamps stepIndex and emits 2 events when tokens present', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({
      stepKind: 'TOOL_CALL',
      capabilityName: 'web-search',
      inputTokens: 100,
      outputTokens: 50,
      executionStatus: 'SUCCESS',
    });
    await agent.flush();

    const events = (calls[0].body as any).events;
    // session_start + agent_step + token_usage = 3
    expect(events).toHaveLength(3);
    const step = events.find((e: any) => e.metadata.eventType === 'agent_step');
    expect(step.stepNumber).toBe(1);
    expect(step.capabilityName).toBe('web-search');
    expect(step.executionStatus).toBe('SUCCESS');
    const tokens = events.find((e: any) => e.metadata.eventType === 'token_usage');
    expect(tokens.quantity).toBe(150);
    expect(tokens.metadata.inputTokens).toBe(100);
    expect(tokens.metadata.outputTokens).toBe(50);
  });

  test('session.recordStep without tokens emits only one event', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({ stepKind: 'THOUGHT' });
    await agent.flush();
    const events = (calls[0].body as any).events;
    expect(events.filter((e: any) => e.metadata.eventType === 'token_usage')).toHaveLength(0);
  });

  test('session.recordStep increments stepIndex monotonically', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({ stepKind: 'THOUGHT' });
    await session.recordStep({ stepKind: 'TOOL_CALL', capabilityName: 't' });
    await session.recordStep({ stepKind: 'OBSERVATION' });
    await agent.flush();
    const steps = (calls[0].body as any).events.filter((e: any) => e.metadata.eventType === 'agent_step');
    expect(steps.map((s: any) => s.stepNumber)).toEqual([1, 2, 3]);
  });

  test('session.recordToolCall is a thin wrapper over recordStep', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordToolCall('web-search', { inputTokens: 50, outputTokens: 25 });
    await agent.flush();
    const step = (calls[0].body as any).events.find((e: any) => e.metadata.eventType === 'agent_step');
    expect(step.metadata.stepKind).toBe('TOOL_CALL');
    expect(step.capabilityName).toBe('web-search');
  });

  test('session.end records taskCompleted + step count + forces flush', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({ stepKind: 'TOOL_CALL', capabilityName: 't' });
    await session.recordStep({ stepKind: 'TOOL_CALL', capabilityName: 't2' });
    await session.end({ taskCompleted: true });
    // session.end must flush — no manual flush
    expect(calls).toHaveLength(1);
    const endEvt = (calls[0].body as any).events.find((e: any) => e.metadata.eventType === 'agent_session_end');
    expect(endEvt.metadata.taskCompleted).toBe(true);
    expect(endEvt.metadata.stepCount).toBe(2);
  });

  test('session.end propagates errorMessage on failure', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.end({ taskCompleted: false, errorMessage: 'rate limited' });
    const endEvt = (calls[0].body as any).events.find((e: any) => e.metadata.eventType === 'agent_session_end');
    expect(endEvt.metadata.taskCompleted).toBe(false);
    expect(endEvt.metadata.errorMessage).toBe('rate limited');
  });
});

describe('AforoAgent — batching + flush', () => {
  test('batch flushes when buffer reaches flushBatchSize', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent({
      tenantId: 't', productId: 'p', apiKey: 'k', customerId: 'c', fetchImpl,
      flushBatchSize: 3, flushIntervalMs: 9_999_999,
    });
    const session = await agent.startSession({ agentId: 'agt_001' }); // 1 event
    await session.recordStep({ stepKind: 'THOUGHT' }); // 1 event → total 2
    await session.recordStep({ stepKind: 'THOUGHT' }); // 1 event → total 3 → flush
    expect(calls).toHaveLength(1);
    expect((calls[0].body as any).events).toHaveLength(3);
  });

  test('headers carry tenantId + X-API-Key (and no Bearer)', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    await (await agent.startSession({ agentId: 'a' })).end({ taskCompleted: true });
    const headers = calls[0].headers;
    expect(headers['X-API-Key']).toBe('sk_test_abcdef');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['X-Tenant-Id']).toBe('tenant_test');
  });

  test('flush is a no-op when buffer is empty', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    await agent.flush();
    expect(calls).toHaveLength(0);
  });

  test('HTTP failure logs warning and drops batch (best-effort)', async () => {
    const calls: CapturedRequest[] = [];
    const failingFetch: typeof fetch = (async (url: any) => {
      calls.push({ url: String(url), body: null, headers: {} });
      return new Response('{}', { status: 503 }) as unknown as Response;
    }) as unknown as typeof fetch;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
    const agent = new AforoAgent(baseConfig({ fetchImpl: failingFetch, retryBaseDelayMs: 1 }));
    await (await agent.startSession({ agentId: 'a' })).end({ taskCompleted: true });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('503');
    expect(calls).toHaveLength(3); // 5xx is retried (3 attempts by default), then dropped
    warn.mockRestore();
  });
});

describe('AforoAgent — ingest batch contract', () => {
  const DTO_FIELDS = new Set([
    'customerId', 'metricName', 'quantity', 'occurredAt', 'idempotencyKey', 'productType',
    'agentId', 'sessionId', 'traceId', 'stepNumber', 'parentStepId', 'capabilityName',
    'executionStatus', 'executionDurationMs', 'metadata',
  ]);

  test('POSTs {events:[...]} to /v1/ingest/batch with X-API-Key and DTO-shaped events', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001', traceId: 'trace-1' });
    await session.recordStep({
      stepKind: 'TOOL_CALL', capabilityName: 'web-search', durationMs: 510.4,
      executionStatus: 'TIMEOUT', parentStepId: 'step-0', inputTokens: 3,
    });
    await session.end({ taskCompleted: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.aforo.ai/v1/ingest/batch');
    expect(calls[0].headers['X-API-Key']).toBe('sk_test_abcdef');
    expect(Object.keys(calls[0].body as object)).toEqual(['events']);
    const events = (calls[0].body as any).events;
    for (const e of events) {
      for (const k of Object.keys(e)) expect(DTO_FIELDS.has(k)).toBe(true);
      expect(JSON.stringify(e)).not.toContain('sk_test_abcdef');
      expect(e.apiKey).toBeUndefined();
      expect(e.customerId).toBe('cust_test');
      expect(e.productType).toBe('AI_AGENT');
      expect(e.agentId).toBe('agt_001');
      expect(e.sessionId).toBe(session.sessionId);
      expect(e.traceId).toBe('trace-1');
      expect(e.quantity).toBeGreaterThan(0);
      expect(e.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(typeof e.idempotencyKey).toBe('string');
    }
    const step = events.find((e: any) => e.metricName === 'step_count');
    expect(step).toMatchObject({
      stepNumber: 1, capabilityName: 'web-search', executionStatus: 'TIMEOUT',
      executionDurationMs: 510, parentStepId: 'step-0',
    });
    expect(step.metadata.durationMs).toBeUndefined();
    expect(new Set(events.map((e: any) => e.idempotencyKey)).size).toBe(events.length);
  });

  test('legacy /v1/ingest ingestorUrl is rewritten to /v1/ingest/batch', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl, ingestorUrl: 'http://localhost:8084/v1/ingest' }));
    await (await agent.startSession({ agentId: 'a' })).end({ taskCompleted: true });
    expect(calls[0].url).toBe('http://localhost:8084/v1/ingest/batch');
  });

  test('statuses outside the ingest enum ride in metadata, not executionStatus', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'a' });
    await session.recordStep({ stepKind: 'THOUGHT', executionStatus: 'HITL_REQUIRED' });
    await agent.flush();
    const step = (calls[0].body as any).events.find((e: any) => e.metricName === 'step_count');
    expect(step.executionStatus).toBeUndefined();
    expect(step.metadata.agentExecutionStatus).toBe('HITL_REQUIRED');
  });

  test('customerId is required (config or per session)', async () => {
    const { fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl, customerId: undefined }));
    await expect(agent.startSession({ agentId: 'a' })).rejects.toThrow('customerId is required');
    await expect(agent.startSession({ agentId: 'a', customerId: '  ' })).rejects.toThrow('customerId is required');
    const s = await agent.startSession({ agentId: 'a', customerId: 'cust_per_session' });
    expect(s.customerId).toBe('cust_per_session');
    await agent.flush(); // clear the pending flush timer
  });

  test('>1000 buffered events are split into requests of <=1000', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl, flushBatchSize: 5000 }));
    for (let i = 0; i < 2500; i++) {
      await agent.emitEvent({
        eventType: 'agent_step', metricKey: 'step_count', value: 1,
        agentId: 'a', sessionId: 's', properties: {},
      });
    }
    await agent.flush();
    expect(calls.map((c) => (c.body as any).events.length)).toEqual([1000, 1000, 500]);
    for (const c of calls) expect(c.url).toMatch(/\/v1\/ingest\/batch$/);
    const keys = calls.flatMap((c) => (c.body as any).events.map((e: any) => e.idempotencyKey));
    expect(new Set(keys).size).toBe(2500);
  });
});

describe('AforoAgent — productType, validation and retries', () => {
  test('productType: default AI_AGENT, client option, per session, per event (trimmed, uppercased)', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl, productType: ' agentic_api ' }));
    const s1 = await agent.startSession({ agentId: 'a' });
    await s1.recordStep({ stepKind: 'THOUGHT' });
    const s2 = await agent.startSession({ agentId: 'b', productType: 'ai_agent' });
    await s2.recordStep({ stepKind: 'THOUGHT' });
    await agent.emitEvent({
      eventType: 'x', metricKey: 'm', value: 1, agentId: 'a', sessionId: 's',
      properties: {}, productType: 'Future_Type',
    });
    await agent.flush();
    const types = (calls[0].body as any).events.map((e: any) => [e.agentId, e.productType]);
    expect(types).toEqual([
      ['a', 'AGENTIC_API'], ['a', 'AGENTIC_API'],
      ['b', 'AI_AGENT'], ['b', 'AI_AGENT'],
      ['a', 'FUTURE_TYPE'],
    ]);

    const { calls: c2, fetchImpl: f2 } = makeFetch();
    const def = new AforoAgent(baseConfig({ fetchImpl: f2 }));
    await (await def.startSession({ agentId: 'a' })).end({ taskCompleted: true });
    for (const e of (c2[0].body as any).events) expect(e.productType).toBe('AI_AGENT');
  });

  test('startSession rejects agentId over 36 chars', async () => {
    const { fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    await expect(agent.startSession({ agentId: 'x'.repeat(37) })).rejects.toThrow('at most 36');
  });

  test('emitEvent drops events missing agentId/sessionId/metric or with value <= 0', async () => {
    const { calls, fetchImpl } = makeFetch();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const base = { eventType: 'e', metricKey: 'm', value: 1, agentId: 'a', sessionId: 's', properties: {} };
    await agent.emitEvent({ ...base, agentId: ' ' });
    await agent.emitEvent({ ...base, agentId: 'x'.repeat(37) });
    await agent.emitEvent({ ...base, sessionId: '' });
    await agent.emitEvent({ ...base, metricKey: '' });
    await agent.emitEvent({ ...base, value: 0 });
    await agent.emitEvent({ ...base, value: -2 });
    await agent.flush();
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(6);
    warn.mockRestore();
  });

  test('4xx other than 408/429 is not retried', async () => {
    let n = 0;
    const fetchImpl = (async () => { n++; return new Response('{}', { status: 400 }); }) as unknown as typeof fetch;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
    const agent = new AforoAgent(baseConfig({ fetchImpl, retryBaseDelayMs: 1 }));
    await (await agent.startSession({ agentId: 'a' })).end({ taskCompleted: true });
    expect(n).toBe(1);
    warn.mockRestore();
  });

  test('429 is retried honouring Retry-After, re-sending the same keys', async () => {
    const bodies: string[] = [];
    const responses = [
      new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }),
      new Response('{"accepted":1,"duplicates":0,"failed":0,"errors":[]}', { status: 202 }),
    ];
    const fetchImpl = (async (_u: any, init: any) => { bodies.push(init.body); return responses.shift()!; }) as unknown as typeof fetch;
    const agent = new AforoAgent(baseConfig({ fetchImpl, retryBaseDelayMs: 60_000 }));
    await agent.emitEvent({ eventType: 'e', metricKey: 'm', value: 1, agentId: 'a', sessionId: 's', properties: {} });
    await agent.flush(); // would hang ~60s if Retry-After: 0 were ignored
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('per-event rejections are reported from errors[].message', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ accepted: 0, duplicates: 0, failed: 1, errors: [{ index: 0, message: 'unknown metric' }] }),
      { status: 202 })) as unknown as typeof fetch;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    await (await agent.startSession({ agentId: 'a' })).end({ taskCompleted: true });
    expect(warn.mock.calls[0][0]).toContain('#0: unknown metric');
    warn.mockRestore();
  });
});

describe('AgentSession — type exports', () => {
  test('AgentSession class is exported', () => {
    expect(AgentSession).toBeDefined();
  });
  test('default export is AforoAgent', async () => {
    const Default = (await import('./index')).default;
    expect(Default).toBe(AforoAgent);
  });
});
