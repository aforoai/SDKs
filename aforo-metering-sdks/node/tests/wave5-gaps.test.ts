/**
 * Wave 5 gap tests for @aforoai/metering (G265, G266, G268, G269, G270, G293,
 * G294, G295). Each test failed on 1.1.2 for the reason in its name.
 */
import { EventEmitter } from 'events';
import { inspect } from 'util';
import { AforoClient } from '../src/client';
import { expressMiddleware } from '../src/middleware/express';
import { koaMiddleware } from '../src/middleware/koa';
import { fastifyPlugin } from '../src/middleware/fastify';
import { bodyJson } from './helpers/request-body';

const KEY = 'sk_live_wave5_secret';
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function ok() {
  return { ok: true, status: 202, headers: new Map(), text: async () => '{"success":true,"data":{"accepted":1,"failed":0,"errors":[]}}' };
}

function sentEvents(): any[] {
  return mockFetch.mock.calls.flatMap((c) => bodyJson(c[1]).events);
}

function fakeReqRes(url: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const req = { method: 'GET', originalUrl: url, url, headers, ...extra };
  const res = Object.assign(new EventEmitter(), { statusCode: 200 });
  return { req, res };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => ok());
});

describe('G293: no signal handlers', () => {
  test('constructing a client adds no SIGTERM/SIGINT listener', async () => {
    const term = process.listenerCount('SIGTERM');
    const int = process.listenerCount('SIGINT');
    const client = new AforoClient({ apiKey: KEY, baseUrl: 'https://x.test' });
    expect(process.listenerCount('SIGTERM')).toBe(term);
    expect(process.listenerCount('SIGINT')).toBe(int);
    await client.shutdown();
  });
});

describe('G266/G269: bounded queue, one flusher, 500-event batches', () => {
  test('track() never starts a request itself; default batch is 500', async () => {
    const client = new AforoClient({ apiKey: KEY, baseUrl: 'https://x.test', flushInterval: 1e9 });
    for (let i = 0; i < 499; i++) await client.track({ customerId: 'c', metricName: 'm' });
    expect(mockFetch).not.toHaveBeenCalled();
    await client.flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(bodyJson(mockFetch.mock.calls[0][1]).events).toHaveLength(499);
    // A 499-event body is far over 1 KiB, so it is gzip-encoded (wave 8, G269).
    expect(mockFetch.mock.calls[0][1].headers['Content-Encoding']).toBe('gzip');
    await client.shutdown();
  });

  test('every request carries an abort signal (total deadline)', async () => {
    const client = new AforoClient({ apiKey: KEY, baseUrl: 'https://x.test', flushInterval: 1e9 });
    await client.track({ customerId: 'c', metricName: 'm' });
    await client.flush();
    expect(mockFetch.mock.calls[0][1].signal).toBeDefined();
    await client.shutdown();
  });
});

describe('G270: https and key redaction', () => {
  test('http:// to a remote host is refused; localhost and allowInsecureHttp are allowed', async () => {
    expect(() => new AforoClient({ apiKey: KEY, baseUrl: 'http://ingest.example.com' })).toThrow(/https/);
    const local = new AforoClient({ apiKey: KEY, baseUrl: 'http://127.0.0.1:1' });
    const opted = new AforoClient({ apiKey: KEY, baseUrl: 'http://ingest.internal', allowInsecureHttp: true });
    await local.shutdown();
    await opted.shutdown();
  });

  test('the API key never appears in inspect() or JSON of the client', async () => {
    const client = new AforoClient({ apiKey: KEY, baseUrl: 'https://x.test' });
    expect(inspect(client, { depth: 10, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(client)).not.toContain(KEY);
    await client.shutdown();
  });
});

describe('G294: shutdown losses are counted; middleware accepts the app\'s client', () => {
  test('events still queued at the shutdown deadline are counted and reported', async () => {
    mockFetch.mockImplementation(
      (_u: string, init: any) =>
        new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    );
    const drops: Array<[number, string]> = [];
    const client = new AforoClient({
      apiKey: KEY,
      baseUrl: 'https://x.test',
      shutdownTimeoutMs: 50,
      flushInterval: 1e9,
      onDrop: (events, reason) => drops.push([events.length, reason]),
    });
    for (let i = 0; i < 3; i++) await client.track({ customerId: 'c', metricName: 'm' });
    await client.shutdown();
    expect(client.droppedCount).toBe(3);
    expect(drops).toEqual([[3, 'shutdown']]);
  });

  test('track() after shutdown does not throw; the event is counted as closed', async () => {
    const reasons: string[] = [];
    const client = new AforoClient({ apiKey: KEY, baseUrl: 'https://x.test', onDrop: (_e, r) => reasons.push(r) });
    await client.shutdown();
    await expect(client.track({ customerId: 'c', metricName: 'm' })).resolves.toBeUndefined();
    expect(reasons).toEqual(['closed']);
  });

  test('express and koa middleware use a client the app passes in', async () => {
    const client = new AforoClient({ apiKey: KEY, baseUrl: 'https://x.test', flushInterval: 1e9 });
    const mw = expressMiddleware({ client, customerResolver: () => 'cust_1' });
    const { req, res } = fakeReqRes('/a');
    mw(req, res, () => undefined);
    res.emit('finish');
    const koa = koaMiddleware({ client, customerResolver: () => 'cust_2' });
    await koa({ path: '/b', method: 'GET', status: 200, request: {}, response: {}, get: () => '' }, async () => undefined);
    await new Promise((r) => setImmediate(r));
    expect(client.bufferedCount).toBe(2);
    await client.flush();
    expect(sentEvents().map((e) => e.customerId)).toEqual(['cust_1', 'cust_2']);
    await client.shutdown();
  });
});

describe('G265: customer identity needs a resolver or an explicit opt-in', () => {
  test('express/koa/fastify refuse to start without customerResolver or trustCustomerHeader', async () => {
    const client = new AforoClient({ apiKey: KEY, baseUrl: 'https://x.test' });
    expect(() => expressMiddleware({ client })).toThrow(/customerResolver/);
    expect(() => koaMiddleware({ client })).toThrow(/customerResolver/);
    await expect(fastifyPlugin({ addHook: () => undefined }, { client })).rejects.toThrow(/customerResolver/);
    await client.shutdown();
  });

  test('without the opt-in, X-Customer-Id is never read', async () => {
    const client = new AforoClient({ apiKey: KEY, baseUrl: 'https://x.test', flushInterval: 1e9 });
    const mw = expressMiddleware({ client, customerResolver: (req: any) => req.user?.id });
    const { req, res } = fakeReqRes('/a', { 'x-customer-id': 'attacker_chosen' });
    let nextCalled = false;
    mw(req, res, () => (nextCalled = true));
    res.emit('finish');
    expect(nextCalled).toBe(true);
    await client.flush();
    expect(sentEvents()).toEqual([]);
    expect(client.droppedCount).toBe(1); // resolver returned nothing → dropped as invalid, counted
    await client.shutdown();
  });

  test('trustCustomerHeader: true reads X-Customer-Id', async () => {
    const client = new AforoClient({ apiKey: KEY, baseUrl: 'https://x.test', flushInterval: 1e9 });
    const mw = expressMiddleware({ client, trustCustomerHeader: true });
    const { req, res } = fakeReqRes('/a', { 'x-customer-id': 'cust_h' });
    mw(req, res, () => undefined);
    res.emit('finish');
    await client.flush();
    expect(sentEvents().map((e) => e.customerId)).toEqual(['cust_h']);
    await client.shutdown();
  });
});

describe('G295: endpoint paths are normalized by default', () => {
  test('dynamic segments collapse; a framework route template wins', async () => {
    const client = new AforoClient({ apiKey: KEY, baseUrl: 'https://x.test', flushInterval: 1e9 });
    const mw = expressMiddleware({ client, customerResolver: () => 'c' });
    const a = fakeReqRes('/v1/users/12345/orders/3f2c1b4a-9d8e-4f7a-8b6c-1a2b3c4d5e6f?x=1');
    mw(a.req, a.res, () => undefined);
    a.res.emit('finish');
    const b = fakeReqRes('/v1/items/42', {}, { route: { path: '/v1/items/:itemId' }, baseUrl: '' });
    mw(b.req, b.res, () => undefined);
    b.res.emit('finish');
    await client.flush();
    expect(sentEvents().map((e) => e.endpointPath)).toEqual(['/v1/users/:id/orders/:id', '/v1/items/:itemId']);
    await client.shutdown();
  });

  test('normalizePath: false keeps the raw path', async () => {
    const client = new AforoClient({ apiKey: KEY, baseUrl: 'https://x.test', flushInterval: 1e9 });
    const mw = expressMiddleware({ client, customerResolver: () => 'c', normalizePath: false });
    const a = fakeReqRes('/v1/users/12345');
    mw(a.req, a.res, () => undefined);
    a.res.emit('finish');
    await client.flush();
    expect(sentEvents()[0].endpointPath).toBe('/v1/users/12345');
    await client.shutdown();
  });
});
