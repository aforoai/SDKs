import { koaMiddleware } from '../src/middleware/koa';
import { fastifyPlugin } from '../src/middleware/fastify';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

process.removeAllListeners('SIGTERM');
process.removeAllListeners('SIGINT');

const clientOptions = { flushCount: 1, flushInterval: 60_000, maxRetries: 0 };
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

function koaCtx(method: string, headers: Record<string, string>) {
  return {
    path: '/api/data',
    method,
    status: 200,
    state: {},
    request: {},
    response: {},
    get: (name: string) => headers[name.toLowerCase()] ?? '',
  };
}

async function runFastify(opts: any, request: any) {
  const hooks: Record<string, Function> = {};
  const fastify = { addHook: (name: string, fn: Function) => { hooks[name] = fn; } };
  await fastifyPlugin(fastify, opts);
  await new Promise<void>((resolve) => hooks.onResponse(request, { statusCode: 200 }, resolve));
}

describe('koaMiddleware', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });
  });

  it('meters with the default catalog metric and X-Customer-Id', async () => {
    const mw = koaMiddleware({ apiKey: 'k', clientOptions });
    await mw(koaCtx('GET', { 'x-customer-id': 'cust_1' }), async () => {});
    await tick();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({ customerId: 'cust_1', metricName: 'api_calls' });
  });

  it('skips OPTIONS and never falls back to x-api-key', async () => {
    const mw = koaMiddleware({ apiKey: 'k', clientOptions });
    await mw(koaCtx('OPTIONS', { 'x-customer-id': 'cust_1' }), async () => {});
    await mw(koaCtx('GET', { 'x-api-key': 'secret' }), async () => {});
    await tick();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('fastifyPlugin', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });
  });

  it('meters with a configured metric resolver', async () => {
    await runFastify({ apiKey: 'k', clientOptions, metricName: () => 'otp_delivered' },
      { url: '/api/data', method: 'POST', headers: { 'x-customer-id': 'cust_2' } });
    await tick();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({ customerId: 'cust_2', metricName: 'otp_delivered' });
  });

  it('skips OPTIONS and never falls back to x-api-key', async () => {
    await runFastify({ apiKey: 'k', clientOptions },
      { url: '/api/data', method: 'OPTIONS', headers: { 'x-customer-id': 'cust_1' } });
    await runFastify({ apiKey: 'k', clientOptions },
      { url: '/api/data', method: 'GET', headers: { 'x-api-key': 'secret' } });
    await tick();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('customer, quantity and metadata options', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });
  });

  it('koa: customerId resolver, quantity function and metadata', async () => {
    const mw = koaMiddleware({
      apiKey: 'k', clientOptions,
      customerId: () => 'cust_fn',
      quantity: () => 3,
      metadata: () => ({ plan: 'pro' }),
    });
    await mw(koaCtx('GET', {}), async () => {});
    await tick();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({ customerId: 'cust_fn', quantity: 3, metadata: { plan: 'pro' } });
  });

  it('koa: fixed customerId and excluded paths/status codes', async () => {
    const mw = koaMiddleware({ apiKey: 'k', clientOptions, customerId: 'cust_static', excludePaths: ['/api'] });
    await mw(koaCtx('GET', {}), async () => {});
    const mw2 = koaMiddleware({ apiKey: 'k', clientOptions, customerId: 'cust_static', excludeStatusCodes: [200] });
    await mw2(koaCtx('GET', {}), async () => {});
    await tick();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fastify: fixed customerId, quantity and metadata', async () => {
    await runFastify({
      apiKey: 'k', clientOptions,
      customerId: 'cust_static', quantity: 2, metadata: () => ({ region: 'eu' }),
    }, { url: '/api/data', method: 'GET', headers: {} });
    await tick();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({ customerId: 'cust_static', quantity: 2, metadata: { region: 'eu' } });
  });

  it('fastify: customerId resolver, excluded paths/status codes', async () => {
    await runFastify({ apiKey: 'k', clientOptions, customerId: () => 'c', excludePaths: ['/api'] },
      { url: '/api/data', method: 'GET', headers: {} });
    await runFastify({ apiKey: 'k', clientOptions, customerId: () => 'c', excludeStatusCodes: [200] },
      { url: '/api/data', method: 'GET', headers: {} });
    await tick();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('productType, HTTP fields and quantity <= 0', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });
  });

  it('koa: sends productType and top-level HTTP fields', async () => {
    const mw = koaMiddleware({ apiKey: 'k', clientOptions, productType: 'agentic_api' });
    await mw({ ...koaCtx('POST', { 'x-customer-id': 'cust_1' }), path: '/api/data', status: 201 }, async () => {});
    await tick();
    const ev = JSON.parse(mockFetch.mock.calls[0][1].body).events[0];
    expect(ev).toMatchObject({ productType: 'AGENTIC_API', endpointPath: '/api/data', httpMethod: 'POST', statusCode: 201 });
    expect(typeof ev.responseTimeMs).toBe('number');
  });

  it('koa: skips quantity <= 0', async () => {
    const mw = koaMiddleware({ apiKey: 'k', clientOptions, quantity: 0 });
    await mw(koaCtx('GET', { 'x-customer-id': 'cust_1' }), async () => {});
    await tick();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fastify: default productType API, path without query, elapsed time', async () => {
    const hooks: Record<string, Function> = {};
    await fastifyPlugin({ addHook: (n: string, fn: Function) => { hooks[n] = fn; } }, { apiKey: 'k', clientOptions });
    await new Promise<void>((resolve) => hooks.onResponse(
      { url: '/api/data?x=1', method: 'GET', headers: { 'x-customer-id': 'cust_1' } },
      { statusCode: 200, elapsedTime: 12.6 }, resolve));
    await tick();
    const ev = JSON.parse(mockFetch.mock.calls[0][1].body).events[0];
    expect(ev).toMatchObject({ productType: 'API', endpointPath: '/api/data', httpMethod: 'GET', statusCode: 200, responseTimeMs: 13 });
  });

  it('fastify: skips quantity <= 0', async () => {
    await runFastify({ apiKey: 'k', clientOptions, quantity: () => -1 },
      { url: '/api/data', method: 'GET', headers: { 'x-customer-id': 'cust_1' } });
    await tick();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
