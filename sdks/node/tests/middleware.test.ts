import { expressMiddleware } from '../src/middleware/express';
import { EventEmitter } from 'events';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Suppress signal handlers
process.removeAllListeners('SIGTERM');
process.removeAllListeners('SIGINT');

describe('expressMiddleware', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });
  });

  function createMockReqRes(overrides: {
    method?: string;
    url?: string;
    route?: any;
    user?: any;
    headers?: Record<string, string>;
    statusCode?: number;
  } = {}) {
    const res = new EventEmitter() as any;
    res.statusCode = overrides.statusCode ?? 200;

    const req = {
      method: overrides.method ?? 'GET',
      url: overrides.url ?? '/users/42',
      originalUrl: overrides.url ?? '/users/42',
      route: overrides.route,
      user: overrides.user,
      headers: overrides.headers ?? {},
    };

    return { req, res };
  }

  it('should capture events after response finishes', async () => {
    const mw = expressMiddleware({
      apiKey: 'test-key',
      baseUrl: 'https://ingest.test.aforo.ai',
      clientOptions: { flushCount: 1, flushInterval: 60_000, maxRetries: 0 },
    });

    const { req, res } = createMockReqRes({
      method: 'GET',
      url: '/api/v1/data',
      user: { id: 'cust_123' },
    });

    const next = jest.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();

    // Simulate response finish
    res.emit('finish');

    // Allow async processing
    await new Promise((r) => setTimeout(r, 100));

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].customerId).toBe('cust_123');
    expect(body.events[0].metricName).toMatch(/^GET \/api\/v1\/data$/);
  });

  it('should use route template for path normalization', async () => {
    const mw = expressMiddleware({
      apiKey: 'test-key',
      clientOptions: { flushCount: 1, flushInterval: 60_000, maxRetries: 0 },
    });

    const { req, res } = createMockReqRes({
      method: 'GET',
      url: '/users/123',
      route: { path: '/users/:id' },
      user: { id: 'cust_1' },
    });

    const next = jest.fn();
    mw(req, res, next);
    res.emit('finish');

    await new Promise((r) => setTimeout(r, 100));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].metricName).toBe('GET /users/:id');
  });

  it('should exclude health check paths', async () => {
    const mw = expressMiddleware({
      apiKey: 'test-key',
      clientOptions: { flushCount: 1, flushInterval: 60_000, maxRetries: 0 },
    });

    const { req, res } = createMockReqRes({
      url: '/health',
      user: { id: 'cust_1' },
    });

    const next = jest.fn();
    mw(req, res, next);
    res.emit('finish');

    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should extract customer ID from x-customer-id header', async () => {
    const mw = expressMiddleware({
      apiKey: 'test-key',
      clientOptions: { flushCount: 1, flushInterval: 60_000, maxRetries: 0 },
    });

    const { req, res } = createMockReqRes({
      url: '/api/data',
      headers: { 'x-customer-id': 'header-cust-456' },
    });

    const next = jest.fn();
    mw(req, res, next);
    res.emit('finish');

    await new Promise((r) => setTimeout(r, 100));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].customerId).toBe('header-cust-456');
  });

  it('should extract customer ID from x-api-key header as fallback', async () => {
    const mw = expressMiddleware({
      apiKey: 'test-key',
      clientOptions: { flushCount: 1, flushInterval: 60_000, maxRetries: 0 },
    });

    const { req, res } = createMockReqRes({
      url: '/api/data',
      headers: { 'x-api-key': 'apikey-789' },
    });

    const next = jest.fn();
    mw(req, res, next);
    res.emit('finish');

    await new Promise((r) => setTimeout(r, 100));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].customerId).toBe('apikey-789');
  });

  it('should skip when no customer ID can be resolved', async () => {
    const mw = expressMiddleware({
      apiKey: 'test-key',
      clientOptions: { flushCount: 1, flushInterval: 60_000, maxRetries: 0 },
    });

    const { req, res } = createMockReqRes({
      url: '/api/data',
      // No user, no headers
    });

    const next = jest.fn();
    mw(req, res, next);
    res.emit('finish');

    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should support custom metric name function', async () => {
    const mw = expressMiddleware({
      apiKey: 'test-key',
      metricName: (req: any) => `custom.${req.method.toLowerCase()}`,
      clientOptions: { flushCount: 1, flushInterval: 60_000, maxRetries: 0 },
    });

    const { req, res } = createMockReqRes({
      method: 'POST',
      url: '/whatever',
      user: { id: 'cust_1' },
    });

    const next = jest.fn();
    mw(req, res, next);
    res.emit('finish');

    await new Promise((r) => setTimeout(r, 100));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].metricName).toBe('custom.post');
  });

  it('should support custom quantity function', async () => {
    const mw = expressMiddleware({
      apiKey: 'test-key',
      quantity: (_req: any, _res: any) => 42,
      clientOptions: { flushCount: 1, flushInterval: 60_000, maxRetries: 0 },
    });

    const { req, res } = createMockReqRes({
      url: '/api/data',
      user: { id: 'cust_1' },
    });

    const next = jest.fn();
    mw(req, res, next);
    res.emit('finish');

    await new Promise((r) => setTimeout(r, 100));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].quantity).toBe(42);
  });

  it('should exclude specified status codes', async () => {
    const mw = expressMiddleware({
      apiKey: 'test-key',
      excludeStatusCodes: [401, 403],
      clientOptions: { flushCount: 1, flushInterval: 60_000, maxRetries: 0 },
    });

    const { req, res } = createMockReqRes({
      url: '/api/data',
      statusCode: 401,
      user: { id: 'cust_1' },
    });

    const next = jest.fn();
    mw(req, res, next);
    res.emit('finish');

    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
