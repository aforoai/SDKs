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

describe('AforoMcpBilling session heartbeats', () => {
  it('never puts heartbeat events into the usage batch', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: 1, duplicates: 0, failed: 0 }),
    });
    (global as { fetch?: unknown }).fetch = fetchMock;

    const billing = new AforoMcpBilling(cfg);
    billing.startSession('sess_1');
    const wrapped = billing.wrapToolHandler(async (_req: { params: { name: string; _meta?: Record<string, unknown> } }) => 'ok');
    await wrapped({ params: { name: 'search', _meta: { session_id: 'sess_1' } } });
    await billing.endSession();
    await billing.shutdown();

    const events = fetchMock.mock.calls.flatMap((c: any[]) => JSON.parse(c[1].body).events);
    expect(events.length).toBeGreaterThan(0);
    // Heartbeats carried quantity 0, which the ingestor rejects (@Positive) and
    // fails the whole batch with 400.
    expect(events.some((e: any) => e.metricName === 'system.session.heartbeat')).toBe(false);
    expect(events.every((e: any) => e.quantity > 0)).toBe(true);
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
