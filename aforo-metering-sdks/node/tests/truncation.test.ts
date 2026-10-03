/**
 * Labels the middlewares read off the incoming request (endpointPath,
 * httpMethod) are truncated to the ingestor's limit and the event is still
 * sent. Fields the caller sets keep the drop-as-invalid behaviour.
 */
import { EventEmitter } from 'events';
import { expressMiddleware } from '../src/middleware/express';
import { koaMiddleware } from '../src/middleware/koa';
import { fastifyPlugin } from '../src/middleware/fastify';
import { AforoClient } from '../src/client';
import { truncateToLimit, truncateRequestLabel, resetTruncationWarnings } from '../src/limits';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

process.removeAllListeners('SIGTERM');
process.removeAllListeners('SIGINT');

const CLIENT = { flushCount: 1, flushInterval: 60_000, maxRetries: 0 };
const settle = () => new Promise((r) => setTimeout(r, 50));
const sentEvents = () =>
  mockFetch.mock.calls.flatMap((c) => JSON.parse(c[1].body).events as any[]);
const truncationWarnings = (spy: jest.SpyInstance) =>
  spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('truncated to'));

/** No string ends on an unpaired high surrogate. */
function endsOnWholeCharacter(text: string): boolean {
  const last = text.charCodeAt(text.length - 1);
  return !(last >= 0xd800 && last <= 0xdbff);
}

describe('truncateToLimit', () => {
  it('leaves a value at or under the limit unchanged', () => {
    expect(truncateToLimit('abc', 3)).toBe('abc');
    expect(truncateToLimit('', 3)).toBe('');
  });

  it('cuts to exactly the limit in UTF-16 code units', () => {
    expect(truncateToLimit('a'.repeat(600), 512)).toHaveLength(512);
  });

  it('cuts one unit earlier rather than split a surrogate pair', () => {
    // 'a' ×3 then U+1F600 (2 units) occupying units 3-4: a cut at 4 would split it.
    const value = 'aaa\u{1F600}bbb';
    const cut = truncateToLimit(value, 4);
    expect(cut).toBe('aaa');
    expect(endsOnWholeCharacter(cut)).toBe(true);
    // A cut that lands after the whole pair keeps it.
    expect(truncateToLimit(value, 5)).toBe('aaa\u{1F600}');
  });
});

describe('request-derived labels in the middlewares', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    resetTruncationWarnings();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => warnSpy.mockRestore());

  function expressCall(mw: any, url: string, method = 'GET') {
    const res = new EventEmitter() as any;
    res.statusCode = 200;
    mw({ method, url, originalUrl: url, user: { id: 'cust_1' }, headers: {} }, res, jest.fn());
    res.emit('finish');
  }

  it('express: an over-long path is truncated to 512, the event is sent, and it warns once across two events', async () => {
    const mw = expressMiddleware({ apiKey: 'k', clientOptions: CLIENT });
    expressCall(mw, '/' + 'a'.repeat(700));
    await settle();
    expressCall(mw, '/' + 'b'.repeat(900));
    await settle();

    const events = sentEvents();
    expect(events).toHaveLength(2);
    expect(events[0].endpointPath).toBe('/' + 'a'.repeat(511));
    expect(events[1].endpointPath).toHaveLength(512);
    expect(events[0].metricName).toBe('api_calls');
    const warnings = truncationWarnings(warnSpy);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('endpointPath');
    expect(warnings[0]).toContain('512');
  });

  it('express: the cut never leaves half a surrogate pair', async () => {
    const mw = expressMiddleware({ apiKey: 'k', clientOptions: CLIENT });
    // '/' + 510 'a' = 511 units, then an astral character straddling the 512 cut.
    expressCall(mw, '/' + 'a'.repeat(510) + '\u{1F600}' + 'tail');
    await settle();

    const [ev] = sentEvents();
    expect(ev.endpointPath).toBe('/' + 'a'.repeat(510));
    expect(ev.endpointPath.length).toBeLessThanOrEqual(512);
    expect(endsOnWholeCharacter(ev.endpointPath)).toBe(true);
  });

  it('express: an over-long method is truncated to 16 and the event is sent', async () => {
    const mw = expressMiddleware({ apiKey: 'k', clientOptions: CLIENT });
    expressCall(mw, '/x', 'M'.repeat(40));
    await settle();

    const [ev] = sentEvents();
    expect(ev.httpMethod).toBe('M'.repeat(16));
    expect(truncationWarnings(warnSpy)).toHaveLength(1);
    expect(truncationWarnings(warnSpy)[0]).toContain('httpMethod');
  });

  it('express: each event keeps its own idempotency key; two paths sharing the first 512 chars get different keys', async () => {
    const mw = expressMiddleware({ apiKey: 'k', clientOptions: CLIENT });
    const shared = '/' + 'a'.repeat(600);
    expressCall(mw, shared + '/one');
    await settle();
    expressCall(mw, shared + '/two');
    await settle();

    const [first, second] = sentEvents();
    expect(first.endpointPath).toBe(second.endpointPath);
    expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it('koa: an over-long path is truncated and the event is sent', async () => {
    const mw = koaMiddleware({ apiKey: 'k', clientOptions: CLIENT });
    const ctx: any = {
      path: '/' + 'k'.repeat(700), url: '/' + 'k'.repeat(700), method: 'GET', status: 200,
      state: { user: { id: 'cust_1' } }, get: () => '', request: {}, response: {},
    };
    await mw(ctx, async () => {});
    await settle();

    const [ev] = sentEvents();
    expect(ev.endpointPath).toHaveLength(512);
  });

  it('fastify: an over-long path is truncated and the event is sent', async () => {
    const hooks: Record<string, any> = {};
    await fastifyPlugin({ addHook: (name: string, fn: any) => { hooks[name] = fn; } }, { apiKey: 'k', clientOptions: CLIENT });
    hooks.onResponse(
      { url: '/' + 'f'.repeat(700) + '?q=1', method: 'GET', user: { id: 'cust_1' }, headers: {} },
      { statusCode: 200 },
      () => {},
    );
    await settle();

    const [ev] = sentEvents();
    expect(ev.endpointPath).toBe('/' + 'f'.repeat(511));
    await hooks.onClose();
  });

  it('a customerId longer than 64 is still dropped as invalid, not truncated', async () => {
    const drops: Array<{ reason: string; customerId: string }> = [];
    const mw = expressMiddleware({
      apiKey: 'k',
      customerId: 'c'.repeat(65),
      clientOptions: { ...CLIENT, onDrop: (events, reason) => drops.push({ reason, customerId: events[0].customerId }) },
    });
    expressCall(mw, '/x');
    await settle();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(drops).toEqual([{ reason: 'invalid', customerId: 'c'.repeat(65) }]);
  });

  it('a metricName returned by the caller\'s resolver is not altered: over-long still drops', async () => {
    const drops: string[] = [];
    const mw = expressMiddleware({
      apiKey: 'k',
      metricName: (req: any) => `GET ${req.url}`,
      clientOptions: { ...CLIENT, onDrop: (_e, reason) => drops.push(reason) },
    });
    expressCall(mw, '/' + 'a'.repeat(300));
    await settle();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(drops).toEqual(['invalid']);
  });
});

describe('labels passed explicitly to track()', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    resetTruncationWarnings();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => warnSpy.mockRestore());

  it('an over-long endpointPath given to track() is dropped as invalid, never truncated', async () => {
    const drops: Array<{ reason: string; length: number }> = [];
    const client = new AforoClient({
      apiKey: 'k', ...CLIENT,
      onDrop: (events, reason) => drops.push({ reason, length: (events[0].endpointPath ?? '').length }),
    });
    await client.track({ customerId: 'cust_1', metricName: 'api_calls', endpointPath: '/' + 'a'.repeat(600) });
    await client.shutdown();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(drops).toEqual([{ reason: 'invalid', length: 601 }]);
    expect(truncationWarnings(warnSpy)).toHaveLength(0);
  });

  it('truncateRequestLabel warns once per label name', () => {
    truncateRequestLabel('endpointPath', 'a'.repeat(600));
    truncateRequestLabel('endpointPath', 'b'.repeat(600));
    truncateRequestLabel('httpMethod', 'c'.repeat(60));
    truncateRequestLabel('httpMethod', 'GET');
    expect(truncationWarnings(warnSpy)).toHaveLength(2);
  });
});
