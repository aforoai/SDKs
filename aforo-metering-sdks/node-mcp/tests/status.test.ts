/**
 * executionStatus for wrapped MCP tool calls (P6 item 14, 2026-09-30).
 *
 * MCP tools normally report failure by RETURNING { isError: true, ... }, not
 * by throwing — before this change those calls billed as SUCCESS.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AforoMcpBilling, EXECUTION_STATUSES, defaultToolStatus } from '../src/index';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const CANONICAL: string[] = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../contract/ingest-contract.json'), 'utf8'),
).endpoints['/v1/ingest/batch'].eventOptionalFields.executionStatus.values;

const created: AforoMcpBilling[] = [];

function newBilling(overrides: Record<string, unknown> = {}) {
  const billing = new AforoMcpBilling({
    tenantId: 'tenant_test',
    productId: 'prod_test',
    apiKey: 'test-key',
    ingestorUrl: 'https://ingest.test.aforo.ai',
    flushIntervalMs: 3_600_000,
    flushCount: 100,
    heartbeatEnabled: false,
    ...overrides,
  });
  created.push(billing);
  return billing;
}

const req = (name = 'search') => ({ params: { name, _meta: { agent_id: 'agt_1' } } });

async function statusesSent(billing: AforoMcpBilling): Promise<string[]> {
  mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
  await billing.flush();
  const body = JSON.parse(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1].body);
  return body.events.map((e: any) => e.executionStatus);
}

describe('wrapToolHandler executionStatus', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    mockFetch.mockReset();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    // Stop each client's flush timer so Jest can exit cleanly.
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    await Promise.all(created.splice(0).map((b) => b.shutdown()));
    errorSpy.mockRestore();
  });

  it('a normal result is SUCCESS', async () => {
    const b = newBilling();
    await b.wrapToolHandler(async () => ({ content: [] }))(req());
    expect(await statusesSent(b)).toEqual(['SUCCESS']);
  });

  it('a returned { isError: true } result is ERROR, and the result is still returned', async () => {
    const b = newBilling();
    const out = await b.wrapToolHandler(async () => ({ isError: true, content: [{ type: 'text', text: 'no' }] }))(req());
    expect(out.isError).toBe(true);
    expect(await statusesSent(b)).toEqual(['ERROR']);
  });

  it('isError must be literally true', async () => {
    const b = newBilling();
    await b.wrapToolHandler(async () => ({ isError: 'yes', content: [] } as any))(req());
    expect(await statusesSent(b)).toEqual(['SUCCESS']);
  });

  it('a thrown error (e.g. a JSON-RPC error) is ERROR and is re-thrown', async () => {
    const b = newBilling();
    const rpcError = Object.assign(new Error('Invalid params'), { code: -32602 });
    await expect(b.wrapToolHandler(async () => { throw rpcError; })(req())).rejects.toBe(rpcError);
    expect(await statusesSent(b)).toEqual(['ERROR']);
  });

  it('a timeout is TIMEOUT (TimeoutError or MCP code -32001)', async () => {
    const b = newBilling();
    const t1 = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const t2 = Object.assign(new Error('Request timed out'), { code: -32001 });
    await expect(b.wrapToolHandler(async () => { throw t1; })(req())).rejects.toBe(t1);
    await expect(b.wrapToolHandler(async () => { throw t2; })(req())).rejects.toBe(t2);
    expect(await statusesSent(b)).toEqual(['TIMEOUT', 'TIMEOUT']);
  });

  it('a statusResolver overrides the default and is normalized', async () => {
    const b = newBilling();
    const wrapped = b.wrapToolHandler(
      async () => ({ content: [], partial: true }),
      { statusResolver: (result) => (result && (result as any).partial ? ' partial ' : undefined) },
    );
    await wrapped(req());
    expect(await statusesSent(b)).toEqual(['PARTIAL']);
  });

  it('a statusResolver returning undefined or blank falls back to the default', async () => {
    const b = newBilling();
    await b.wrapToolHandler(async () => ({ isError: true }), { statusResolver: () => undefined })(req());
    await b.wrapToolHandler(async () => ({ content: [] }), { statusResolver: () => '  ' })(req());
    expect(await statusesSent(b)).toEqual(['ERROR', 'SUCCESS']);
  });

  it('the resolver receives the error when the handler throws', async () => {
    const b = newBilling();
    const seen: unknown[] = [];
    const boom = new Error('boom');
    const wrapped = b.wrapToolHandler(async () => { throw boom; }, {
      statusResolver: (result, error) => { seen.push(result, error); return 'FAILED'; },
    });
    await expect(wrapped(req())).rejects.toBe(boom);
    expect(seen).toEqual([undefined, boom]);
    expect(await statusesSent(b)).toEqual(['FAILED']);
  });

  it('a throwing statusResolver is reported to onError and the default is used', async () => {
    const onError = jest.fn();
    const b = newBilling({ onError });
    await b.wrapToolHandler(async () => ({ isError: true }), {
      statusResolver: () => { throw new Error('resolver bug'); },
    })(req());
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'resolver bug' }));
    expect(await statusesSent(b)).toEqual(['ERROR']);
  });

  it('a statusResolver returning a non-canonical status falls back to the default', async () => {
    // An unknown executionStatus makes the ingestor reject the event.
    const onError = jest.fn();
    const b = newBilling({ onError });
    await b.wrapToolHandler(async () => ({ isError: true }), { statusResolver: () => 'ok' })(req());
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('"ok"') }));
    expect(await statusesSent(b)).toEqual(['ERROR']);
  });

  it('an async statusResolver is not awaited, and its rejection cannot crash the host', async () => {
    const onError = jest.fn();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const b = newBilling({ onError });
      await b.wrapToolHandler(async () => ({ content: [] }), {
        statusResolver: (async () => { throw new Error('async bug'); }) as any,
      })(req());
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Promise') }));
      expect(await statusesSent(b)).toEqual(['SUCCESS']);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('EXECUTION_STATUSES matches the ingest contract', () => {
    expect([...EXECUTION_STATUSES].sort()).toEqual([...CANONICAL].sort());
  });

  it('every status the default can produce is canonical', () => {
    const produced = new Set([
      defaultToolStatus({}, undefined),
      defaultToolStatus({ isError: true }, undefined),
      defaultToolStatus(undefined, new Error('x')),
      defaultToolStatus(undefined, Object.assign(new Error('x'), { name: 'TimeoutError' })),
    ]);
    for (const s of produced) expect(CANONICAL).toContain(s);
  });
});
