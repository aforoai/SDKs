/**
 * Tests for {@link AforoAgent} — the AI Agent Metering SDK.
 *
 * Approach: pluggable {@code fetchImpl} captures every outbound POST so we
 * can assert on event payload shape, batching cadence, and session lifecycle
 * markers without standing up a mock HTTP server.
 *
 * Wire contract: ONE Apigee-format event per POST to <ingestorUrl>/events
 * (agentId/sessionId/productId ride in properties; idempotencyKey stamped
 * at creation).
 */
import { AforoAgent, AgentSession, EXECUTION_STATUSES, ExecutionStatus } from './index';

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

const eventsOf = (calls: CapturedRequest[]) => calls.map((c) => c.body as any);

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
    expect(calls).toHaveLength(1); // one Apigee-format event per POST
    expect(calls[0].url).toContain('/events');
    const events = eventsOf(calls);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('agent_session_start');
    expect(events[0].idempotencyKey).toMatch(/^agent:/);
    expect(events[0].properties.agentId).toBe('agt_001');
    expect(events[0].properties.sessionId).toBe(session.sessionId);
    expect(events[0].properties.framework).toBe('CLAUDE');
    expect(events[0].properties.modelProvider).toBe('ANTHROPIC');
    expect(events[0].properties.modelName).toBe('claude-sonnet-4-6');
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

    const events = eventsOf(calls);
    // session_start + agent_step + token_usage = 3
    expect(events).toHaveLength(3);
    const step = events.find((e: any) => e.eventType === 'agent_step');
    expect(step.properties.stepIndex).toBe(1);
    expect(step.properties.capabilityName).toBe('web-search');
    expect(step.properties.executionStatus).toBe('SUCCESS');
    const tokens = events.find((e: any) => e.eventType === 'token_usage');
    expect(tokens.value).toBe(150);
    expect(tokens.properties.inputTokens).toBe(100);
    expect(tokens.properties.outputTokens).toBe(50);
  });

  test('recordStep accepts every canonical execution status (P6 item 13)', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_status' });
    // PARTIAL / FAILED / VALIDATION_FAILED / FAILURE / PENDING / BLOCKED did
    // not compile before 2026-09-30 (the type listed only 5 values).
    const statuses: ExecutionStatus[] = [...EXECUTION_STATUSES];
    for (const executionStatus of statuses) {
      await session.recordStep({ stepKind: 'TOOL_CALL', capabilityName: 'c', executionStatus });
    }
    await agent.flush();
    const sent = eventsOf(calls)
      .filter((e: any) => e.eventType === 'agent_step')
      .map((e: any) => e.properties.executionStatus);
    expect(sent).toEqual(statuses);
  });

  test('recordStep normalizes case, drops unknown statuses, and metadata cannot override it', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, fetchImpl } = makeFetch();
      const agent = new AforoAgent(baseConfig({ fetchImpl }));
      const session = await agent.startSession({ agentId: 'agt_norm' });
      await session.recordStep({ stepKind: 'TOOL_CALL', executionStatus: ' partial ' as any });
      await session.recordStep({ stepKind: 'TOOL_CALL', executionStatus: 'PENDNG' as any });
      await session.recordStep({
        stepKind: 'TOOL_CALL', executionStatus: 'ERROR', metadata: { executionStatus: 'SUCCESS' },
      });
      await agent.flush();
      const steps = eventsOf(calls).filter((e: any) => e.eventType === 'agent_step');
      expect(steps[0].properties.executionStatus).toBe('PARTIAL');
      expect('executionStatus' in steps[1].properties).toBe(false);
      expect(steps[2].properties.executionStatus).toBe('ERROR');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('PENDNG'));
    } finally {
      warn.mockRestore();
    }
  });

  test('recordStep without a status still defaults to SUCCESS', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_default' });
    await session.recordStep({ stepKind: 'THOUGHT' });
    await agent.flush();
    const step = eventsOf(calls).find((e: any) => e.eventType === 'agent_step');
    expect(step.properties.executionStatus).toBe('SUCCESS');
  });

  test('session.recordStep without tokens emits only one event', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({ stepKind: 'THOUGHT' });
    await agent.flush();
    const events = eventsOf(calls);
    expect(events.filter((e: any) => e.eventType === 'token_usage')).toHaveLength(0);
  });

  test('session.recordStep increments stepIndex monotonically', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({ stepKind: 'THOUGHT' });
    await session.recordStep({ stepKind: 'TOOL_CALL', capabilityName: 't' });
    await session.recordStep({ stepKind: 'OBSERVATION' });
    await agent.flush();
    const steps = eventsOf(calls).filter((e: any) => e.eventType === 'agent_step');
    expect(steps.map((s: any) => s.properties.stepIndex)).toEqual([1, 2, 3]);
  });

  test('session.recordToolCall is a thin wrapper over recordStep', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordToolCall('web-search', { inputTokens: 50, outputTokens: 25 });
    await agent.flush();
    const step = eventsOf(calls).find((e: any) => e.eventType === 'agent_step');
    expect(step.properties.stepKind).toBe('TOOL_CALL');
    expect(step.properties.capabilityName).toBe('web-search');
  });

  test('session.end records taskCompleted + step count + forces flush', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({ stepKind: 'TOOL_CALL', capabilityName: 't' });
    await session.recordStep({ stepKind: 'TOOL_CALL', capabilityName: 't2' });
    await session.end({ taskCompleted: true });
    // session.end must flush — no manual flush (4 events → 4 single-event POSTs)
    expect(calls).toHaveLength(4);
    const endEvt = eventsOf(calls).find((e: any) => e.eventType === 'agent_session_end');
    expect(endEvt.properties.taskCompleted).toBe(true);
    expect(endEvt.properties.stepCount).toBe(2);
  });

  test('session.end propagates errorMessage on failure', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.end({ taskCompleted: false, errorMessage: 'rate limited' });
    const endEvt = eventsOf(calls).find((e: any) => e.eventType === 'agent_session_end');
    expect(endEvt.properties.taskCompleted).toBe(false);
    expect(endEvt.properties.errorMessage).toBe('rate limited');
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
    expect(calls).toHaveLength(3); // one POST per event
    expect(eventsOf(calls).map((e: any) => e.eventType)).toEqual([
      'agent_session_start', 'agent_step', 'agent_step',
    ]);
  });

  test('headers carry tenantId + X-API-Key, and no Authorization', async () => {
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
    const agent = new AforoAgent(baseConfig({ fetchImpl: failingFetch, maxRetries: 1 }));
    await (await agent.startSession({ agentId: 'a' })).end({ taskCompleted: true });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('503');
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

// ────────────────────────────────────────────────────────────────
// G11 (2026-07-11): top-level capabilityName emission.
// Locks the Node SDK wire contract:
//   - agent_step with capabilityName → payload.capabilityName present at TOP-LEVEL
//     AND inside properties (backward-compat for older servers reading metadata)
//   - agent_step without capabilityName → NO top-level capabilityName key emitted
//     (avoid emitting {capabilityName: undefined} which JSON-stringifies to nothing
//     but is defensive against future consumers that might .hasOwnProperty check)
//   - session-lifecycle events (start/end) → NO top-level capabilityName
//   - recordToolCall passes the tool name through as capabilityName
// ────────────────────────────────────────────────────────────────
describe('AforoAgent — G11 top-level capabilityName wire emission', () => {
  test('recordStep with capabilityName → top-level capabilityName in payload', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({
      stepKind: 'TOOL_CALL',
      capabilityName: 'summarize_email',
      executionStatus: 'SUCCESS',
    });
    await agent.flush();

    const step = eventsOf(calls).find((e: any) => e.eventType === 'agent_step');
    expect(step).toBeDefined();
    // Top-level: matches ApigeeEventRequest.capabilityName → resolves in the
    // server's extractor precedence chain (top-level wins over metadata).
    expect(step.capabilityName).toBe('summarize_email');
    // Backward-compat: still in properties for servers that only read metadata.
    expect(step.properties.capabilityName).toBe('summarize_email');
  });

  test('recordStep without capabilityName → no top-level capabilityName key', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({ stepKind: 'THOUGHT' });
    await agent.flush();

    const step = eventsOf(calls).find((e: any) => e.eventType === 'agent_step');
    expect(step).toBeDefined();
    // No top-level capabilityName emitted for capability-less steps.
    expect(step.capabilityName).toBeUndefined();
  });

  test('recordToolCall stamps top-level capabilityName from tool name', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordToolCall('web_search', { inputTokens: 25 });
    await agent.flush();

    const step = eventsOf(calls).find((e: any) => e.eventType === 'agent_step');
    expect(step.capabilityName).toBe('web_search');
    expect(step.properties.capabilityName).toBe('web_search');
  });

  test('session_start / session_end events do NOT carry top-level capabilityName', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.end({ taskCompleted: true });

    const events = eventsOf(calls);
    const start = events.find((e: any) => e.eventType === 'agent_session_start');
    const end = events.find((e: any) => e.eventType === 'agent_session_end');
    expect(start.capabilityName).toBeUndefined();
    expect(end.capabilityName).toBeUndefined();
  });

  test('recordStep with whitespace-only capabilityName → no top-level key (parity with server)', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({ stepKind: 'TOOL_CALL', capabilityName: '   ' });
    await agent.flush();

    const step = eventsOf(calls).find((e: any) => e.eventType === 'agent_step');
    // Server-side extractor treats whitespace-only as absent (see the Gap 5 precedent
    // in ProductTypeEventExtractor.inferProductType and the G11 blank-top-level test).
    // Matching that here so the wire doesn't send noise the server would reject.
    expect(step.capabilityName).toBeUndefined();
  });
});

describe('AforoAgent — customerId, productType and endpoint', () => {
  test('customerId is sent top-level: config default, per-session and per-event override', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    await agent.startSession({ agentId: 'agt_001' });
    await agent.startSession({ agentId: 'agt_001', customerId: 'cust_session' });
    await agent.emitEvent({
      eventType: 'agent_step', metricKey: 'step_count', value: 1,
      agentId: 'agt_001', sessionId: 's', customerId: 'cust_event', properties: {},
    });
    await agent.flush();
    expect(eventsOf(calls).map((e: any) => e.customerId)).toEqual(['cust_test', 'cust_session', 'cust_event']);
  });

  test('productType defaults to AI_AGENT; client, session and event overrides are trimmed and upper-cased', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001', productType: ' agentic_api ' });
    await session.recordStep({ stepKind: 'THOUGHT' });
    await agent.emitEvent({
      eventType: 'agent_step', metricKey: 'step_count', value: 1,
      agentId: 'agt_001', sessionId: 's', properties: {},
    });
    await agent.flush();
    const events = eventsOf(calls);
    expect(events.map((e: any) => e.productType)).toEqual(['AGENTIC_API', 'AGENTIC_API', 'AI_AGENT']);
    expect(events[2].properties.productType).toBe('AI_AGENT');

    const other = makeFetch();
    const agent2 = new AforoAgent(baseConfig({ fetchImpl: other.fetchImpl, productType: 'mcp_server' }));
    await agent2.startSession({ agentId: 'agt_001' });
    await agent2.flush();
    expect(eventsOf(other.calls)[0].productType).toBe('MCP_SERVER');
  });

  test('traceId rides in properties only when the caller supplies one', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    await agent.startSession({ agentId: 'agt_001', traceId: 'trace_abc' });
    await agent.startSession({ agentId: 'agt_001' });
    await agent.flush();
    const events = eventsOf(calls);
    expect(events[0].properties.traceId).toBe('trace_abc');
    expect('traceId' in events[1].properties).toBe(false);
  });

  test.each([
    [undefined, 'https://api.aforo.ai/v1/ingest/events'],
    ['https://api.aforo.ai', 'https://api.aforo.ai/v1/ingest/events'],
    ['http://localhost:8084/', 'http://localhost:8084/v1/ingest/events'],
    ['https://api.aforo.ai/v1/ingest', 'https://api.aforo.ai/v1/ingest/events'],
    ['https://api.aforo.ai/v1/ingest/', 'https://api.aforo.ai/v1/ingest/events'],
    ['https://api.aforo.ai/v1/ingest/events', 'https://api.aforo.ai/v1/ingest/events'],
    ['https://api.aforo.ai/v1/ingest/batch', 'https://api.aforo.ai/v1/ingest/events'],
    ['https://proxy.internal/aforo/v1/ingest', 'https://proxy.internal/aforo/v1/ingest/events'],
  ])('ingestorUrl %s posts to %s', async (ingestorUrl, expected) => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl, ingestorUrl }));
    await agent.startSession({ agentId: 'agt_001' });
    await agent.flush();
    expect(calls[0].url).toBe(expected);
  });
});

describe('AforoAgent — invalid events are dropped, never thrown', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ }); });
  afterEach(() => warn.mockRestore());

  const step = (over: Record<string, unknown> = {}) => ({
    eventType: 'agent_step', metricKey: 'step_count', value: 1,
    agentId: 'agt_001', sessionId: 'sess_1', properties: {}, ...over,
  }) as any;

  test.each([
    ['blank metricKey', step({ metricKey: ' ' }), /metricKey is required/],
    ['blank agentId', step({ agentId: '' }), /agentId is required/],
    ['agentId over 36 chars', step({ agentId: 'a'.repeat(37) }), /agentId .* exceeds 36/],
    ['blank sessionId', step({ sessionId: '  ' }), /sessionId is required/],
    ['sessionId over 64 chars', step({ sessionId: 's'.repeat(65) }), /sessionId .* exceeds 64/],
    ['zero value', step({ value: 0 }), /value must be a number > 0/],
    ['negative value', step({ value: -3 }), /value must be a number > 0/],
    ['customerId over 64 chars', step({ customerId: 'c'.repeat(65) }), /customerId .* exceeds 64/],
    ['capabilityName over 64 chars', step({ capabilityName: 'x'.repeat(65) }), /capabilityName .* exceeds 64/],
  ])('%s → dropped as invalid', async (_name, event, message) => {
    const { calls, fetchImpl } = makeFetch();
    const drops: Array<{ events: any[]; reason: string }> = [];
    const agent = new AforoAgent(baseConfig({ fetchImpl, onDrop: (events, reason) => drops.push({ events, reason }) }));
    await expect(agent.emitEvent(event)).resolves.toBeUndefined();
    await agent.flush();

    expect(calls).toHaveLength(0);
    expect(agent.droppedCount).toBe(1);
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('invalid');
    expect(drops[0].events[0].idempotencyKey).toMatch(/^agent:/);
    expect(String(warn.mock.calls[0][0])).toMatch(message);
  });

  test('values exactly at the limits are sent, untruncated', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    await agent.emitEvent(step({
      agentId: 'a'.repeat(36), sessionId: 's'.repeat(64), customerId: 'c'.repeat(64), capabilityName: 'x'.repeat(64),
    }));
    await agent.flush();
    expect(agent.droppedCount).toBe(0);
    expect(eventsOf(calls)[0].capabilityName).toHaveLength(64);
  });

  test('no customerId anywhere: startSession does not throw; the session\'s events are dropped as invalid', async () => {
    const { calls, fetchImpl } = makeFetch();
    const onDrop = jest.fn();
    const agent = new AforoAgent({
      tenantId: 't', productId: 'p', apiKey: 'k', fetchImpl, onDrop,
      flushBatchSize: 100, flushIntervalMs: 9_999_999,
    });
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({ stepKind: 'THOUGHT' });
    await session.end({ taskCompleted: true });

    expect(calls).toHaveLength(0);
    expect(agent.droppedCount).toBe(3);
    expect(onDrop).toHaveBeenCalledTimes(3);
    expect(onDrop.mock.calls.every((c) => c[1] === 'invalid')).toBe(true);
    // Throttled: first invalid event logged, the rest not.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('customerId is required');
  });

  test('an invalid event does not disturb valid ones', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    await agent.emitEvent(step({ sessionId: 'ok_1' }));
    await agent.emitEvent(step({ value: 0 }));
    await agent.emitEvent(step({ sessionId: 'ok_2' }));
    await agent.flush();
    expect(eventsOf(calls).map((e: any) => e.properties.sessionId)).toEqual(['ok_1', 'ok_2']);
    expect(agent.droppedCount).toBe(1);
  });
});

describe('AforoAgent — retries', () => {
  const sequence = (...statuses: Array<number | Error>) => {
    const bodies: string[] = [];
    let i = 0;
    const fetchImpl = (async (_url: any, init: any) => {
      bodies.push(init.body as string);
      const next = statuses[Math.min(i++, statuses.length - 1)];
      if (next instanceof Error) throw next;
      return {
        ok: next >= 200 && next < 300, status: next,
        headers: { get: (k: string) => (k === 'Retry-After' ? '0' : null) },
        json: async () => ({ errors: [{ index: 0, message: 'customerId is required' }] }),
      };
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  };
  const one = (agent: AforoAgent) => agent.emitEvent({
    eventType: 'agent_step', metricKey: 'step_count', value: 1, agentId: 'a', sessionId: 's', properties: {},
  });
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ }); });
  afterEach(() => warn.mockRestore());

  test('retries 5xx, 429 and network errors with the same body and idempotency key', async () => {
    const { bodies, fetchImpl } = sequence(503, 429, new Error('ECONNRESET'), 202);
    const agent = new AforoAgent(baseConfig({ fetchImpl, maxRetries: 4, retryBaseDelayMs: 0 }));
    await one(agent);
    await agent.flush();
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies).size).toBe(1);
    expect(agent.droppedCount).toBe(0);
  });

  test('does not retry a non-retryable 4xx; drops as rejected with the server message', async () => {
    const { bodies, fetchImpl } = sequence(422);
    const onDrop = jest.fn();
    const agent = new AforoAgent(baseConfig({ fetchImpl, retryBaseDelayMs: 0, onDrop }));
    await one(agent);
    await agent.flush();
    expect(bodies).toHaveLength(1);
    expect(onDrop).toHaveBeenCalledWith(expect.any(Array), 'rejected');
    expect(String(warn.mock.calls[0][0])).toContain('422 (customerId is required)');
  });

  test('drops as retry_exhausted after maxRetries attempts', async () => {
    const { bodies, fetchImpl } = sequence(500);
    const onDrop = jest.fn();
    const agent = new AforoAgent(baseConfig({ fetchImpl, maxRetries: 3, retryBaseDelayMs: 0, onDrop }));
    await one(agent);
    await agent.flush();
    expect(bodies).toHaveLength(3);
    expect(onDrop).toHaveBeenCalledWith(expect.any(Array), 'retry_exhausted');
    expect(agent.droppedCount).toBe(1);
  });
});
