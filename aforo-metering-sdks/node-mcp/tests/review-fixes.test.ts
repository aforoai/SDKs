/**
 * Regression tests for the SDK review of 2026-11-09 (node-mcp findings 3, 4, 7 and R4).
 */
import { AforoMcpBilling, type UsageEvent } from '../src/index';
import { bodyJson } from './helpers/request-body';

const base = { tenantId: 't', productId: 'p', apiKey: 'k_test', ingestorUrl: 'https://ingest.test.aforo.ai', flushOnExit: false };
/** An onError written the way the README used to suggest: reads err.events, which plain Errors lack. */
const throwingOnError = (err: Error) => { void (err as unknown as { events: unknown[] }).events.length; };

describe('SDK review fixes (node-mcp)', () => {
  let fetchMock: jest.Mock;
  let warn: jest.SpyInstance;
  const sent = (): UsageEvent[] => fetchMock.mock.calls
    .flatMap((c) => bodyJson(c[1]).events as UsageEvent[])
    .filter((e) => e.metricName !== 'system.session.heartbeat');

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });
    (global as { fetch?: unknown }).fetch = fetchMock;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test('#4 a throwing onError on a failed heartbeat is not an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const billing = new AforoMcpBilling({ ...base, customerId: 'cust_1', onError: throwingOnError });
    try {
      billing.startSession('sess-1');
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
      expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('onError threw'))).toBe(true);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await billing.shutdown();
    }
  });

  test('#4 a throwing onError on a bad statusResolver keeps the result and the usage', async () => {
    const billing = new AforoMcpBilling({ ...base, customerId: 'cust_1', heartbeatEnabled: false, onError: throwingOnError });
    const tool = billing.wrapToolHandler(async () => ({ content: [{ type: 'text', text: 'ok' }] }), { statusResolver: () => 'DONE' });
    await expect(tool({ params: { name: 'search' } })).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    await billing.flush();
    expect(sent().map((e) => e.executionStatus)).toEqual(['SUCCESS']);
    await billing.shutdown();
  });

  test('#4 a throwing onError on a failing customerResolver still runs the tool', async () => {
    let ran = false;
    const billing = new AforoMcpBilling({ ...base, heartbeatEnabled: false, onError: throwingOnError,
      customerResolver: () => { throw new Error('lookup failed'); } });
    const tool = billing.wrapToolHandler(async () => { ran = true; return { content: [] }; });
    await expect(tool({ params: { name: 'search' } })).resolves.toEqual({ content: [] });
    expect(ran).toBe(true);
    expect(billing.droppedCount).toBe(1); // no customer: dropped as invalid, as documented
    await billing.shutdown();
  });

  test('#7 an unusable client agent_id falls back to the agentId config; a long session_id is left off', async () => {
    const drops: string[] = [];
    const billing = new AforoMcpBilling({ ...base, customerId: 'cust_1', agentId: 'agent_cfg', heartbeatEnabled: false,
      onError: () => {}, onDrop: (_e, reason) => drops.push(reason) });
    const tool = billing.wrapToolHandler(async () => ({ content: [] }));
    await tool({ params: { name: 'search', _meta: { agent_id: 'x'.repeat(37) } } });
    await tool({ params: { name: 'search', _meta: { agent_id: '   ' } } });
    await tool({ params: { name: 'search', _meta: { agent_id: { x: 1 } } } } as any);
    await tool({ params: { name: 'search', _meta: { agent_id: 'agent_ok', session_id: 's'.repeat(65) } } });
    await billing.flush();
    const events = sent();
    expect(drops).toEqual([]);
    expect(events.map((e) => e.agentId)).toEqual(['agent_cfg', 'agent_cfg', 'agent_cfg', 'agent_ok']);
    expect(events[3].sessionId).toBeUndefined();
    await billing.shutdown();
  });

  test('#3/R3 an executionDurationMs outside the Java int range is left off; the event is kept, one warning', async () => {
    const billing = new AforoMcpBilling({ ...base, customerId: 'cust_1', heartbeatEnabled: false, onError: () => {} });
    billing.recordToolInvocation('search', 'a1', undefined, 'SUCCESS', 3_000_000_000);
    billing.recordToolInvocation('search', 'a1', undefined, 'SUCCESS', Number.NaN);
    billing.recordToolInvocation('search', 'a1', undefined, 'SUCCESS', 42);
    await billing.flush();
    const events = sent();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.executionDurationMs)).toEqual([undefined, undefined, 42]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('executionDurationMs'))).toHaveLength(1);
    await billing.shutdown();
  });

  test('R4 the API key is trimmed, also on the heartbeat request', async () => {
    const billing = new AforoMcpBilling({ ...base, apiKey: '  k_test \n', customerId: 'cust_1', onError: () => {} });
    billing.startSession('sess-1');
    await new Promise((r) => setTimeout(r, 20));
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('k_test');
    await billing.shutdown();
    expect(() => new AforoMcpBilling({ ...base, apiKey: '   ', customerId: 'c' })).toThrow(/apiKey/);
  });
});
