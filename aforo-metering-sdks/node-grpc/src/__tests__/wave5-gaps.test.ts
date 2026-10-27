/**
 * Wave 5 gap tests for @aforoai/grpc-metering (G265, G266/G296, G268, G270).
 * Each one failed on 1.2.2.
 */
import { inspect } from 'util';
import { AforoGrpcBilling, type DropReason } from '../index';

const KEY = 'sk_grpc_wave5_secret';
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const ok = () => ({ ok: true, status: 202, headers: new Map(), text: async () => '{"success":true,"data":{"accepted":1,"failed":0,"errors":[]}}' });
const sent = () => mockFetch.mock.calls.flatMap((c) => JSON.parse(c[1].body).events);

function call(md: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return { metadata: { getMap: () => md }, ...extra } as any;
}

async function unary(b: AforoGrpcBilling, c: any): Promise<void> {
  const wrapped = b.wrapUnary('GetUser', async () => ({ ok: true }));
  await new Promise<void>((resolve) => wrapped(c, () => resolve()));
}

function billing(extra: Record<string, unknown> = {}) {
  return new AforoGrpcBilling({
    tenantId: 't1',
    productId: 'p1',
    apiKey: KEY,
    ingestorUrl: 'https://ingest.example',
    serviceName: 'acme.v1.UserService',
    flushIntervalMs: 1e9,
    onError: () => undefined,
    ...extra,
  } as any);
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => ok());
});

describe('G265: customer resolver required', () => {
  test('constructing without customerResolver or trustCustomerHeader throws', () => {
    expect(() => billing()).toThrow(/customerResolver/);
  });

  test('without the opt-in, x-customer-id metadata is never read', async () => {
    const b = billing({ customerResolver: (c: any) => c.authUser });
    await unary(b, call({ 'x-customer-id': 'attacker_chosen' }));
    await b.flush();
    expect(sent()).toEqual([]);
    expect(b.droppedCount).toBe(1); // no customer → one invalid drop, RPC unaffected
    await b.shutdown();
  });

  test('the resolver receives the call; trustCustomerHeader reads x-customer-id', async () => {
    const b = billing({ customerResolver: (c: any) => c.authUser });
    await unary(b, call({}, { authUser: 'cust_auth' }));
    const h = billing({ trustCustomerHeader: true });
    await unary(h, call({ 'x-customer-id': 'cust_h' }));
    await b.flush();
    await h.flush();
    expect(sent().map((e) => e.customerId).sort()).toEqual(['cust_auth', 'cust_h']);
    await b.shutdown();
    await h.shutdown();
  });

  test('a resolver that throws does not break the RPC; the event is dropped as invalid', async () => {
    const reasons: DropReason[] = [];
    const b = billing({
      customerResolver: () => {
        throw new Error('bad token');
      },
      onDrop: (_e: unknown, r: DropReason) => reasons.push(r),
    });
    const wrapped = b.wrapUnary('GetUser', async () => ({ ok: true }));
    const result = await new Promise<any>((resolve) => wrapped(call(), (err: any, res: any) => resolve({ err, res })));
    expect(result).toEqual({ err: null, res: { ok: true } });
    expect(reasons).toEqual(['invalid']);
    await b.shutdown();
  });
});

describe('G266/G296/G268: bounded queue, one flusher, request deadline', () => {
  test('crossing flushCount never starts a request synchronously; requests carry a signal', async () => {
    const b = billing({ trustCustomerHeader: true, flushCount: 2 });
    for (let i = 0; i < 5; i++) await unary(b, call({ 'x-customer-id': 'c' }));
    await b.flush();
    expect(mockFetch.mock.calls.every((c) => c[1].signal)).toBe(true);
    await b.shutdown();
  });

  test('the queue is bounded: the oldest is evicted as overflow', async () => {
    const reasons: DropReason[] = [];
    const b = billing({ trustCustomerHeader: true, maxQueueSize: 2, onDrop: (_e: unknown, r: DropReason) => reasons.push(r) });
    for (let i = 0; i < 3; i++) await unary(b, call({ 'x-customer-id': 'c' }));
    expect(reasons).toEqual(['overflow']);
    await b.shutdown();
  });
});

describe('G270: https and key redaction', () => {
  test('plain http to a remote host is refused', () => {
    expect(() => billing({ trustCustomerHeader: true, ingestorUrl: 'http://ingest.example' })).toThrow(/https/);
  });

  test('the API key is not visible through inspect or JSON', async () => {
    const b = billing({ trustCustomerHeader: true });
    expect(inspect(b, { depth: 10, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(b)).not.toContain(KEY);
    await b.shutdown();
  });
});
