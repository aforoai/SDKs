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
    expect(events[0].eventType).toBe('agent_session_start');
    expect(events[0].agentId).toBe('agt_001');
    expect(events[0].sessionId).toBe(session.sessionId);
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

    const events = (calls[0].body as any).events;
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

  test('session.recordStep without tokens emits only one event', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordStep({ stepKind: 'THOUGHT' });
    await agent.flush();
    const events = (calls[0].body as any).events;
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
    const steps = (calls[0].body as any).events.filter((e: any) => e.eventType === 'agent_step');
    expect(steps.map((s: any) => s.properties.stepIndex)).toEqual([1, 2, 3]);
  });

  test('session.recordToolCall is a thin wrapper over recordStep', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.recordToolCall('web-search', { inputTokens: 50, outputTokens: 25 });
    await agent.flush();
    const step = (calls[0].body as any).events.find((e: any) => e.eventType === 'agent_step');
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
    // session.end must flush — no manual flush
    expect(calls).toHaveLength(1);
    const endEvt = (calls[0].body as any).events.find((e: any) => e.eventType === 'agent_session_end');
    expect(endEvt.properties.taskCompleted).toBe(true);
    expect(endEvt.properties.stepCount).toBe(2);
  });

  test('session.end propagates errorMessage on failure', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    const session = await agent.startSession({ agentId: 'agt_001' });
    await session.end({ taskCompleted: false, errorMessage: 'rate limited' });
    const endEvt = (calls[0].body as any).events.find((e: any) => e.eventType === 'agent_session_end');
    expect(endEvt.properties.taskCompleted).toBe(false);
    expect(endEvt.properties.errorMessage).toBe('rate limited');
  });
});

describe('AforoAgent — batching + flush', () => {
  test('batch flushes when buffer reaches flushBatchSize', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent({
      tenantId: 't', productId: 'p', apiKey: 'k', fetchImpl,
      flushBatchSize: 3, flushIntervalMs: 9_999_999,
    });
    const session = await agent.startSession({ agentId: 'agt_001' }); // 1 event
    await session.recordStep({ stepKind: 'THOUGHT' }); // 1 event → total 2
    await session.recordStep({ stepKind: 'THOUGHT' }); // 1 event → total 3 → flush
    expect(calls).toHaveLength(1);
    expect((calls[0].body as any).events).toHaveLength(3);
  });

  test('headers carry tenantId + Bearer apiKey', async () => {
    const { calls, fetchImpl } = makeFetch();
    const agent = new AforoAgent(baseConfig({ fetchImpl }));
    await (await agent.startSession({ agentId: 'a' })).end({ taskCompleted: true });
    const headers = calls[0].headers;
    expect(headers['Authorization']).toBe('Bearer sk_test_abcdef');
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
    const agent = new AforoAgent(baseConfig({ fetchImpl: failingFetch }));
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
