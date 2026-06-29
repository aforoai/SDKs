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
