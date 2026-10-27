/**
 * Wave 5 gap tests for @aforoai/graphql-metering (G265, G266/G296, G268,
 * G270, G298). Each one failed on 1.2.2.
 */
import { inspect } from 'util';
import { AforoGraphQlBilling, aforoApolloPlugin, type DropReason } from '../index';

const KEY = 'sk_gql_wave5_secret';
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const ok = () => ({ ok: true, status: 202, headers: new Map(), text: async () => '{"success":true,"data":{"accepted":1,"failed":0,"errors":[]}}' });
const sent = () => mockFetch.mock.calls.flatMap((c) => JSON.parse(c[1].body).events);
const nextTick = () => new Promise((r) => setImmediate(r));

function billing(extra: Record<string, unknown> = {}) {
  return new AforoGraphQlBilling({
    tenantId: 't1',
    productId: 'p1',
    apiKey: KEY,
    ingestorUrl: 'https://ingest.example',
    flushIntervalMs: 1e9,
    onError: () => undefined,
    ...extra,
  } as any);
}

function fakeRes() {
  const res: any = { statusCode: 200, ended: false };
  res.write = () => true;
  res.end = () => {
    res.ended = true;
    return res;
  };
  return res;
}

function runMiddleware(b: AforoGraphQlBilling, req: any) {
  const res = fakeRes();
  b.middleware()(req, res, () => undefined);
  return res;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => ok());
});

describe('G265: customer resolver required', () => {
  test('constructing without customerResolver or trustCustomerHeader throws', () => {
    expect(() => billing()).toThrow(/customerResolver/);
  });

  test('without the opt-in, x-customer-id is never read; no customer → invalid drop', async () => {
    const reasons: DropReason[] = [];
    const b = billing({ customerResolver: (req: any) => req.user?.id, onDrop: (_e: unknown, r: DropReason) => reasons.push(r) });
    const res = runMiddleware(b, { body: { query: '{ me { id } }' }, headers: { 'x-customer-id': 'attacker' } });
    res.end('{"data":{"me":{"id":"1"}}}');
    await nextTick();
    await b.flush();
    expect(sent()).toEqual([]);
    expect(reasons).toEqual(['invalid']);
    await b.shutdown();
  });

  test('trustCustomerHeader reads x-customer-id; the resolver wins when it answers', async () => {
    const b = billing({ trustCustomerHeader: true });
    runMiddleware(b, { body: { query: '{ me { id } }' }, headers: { 'x-customer-id': 'cust_h' } }).end('{"data":{}}');
    const r = billing({ customerResolver: (req: any) => req.user?.id });
    runMiddleware(r, { body: { query: '{ me { id } }' }, user: { id: 'cust_auth' }, headers: {} }).end('{"data":{}}');
    await nextTick();
    await b.flush();
    await r.flush();
    expect(sent().map((e) => e.customerId).sort()).toEqual(['cust_auth', 'cust_h']);
    await b.shutdown();
    await r.shutdown();
  });
});

describe('G298: metering runs after the response is sent', () => {
  test('express middleware: nothing is parsed or queued inside res.end', async () => {
    const b = billing({ trustCustomerHeader: true });
    const res = runMiddleware(b, { body: { query: '{ me { id } }' }, headers: { 'x-customer-id': 'c' } });
    res.end('{"data":{"me":{"id":"1"}}}');
    expect(res.ended).toBe(true);
    expect(b.queuedCount).toBe(0); // not yet: metering is deferred with setImmediate
    await nextTick();
    expect(b.queuedCount).toBe(1);
    await b.shutdown();
  });

  test('Apollo plugin: willSendResponse returns before the operation is recorded', async () => {
    const b = billing({ trustCustomerHeader: true });
    const hooks = await aforoApolloPlugin(b).requestDidStart();
    await hooks.willSendResponse({
      request: { query: '{ me { id } }' },
      contextValue: { headers: { 'x-customer-id': 'c' } },
      response: { body: { kind: 'single', singleResult: { data: { me: { id: '1' } } } } },
    });
    expect(b.queuedCount).toBe(0);
    await nextTick();
    expect(b.queuedCount).toBe(1);
    await b.shutdown();
  });
});

describe('G266/G296/G268: bounded queue, one flusher, request deadline', () => {
  test('crossing flushCount never starts a request synchronously; requests carry a signal', async () => {
    const b = billing({ trustCustomerHeader: true, flushCount: 2 });
    for (let i = 0; i < 5; i++) b.record({ customerId: 'c', query: '{ me { id } }', durationMs: 1, hasErrors: false });
    expect(mockFetch).not.toHaveBeenCalled();
    await b.flush();
    expect(mockFetch.mock.calls.every((c) => c[1].signal)).toBe(true);
    await b.shutdown();
  });

  test('the queue is bounded: the oldest is evicted as overflow', async () => {
    const reasons: DropReason[] = [];
    const b = billing({ trustCustomerHeader: true, maxQueueSize: 2, onDrop: (_e: unknown, r: DropReason) => reasons.push(r) });
    for (let i = 0; i < 3; i++) b.record({ customerId: 'c', query: '{ me { id } }', durationMs: 1, hasErrors: false });
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
