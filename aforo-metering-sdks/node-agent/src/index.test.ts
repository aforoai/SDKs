/**
 * Tests for {@link AforoAgent} with a scripted, mocked fetch — no network.
 * Wire contract: POST <endpoint>/v1/ingest/batch, body {"events":[IngestUsageEventRequest…]},
 * header X-API-Key, response 202 {success, data:{accepted, duplicates, failed, errors[]}}.
 */
import AforoAgent, {
  AforoAgentConfig,
  AforoAgentError,
  AgentSession,
  DEFAULT_METRIC_NAMES,
  EXECUTION_STATUSES,
  resolveEndpoint,
} from './index';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { events: any[] };
}

/** fetch mock that answers from a script; once the script is used up it answers 202 accepted-all. */
function mockFetch(script: Reply[] = []) {
  const calls: Call[] = [];
  const fetchImpl = jest.fn(async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), headers: init.headers, body });
    const next = script.shift();
    if (next instanceof Error) throw next;
    const reply = next ?? {
      status: 202,
      body: { success: true, data: { accepted: body.events.length, duplicates: 0, failed: 0, errors: [] } },
    };
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch, mock: fetchImpl };
}

function client(fetchImpl: typeof fetch, override: Partial<AforoAgentConfig> = {}) {
  const errors: AforoAgentError[] = [];
  const agent = new AforoAgent({
    apiKey: 'sk_test_key',
    customerId: 'cust_123',
    agentId: 'support-bot',
    productId: 'prod_9',
    fetchImpl,
    flushIntervalMs: 60_000,
    retryBaseDelayMs: 1,
    onError: (e) => errors.push(e),
    ...override,
  });
  return { agent, errors };
}

const events = (calls: Call[]) => calls.flatMap((c) => c.body.events);

describe('config', () => {
  test('apiKey is required; tenantId / productId are not', () => {
    expect(() => new AforoAgent({ apiKey: '' } as any)).toThrow('apiKey is required');
    expect(() => new AforoAgent({ apiKey: 'k', fetchImpl: mockFetch().fetchImpl })).not.toThrow();
  });

  test('endpoint resolution: default, bare host, /v1/ingest, legacy /events, full batch URL', () => {
    expect(resolveEndpoint()).toBe('https://api.aforo.ai/v1/ingest/batch');
    expect(resolveEndpoint('http://localhost:8084')).toBe('http://localhost:8084/v1/ingest/batch');
    expect(resolveEndpoint('https://api.aforo.ai/v1/ingest/')).toBe('https://api.aforo.ai/v1/ingest/batch');
    expect(resolveEndpoint('https://api.aforo.ai/v1/ingest/events')).toBe('https://api.aforo.ai/v1/ingest/batch');
    expect(resolveEndpoint('https://x.test/api/v1/ingest/batch')).toBe('https://x.test/api/v1/ingest/batch');
  });

  test('deprecated ingestorUrl still works', () => {
    const { agent } = client(mockFetch().fetchImpl, { ingestorUrl: 'http://localhost:8084/v1/ingest' });
    expect(agent.endpoint).toBe('http://localhost:8084/v1/ingest/batch');
  });

  test('default metric names are the AI_AGENT catalog names', () => {
    expect(DEFAULT_METRIC_NAMES).toEqual({
      sessions: 'Agent Sessions',
      steps: 'Agent Steps',
      toolCalls: 'Agent Tool Calls',
      tokens: 'Tokens Consumed',
      executionMinutes: 'Execution Minutes',
      gpuHours: 'GPU Hours',
      knowledgeQueries: 'Knowledge Queries',
      tasksCompleted: 'Tasks Completed',
      activeAgents: 'Active Agents',
    });
  });
});

describe('wire request', () => {
  test('one POST to /v1/ingest/batch with X-API-Key and no Authorization', async () => {
    const { calls, fetchImpl } = mockFetch();
    const { agent, errors } = client(fetchImpl);
    const s = agent.startSession();
    await s.recordStep({ stepKind: 'THOUGHT' });
    await s.end({ taskCompleted: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.aforo.ai/v1/ingest/batch');
    expect(calls[0].headers['X-API-Key']).toBe('sk_test_key');
    expect(calls[0].headers['Authorization']).toBeUndefined();
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(Array.isArray(calls[0].body.events)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('event body matches the ingestor contract', async () => {
    const { calls, fetchImpl } = mockFetch();
    const { agent } = client(fetchImpl, { subscriptionId: 'sub_1' });
    const s = agent.startSession({
      sessionId: 'sess-1',
      framework: 'CLAUDE',
      modelProvider: 'ANTHROPIC',
      modelName: 'claude-sonnet-4-6',
    });
    await s.recordToolCall('web_search', { inputTokens: 320, outputTokens: 84, durationMs: 510.4 });
    await s.end({ taskCompleted: true });

    const evs = events(calls);
    expect(evs.map((e) => e.metricName)).toEqual([
      'Agent Steps',
      'Agent Tool Calls',
      'Tokens Consumed',
      'Tasks Completed',
      'Agent Sessions',
    ]);
    const tool = evs[1];
    expect(tool).toMatchObject({
      customerId: 'cust_123',
      metricName: 'Agent Tool Calls',
      quantity: 1,
      idempotencyKey: 'sess-1:2',
      productType: 'AI_AGENT',
      agentId: 'support-bot',
      sessionId: 'sess-1',
      subscriptionId: 'sub_1',
      capabilityName: 'web_search',
      executionStatus: 'SUCCESS',
      executionDurationMs: 510,
      stepNumber: 1,
    });
    expect(tool.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(new Date(tool.occurredAt).toISOString()).toBe(tool.occurredAt);
    expect(tool.metadata).toMatchObject({ framework: 'CLAUDE', productId: 'prod_9' });
    expect(tool.sessionBoundary).toBeUndefined();

    const tokens = evs[2];
    expect(tokens.quantity).toBe(404);
    expect(tokens.metadata).toMatchObject({
      model_provider: 'ANTHROPIC',
      model_name: 'claude-sonnet-4-6',
      input_tokens: 320,
      output_tokens: 84,
      productId: 'prod_9',
    });

    // SESSION_END only on the closing event.
    expect(evs.filter((e) => e.sessionBoundary)).toHaveLength(1);
    expect(evs[evs.length - 1].sessionBoundary).toBe('SESSION_END');
    // one traceId per session
    expect(new Set(evs.map((e) => e.traceId)).size).toBe(1);
    // no legacy Apigee fields
    expect(tool.eventType).toBeUndefined();
    expect(tool.metricKey).toBeUndefined();
    expect(tool.value).toBeUndefined();
  });

  test('idempotency keys are deterministic: <sessionId>:<counter>, unique per event', async () => {
    const { calls, fetchImpl } = mockFetch();
    const { agent } = client(fetchImpl);
    const s = agent.startSession({ sessionId: 'run-42' });
    await s.recordStep({ stepKind: 'THOUGHT' });
    await s.recordTokens('gpt-4o', 10, 5, { provider: 'OPENAI' });
    await s.recordUsage('knowledgeQueries', 2);
    await s.endSession({});
    const keys = events(calls).map((e) => e.idempotencyKey);
    expect(keys).toEqual(['run-42:1', 'run-42:2', 'run-42:3', 'run-42:4']);
    expect(events(calls)[2].metricName).toBe('Knowledge Queries');
  });

  test('a generated sessionId is a UUID and two sessions get different traceIds', () => {
    const { agent } = client(mockFetch().fetchImpl);
    const a = agent.startSession();
    const b = agent.startSession();
    expect(a.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a).toBeInstanceOf(AgentSession);
  });

  test('metric names are configurable', async () => {
    const { calls, fetchImpl } = mockFetch();
    const { agent } = client(fetchImpl, { metricNames: { steps: 'steps_v2', tokens: 'llm_tokens' } });
    const s = agent.startSession();
    await s.recordStep({ inputTokens: 1, outputTokens: 1 });
    await s.end({});
    expect(events(calls).map((e) => e.metricName)).toEqual(['steps_v2', 'llm_tokens', 'Agent Sessions']);
  });

  test('zero quantities are skipped, not sent', async () => {
    const { calls, fetchImpl } = mockFetch();
    const { agent, errors } = client(fetchImpl);
    const s = agent.startSession();
    await s.recordTokens('m', 0, 0);
    await s.recordUsage('gpuHours', 0);
    await s.end({ executionMinutes: 0 });
    expect(events(calls).map((e) => e.metricName)).toEqual(['Agent Sessions']);
    expect(errors).toEqual([]);
  });

  test('maxBatchSize splits into several requests (≤ 1000 each)', async () => {
    const { calls, fetchImpl } = mockFetch();
    const { agent } = client(fetchImpl, { maxBatchSize: 5000 });
    const s = agent.startSession();
    for (let i = 0; i < 1500; i++) s.recordUsage('gpuHours', 1);
    await agent.flush();
    expect(calls.map((c) => c.body.events.length)).toEqual([1000, 500]);
  });

  test('executionStatus is normalised; unknown values are left off', async () => {
    const { calls, fetchImpl } = mockFetch();
    const { agent } = client(fetchImpl, { logger: null });
    const s = agent.startSession();
    await s.recordStep({ executionStatus: ' timeout ' });
    await s.recordStep({ executionStatus: 'NOPE' });
    await agent.flush();
    const evs = events(calls);
    expect(evs[0].executionStatus).toBe('TIMEOUT');
    expect(evs[1].executionStatus).toBeUndefined();
    expect(EXECUTION_STATUSES).toContain('HITL_REQUIRED');
  });
});

describe('delivery', () => {
  test('retries a 503 and then succeeds with the identical body', async () => {
    const { calls, fetchImpl } = mockFetch([{ status: 503, body: { message: 'unavailable' } }]);
    const { agent, errors } = client(fetchImpl);
    const s = agent.startSession();
    await s.recordStep({});
    const result = await agent.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual(calls[0].body);
    expect(result).toMatchObject({ accepted: 1, failed: 0, pending: 0 });
    expect(errors).toEqual([]);
  });

  test('honours Retry-After on 429', async () => {
    const { calls, fetchImpl } = mockFetch([{ status: 429, headers: { 'Retry-After': '0' } }]);
    const { agent } = client(fetchImpl);
    agent.startSession().recordStep({});
    const result = await agent.flush();
    expect(calls).toHaveLength(2);
    expect(result.accepted).toBe(1);
  });

  test('network errors keep events buffered; the next flush delivers them with the same keys', async () => {
    const down = new TypeError('fetch failed');
    const { calls, fetchImpl } = mockFetch([down, down, down]);
    const { agent, errors } = client(fetchImpl, { maxRetries: 3 });
    const s = agent.startSession({ sessionId: 's' });
    await s.recordStep({});
    await s.recordStep({});

    const first = await agent.flush();
    expect(calls).toHaveLength(3);
    expect(first).toMatchObject({ accepted: 0, failed: 0, pending: 2 });
    expect(agent.pendingCount).toBe(2);
    expect(agent.droppedCount).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: 'retrying', willRetry: true });
    expect(errors[0].message).toContain('fetch failed');

    const second = await agent.flush();
    expect(second).toMatchObject({ accepted: 2, pending: 0 });
    expect(calls[3].body.events.map((e: any) => e.idempotencyKey)).toEqual(['s:1', 's:2']);
  });

  test('202 with per-event errors drops only the named events, reported as rejected', async () => {
    const { fetchImpl } = mockFetch([
      {
        status: 202,
        body: {
          success: true,
          data: { accepted: 1, duplicates: 0, failed: 1, errors: [{ index: 1, message: 'agent_id is required for AI_AGENT events' }] },
        },
      },
    ]);
    const { agent, errors } = client(fetchImpl);
    const s = agent.startSession({ sessionId: 'p' });
    await s.recordStep({});
    await s.recordStep({});
    const result = await agent.flush();
    expect(result).toMatchObject({ accepted: 1, failed: 1, pending: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('rejected');
    expect(errors[0].message).toContain('agent_id is required for AI_AGENT events');
    expect(errors[0].events.map((e) => e.idempotencyKey)).toEqual(['p:2']);
    expect(agent.droppedCount).toBe(1);
  });

  test('a per-event retryable error re-sends that event with its key', async () => {
    const { calls, fetchImpl } = mockFetch([
      { status: 202, body: { success: true, data: { accepted: 1, duplicates: 0, failed: 1, errors: [{ index: 0, message: 'busy', retryable: true }] } } },
    ]);
    const { agent, errors } = client(fetchImpl);
    const s = agent.startSession({ sessionId: 'rt' });
    await s.recordStep({});
    await s.recordStep({});
    expect(await agent.flush()).toMatchObject({ accepted: 1, requeued: 1 });
    await agent.flush();
    expect(calls[1].body.events.map((e: any) => e.idempotencyKey)).toEqual(['rt:1']);
    expect(errors).toEqual([]);
    expect(agent.droppedCount).toBe(0);
  });

  test('duplicates are counted as accepted', async () => {
    const { fetchImpl } = mockFetch([{ status: 202, body: { success: true, data: { accepted: 0, duplicates: 1, failed: 0, errors: [] } } }]);
    const { agent, errors } = client(fetchImpl);
    agent.startSession().recordStep({});
    expect(await agent.flush()).toMatchObject({ accepted: 1, failed: 0 });
    expect(errors).toEqual([]);
  });

  test('401 is an outage, not a drop: the events wait for a valid key', async () => {
    const { calls, fetchImpl } = mockFetch([{ status: 401, body: { message: 'Invalid API key' } }]);
    const { agent, errors } = client(fetchImpl, { logger: null });
    agent.startSession().recordStep({});
    const first = await agent.flush();
    expect(calls).toHaveLength(1);
    expect(first).toMatchObject({ accepted: 0, failed: 0, pending: 1 });
    expect(errors[0]).toMatchObject({ kind: 'retrying', willRetry: true });
    expect(errors[0].message).toContain('HTTP 401');
    expect(await agent.flush()).toMatchObject({ accepted: 1, pending: 0 });
  });

  test('a non-retryable 4xx is not retried, drops the batch and reports the server message', async () => {
    const { calls, fetchImpl } = mockFetch([{ status: 400, body: { message: 'Invalid API key' } }]);
    const onDrop = jest.fn();
    const { agent, errors } = client(fetchImpl, { onDrop });
    agent.startSession().recordStep({});
    const result = await agent.flush();
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ accepted: 0, failed: 1, pending: 0 });
    expect(errors[0]).toMatchObject({ kind: 'rejected', willRetry: false });
    expect(errors[0].message).toContain('HTTP 400');
    expect(errors[0].message).toContain('Invalid API key');
    expect(onDrop).toHaveBeenCalledWith(expect.any(Array), 'rejected');
  });

  test('the buffer is bounded: oldest events are dropped and reported', async () => {
    const { calls, fetchImpl } = mockFetch([new Error('down'), new Error('down')]);
    const { agent, errors } = client(fetchImpl, { maxBatchSize: 3, maxBufferSize: 3, maxRetries: 1 });
    const s = agent.startSession({ sessionId: 'b' });
    for (let i = 0; i < 3; i++) s.recordUsage('gpuHours', 1); // full batch → background flush fails
    await agent.flush(); // fails again; 3 kept
    expect(agent.pendingCount).toBe(3);
    s.recordUsage('gpuHours', 1); // 4th → evicts b:1
    const overflow = errors.find((e) => e.kind === 'overflow');
    expect(overflow?.events.map((e) => e.idempotencyKey)).toEqual(['b:1']);
    await agent.shutdown();
    expect(calls[calls.length - 1].body.events.map((e: any) => e.idempotencyKey)).toEqual(['b:2', 'b:3', 'b:4']);
    expect(agent.droppedCount).toBe(1);
  });

  test('missing customerId / agentId is reported as invalid and never sent', async () => {
    const { calls, fetchImpl } = mockFetch();
    const { agent, errors } = client(fetchImpl, { customerId: undefined, agentId: undefined });
    const s = agent.startSession();
    await s.recordStep({});
    await agent.flush();
    expect(calls).toHaveLength(0);
    expect(errors[0].kind).toBe('invalid');
    expect(errors[0].message).toContain('customerId');
    const t = agent.startSession({ customerId: 'c' });
    await t.recordStep({});
    expect(errors[1].message).toContain('agentId is required');
    expect(agent.droppedCount).toBe(2);
  });

  test('without onError, problems go to the logger', async () => {
    const warn = jest.fn();
    const { fetchImpl } = mockFetch([{ status: 400, body: { message: 'bad' } }]);
    const agent = new AforoAgent({ apiKey: 'k', customerId: 'c', agentId: 'a', fetchImpl, logger: { warn } });
    agent.startSession().recordStep({});
    await agent.flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rejected'));
  });

  test('a full batch triggers a background flush', async () => {
    const { calls, fetchImpl } = mockFetch();
    const { agent } = client(fetchImpl, { maxBatchSize: 2 });
    const s = agent.startSession();
    await s.recordStep({});
    expect(calls).toHaveLength(0);
    await s.recordStep({});
    await agent.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.events).toHaveLength(2);
  });

  test('legacy emitEvent maps metricKey/value onto metricName/quantity', async () => {
    const { calls, fetchImpl } = mockFetch();
    const { agent } = client(fetchImpl);
    await agent.emitEvent({ metricKey: 'Agent Steps', value: 3, sessionId: 'legacy', properties: { a: 1 } });
    await agent.emitEvent({ metricKey: 'Agent Steps', value: 0, sessionId: 'legacy' });
    await agent.flush();
    const evs = events(calls);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ metricName: 'Agent Steps', quantity: 3, sessionId: 'legacy', agentId: 'support-bot' });
    expect(evs[0].idempotencyKey).toMatch(/^legacy:/);
    expect(evs[0].metadata).toMatchObject({ a: 1 });
  });
});
