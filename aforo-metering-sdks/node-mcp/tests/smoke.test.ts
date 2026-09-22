import { AforoMcpBilling } from '../src/index';

const cfg = { tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://ingestor.example' };

describe('AforoMcpBilling (smoke)', () => {
  beforeEach(() => {
    // Stub the network so shutdown()'s final flush never makes a real request.
    (global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: 1, duplicates: 0, failed: 0 }),
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('requires the four core config fields', () => {
    expect(() => new AforoMcpBilling({ ...cfg, tenantId: '' })).toThrow(/tenantId/);
    expect(() => new AforoMcpBilling({ ...cfg, productId: '' })).toThrow(/productId/);
    expect(() => new AforoMcpBilling({ ...cfg, apiKey: '' })).toThrow(/apiKey/);
    expect(() => new AforoMcpBilling({ ...cfg, ingestorUrl: '' })).toThrow(/ingestorUrl/);
  });

  it('wraps a tool handler and passes the result through unchanged', async () => {
    const billing = new AforoMcpBilling(cfg);
    let calls = 0;
    const wrapped = billing.wrapToolHandler(async (_req: { params: { name: string } }) => {
      calls += 1;
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await wrapped({ params: { name: 'my_tool' } });

    expect(calls).toBe(1);
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });

    await billing.shutdown(); // flush (stubbed) + clear timers so jest exits clean
  });
});

const okFetch = (body: unknown = { accepted: 1, duplicates: 0, failed: 0 }) => jest.fn().mockResolvedValue({
  ok: true,
  status: 202,
  json: async () => body,
});
const bodiesOf = (fetchMock: jest.Mock) => fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body));

describe('AforoMcpBilling session heartbeats', () => {
  afterEach(() => jest.useRealTimers());

  it('sends each heartbeat in its own request, never inside the usage batch', async () => {
    const fetchMock = okFetch();
    (global as { fetch?: unknown }).fetch = fetchMock;

    const billing = new AforoMcpBilling(cfg);
    billing.startSession('sess_1', { customerId: 'cust_1' });
    const wrapped = billing.wrapToolHandler(async (_req: { params: { name: string; _meta?: Record<string, unknown> } }) => 'ok');
    await wrapped({ params: { name: 'search', _meta: { session_id: 'sess_1', agent_id: 'agent_1' } } });
    await billing.endSession();
    await billing.shutdown();

    const bodies = bodiesOf(fetchMock);
    for (const b of bodies) {
      const hbs = b.events.filter((e: any) => e.metricName === 'system.session.heartbeat');
      // A request either carries exactly one heartbeat and nothing else, or no heartbeat at all.
      if (hbs.length > 0) expect(b.events).toHaveLength(1);
    }
    const hbs = bodies.flatMap((b: any) => b.events).filter((e: any) => e.metricName === 'system.session.heartbeat');
    expect(hbs.map((e: any) => e.sessionBoundary)).toEqual(['HEARTBEAT', 'SESSION_END']);
    for (const hb of hbs) {
      expect(hb).toMatchObject({
        customerId: 'cust_1', quantity: 1, sessionId: 'sess_1', productType: 'MCP_SERVER',
      });
      expect(hb.metadata).toMatchObject({ sessionId: 'sess_1', productType: 'MCP_SERVER', sessionBoundary: hb.sessionBoundary });
      expect(new Date(hb.occurredAt).toISOString()).toBe(hb.occurredAt);
    }
    expect(hbs[0].idempotencyKey).not.toBe(hbs[1].idempotencyKey);
    const usage = bodies.flatMap((b: any) => b.events).filter((e: any) => e.metricName !== 'system.session.heartbeat');
    expect(usage).toHaveLength(1);
    expect(usage.every((e: any) => e.quantity > 0)).toBe(true);
  });

  it('starts heartbeats from the first tool call, falling back to "system" as heartbeat customer only when none is known', async () => {
    const fetchMock = okFetch();
    (global as { fetch?: unknown }).fetch = fetchMock;

    const billing = new AforoMcpBilling(cfg);
    const wrapped = billing.wrapToolHandler(async (_req: { params: { name: string; _meta?: Record<string, unknown> } }) => 'ok');
    await wrapped({ params: { name: 'search', _meta: { session_id: 'sess_2', customer_id: 'cust_meta' } } });
    await billing.shutdown();
    const hb = bodiesOf(fetchMock).flatMap((b: any) => b.events).find((e: any) => e.metricName === 'system.session.heartbeat');
    expect(hb).toMatchObject({ sessionId: 'sess_2', customerId: 'cust_meta', sessionBoundary: 'HEARTBEAT' });

    const f2 = okFetch();
    (global as { fetch?: unknown }).fetch = f2;
    const b2 = new AforoMcpBilling(cfg);
    b2.startSession('sess_3', { productType: 'agentic_api' });
    await b2.endSession();
    await b2.shutdown();
    const hbs = bodiesOf(f2).map((b: any) => b.events[0]);
    expect(hbs.every((e: any) => e.customerId === 'system' && e.productType === 'AGENTIC_API')).toBe(true);
  });

  it('sends periodic heartbeats on the interval, stops on shutdown, and honours heartbeatEnabled=false', async () => {
    jest.useFakeTimers();
    const fetchMock = okFetch();
    (global as { fetch?: unknown }).fetch = fetchMock;
    const billing = new AforoMcpBilling({ ...cfg, heartbeatIntervalMs: 1000, flushIntervalMs: 600_000 });
    billing.startSession('sess_p');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(3000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await billing.shutdown();
    jest.advanceTimersByTime(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const f2 = okFetch();
    (global as { fetch?: unknown }).fetch = f2;
    const off = new AforoMcpBilling({ ...cfg, heartbeatEnabled: false, flushIntervalMs: 600_000 });
    off.startSession('sess_off');
    jest.advanceTimersByTime(120_000);
    await off.shutdown();
    expect(f2).not.toHaveBeenCalled();
  });

  it('swallows heartbeat failures without retrying and without affecting usage delivery', async () => {
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ ok: true, status: 202, json: async () => ({ accepted: 1, duplicates: 0, failed: 0 }) });
    (global as { fetch?: unknown }).fetch = fetchMock;
    const onError = jest.fn();
    const billing = new AforoMcpBilling({ ...cfg, onError });
    billing.startSession('sess_f');
    await new Promise((r) => setImmediate(r));
    billing.recordToolInvocation('search', 'agent_1', 'sess_f', 'SUCCESS', 5);
    await billing.flush();
    await billing.shutdown();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('heartbeat') }));
    expect(fetchMock).toHaveBeenCalledTimes(2); // failed heartbeat (once) + the usage batch
    const usage = JSON.parse(fetchMock.mock.calls[1][1].body).events;
    expect(usage.map((e: any) => e.metricName)).toEqual(['mcp_server.tool_invocations']);
  });

  it('fires onSessionKilled when a heartbeat response lists the session in killedSessionIds', async () => {
    const fetchMock = okFetch({ accepted: 0, duplicates: 0, failed: 0, errors: [], killedSessionIds: ['sess_k'] });
    (global as { fetch?: unknown }).fetch = fetchMock;
    const onSessionKilled = jest.fn();
    const billing = new AforoMcpBilling({ ...cfg, onSessionKilled });
    billing.startSession('sess_k');
    await new Promise((r) => setImmediate(r));
    expect(onSessionKilled).toHaveBeenCalledWith('sess_k', 'SERVER_KILL');
    await billing.shutdown();
  });
});

describe('AforoMcpBilling productType, attribution and validation', () => {
  it('stamps productType: default MCP_SERVER, client option, per-call override', async () => {
    const fetchMock = okFetch();
    (global as { fetch?: unknown }).fetch = fetchMock;
    const billing = new AforoMcpBilling({ ...cfg, productType: ' agentic_api ' });
    billing.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 1);
    billing.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 1, { productType: 'mcp_server' });
    await billing.shutdown();
    expect(bodiesOf(fetchMock)[0].events.map((e: any) => e.productType)).toEqual(['AGENTIC_API', 'MCP_SERVER']);

    const f2 = okFetch();
    (global as { fetch?: unknown }).fetch = f2;
    const def = new AforoMcpBilling(cfg);
    def.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 1);
    await def.shutdown();
    expect(bodiesOf(f2)[0].events[0].productType).toBe('MCP_SERVER');
  });

  it('resolves customer from _meta.customer_id, then customerId config, then agentId; agentId from _meta, then config', async () => {
    const fetchMock = okFetch();
    (global as { fetch?: unknown }).fetch = fetchMock;
    const billing = new AforoMcpBilling({ ...cfg, customerId: 'cust_cfg', agentId: 'agent_cfg' });
    const wrapped = billing.wrapToolHandler(async (_req: { params: { name: string; _meta?: Record<string, unknown> } }) => 'ok');
    await wrapped({ params: { name: 'a', _meta: { customer_id: 'cust_meta', agent_id: 'agent_meta' } } });
    await wrapped({ params: { name: 'b' } });
    await billing.shutdown();
    const events = bodiesOf(fetchMock)[0].events;
    expect(events.map((e: any) => [e.customerId, e.agentId])).toEqual([
      ['cust_meta', 'agent_meta'], ['cust_cfg', 'agent_cfg'],
    ]);
  });

  it('drops events that would fail the batch (blank/long toolName, long agentId/customerId)', async () => {
    const fetchMock = okFetch();
    (global as { fetch?: unknown }).fetch = fetchMock;
    const onError = jest.fn();
    const billing = new AforoMcpBilling({ ...cfg, onError });
    billing.recordToolInvocation(' ', 'agent_1', undefined, 'SUCCESS', 1);
    billing.recordToolInvocation('t'.repeat(65), 'agent_1', undefined, 'SUCCESS', 1);
    billing.recordToolInvocation('search', 'a'.repeat(37), undefined, 'SUCCESS', 1);
    billing.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 1, { customerId: 'c'.repeat(65) });
    await billing.shutdown();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(4);
  });
});

describe('AforoMcpBilling transport', () => {
  const res = (status: number, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => ({ accepted: 1, duplicates: 0, failed: 0 }),
  });

  it('does not retry 400 but retries 429 honouring Retry-After and re-sends the same body', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(res(400));
    (global as { fetch?: unknown }).fetch = fetchMock;
    const onError = jest.fn();
    const billing = new AforoMcpBilling({ ...cfg, onError });
    billing.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 1);
    await billing.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('400') }));

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(res(429, { 'Retry-After': '0' })).mockResolvedValueOnce(res(202));
    billing.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 1);
    await billing.flush(); // would wait ~1s without Retry-After: 0
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    await billing.shutdown();
  });

  it('reports per-event rejections from errors[].message', async () => {
    const fetchMock = okFetch({ accepted: 0, duplicates: 0, failed: 1, errors: [{ index: 0, message: 'unknown metric' }] });
    (global as { fetch?: unknown }).fetch = fetchMock;
    const onError = jest.fn();
    const billing = new AforoMcpBilling({ ...cfg, onError });
    billing.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 1);
    await billing.shutdown();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('#0: unknown metric') }));
  });
});

describe('AforoMcpBilling batch flush', () => {
  it('posts {events:[...]} to /v1/ingest/batch with X-API-Key, in slices of at most 1000', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: 1, duplicates: 0, failed: 0 }),
    });
    (global as { fetch?: unknown }).fetch = fetchMock;

    const billing = new AforoMcpBilling({ ...cfg, flushCount: 5000 });
    for (let i = 0; i < 2500; i++) {
      billing.recordToolInvocation('search', 'agent_1', 'sess_1', 'SUCCESS', 12);
    }
    await billing.flush();

    const calls = fetchMock.mock.calls;
    expect(calls.map((c: any[]) => c[0])).toEqual([
      'https://ingestor.example/v1/ingest/batch',
      'https://ingestor.example/v1/ingest/batch',
      'https://ingestor.example/v1/ingest/batch',
    ]);
    const bodies = calls.map((c: any[]) => JSON.parse(c[1].body));
    expect(bodies.map((b: any) => b.events.length)).toEqual([1000, 1000, 500]);
    expect(calls[0][1].headers['X-API-Key']).toBe('k');
    expect(calls[0][1].headers.Authorization).toBeUndefined();

    const e = bodies[0].events[0];
    expect(e).toMatchObject({
      customerId: 'agent_1', metricName: 'mcp_server.tool_invocations', quantity: 1,
      productType: 'MCP_SERVER', toolName: 'search', agentId: 'agent_1',
      sessionId: 'sess_1', executionStatus: 'SUCCESS', executionDurationMs: 12,
    });
    expect(typeof e.idempotencyKey).toBe('string');
    // Same tool, same millisecond: keys must still differ or the ingestor dedupes real calls.
    const keys = new Set(bodies.flatMap((b: any) => b.events.map((ev: any) => ev.idempotencyKey)));
    expect(keys.size).toBe(2500);
    expect(new Date(e.occurredAt).toISOString()).toBe(e.occurredAt);
    expect(bodies.every((b: any) => b.events.every((ev: any) => !('apiKey' in ev)))).toBe(true);

    await billing.shutdown();
  });
});
