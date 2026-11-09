/**
 * Regression tests for the 2026-11-09 review of the Node SDK (one per fix).
 * The ingestor behaviours they guard against were verified on usage-ingestor
 * main: an unreadable occurredAt / metadata / integer fails the WHOLE batch
 * with 400, and a HARD per-key limit answers 429 for any request with more
 * events than X-RateLimit-Limit, even in a fresh minute.
 */
import { EventEmitter } from 'events';
import { AforoClient } from '../src/client';
import { TransportCore, CoreFetch, CoreResponse, checkApiKey } from '../src/transport-core/core';
import { expressMiddleware } from '../src/middleware/express';
import { koaMiddleware } from '../src/middleware/koa';
import { isExcludedPath, DEFAULT_EXCLUDE_PATHS } from '../src/middleware/common';
import { describeLimitViolation } from '../src/limits';
import { startMockIngestor, MockIngestor, waitFor } from './support/mock-ingestor';
import { bodyJson } from './helpers/request-body';

process.removeAllListeners('SIGTERM');
process.removeAllListeners('SIGINT');

const silent = { debug() {}, warn() {}, error() {} };
// No test may reach a real host: AforoClient uses the global fetch. The real one is
// kept for the test that talks to the local mock ingestor.
const realFetch: CoreFetch = (globalThis as any).fetch.bind(globalThis);
const globalFetch = jest.fn();
(global as any).fetch = globalFetch;
beforeEach(() => {
  globalFetch.mockReset();
  globalFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map(), text: async () => '' });
});
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function response(status: number, headers: Record<string, string> = {}, body = ''): CoreResponse {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, text: async () => body };
}
const accepted = (n = 0) => response(202, {}, JSON.stringify({ success: true, data: { accepted: n, failed: 0 } }));

function recordingCore(answer: (events: any[]) => CoreResponse, extra: Record<string, unknown> = {}) {
  const sent: any[][] = [];
  const fetch: CoreFetch = async (_url, init) => {
    const events = JSON.parse(String(init.body)).events;
    sent.push(events);
    return answer(events);
  };
  const drops: Array<{ reason: string; events: any[] }> = [];
  const core = new TransportCore<any>({
    baseUrl: 'https://ingest.example', apiKey: 'k', fetch, flushOnExit: false, compression: 'none',
    flushIntervalMs: 60_000, retryBaseMs: 1, breakerInitialMs: 5, breakerMaxMs: 10, logger: silent,
    onDrop: (events, reason) => drops.push({ reason, events }), ...extra,
  });
  return { core, sent, drops };
}
const ev = (i: number, over: Record<string, unknown> = {}) => ({
  idempotencyKey: `k${i}`, customerId: 'c1', metricName: 'api_calls', quantity: 1, occurredAt: '2026-11-09T10:00:00Z', ...over,
});

// ── R1 / R2: values the ingestor cannot bind never reach a batch ─────────

describe('occurredAt and metadata the ingestor cannot bind (whole-batch 400)', () => {
  const mockFetch = jest.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(accepted());
    (global as any).fetch = mockFetch;
  });

  it.each(['2026-11-09T10:00:00', '2026-11-09T10:00Z', '2026-11-09T10:00:00+0530', '2026-11-09'])(
    'track() drops occurredAt %s as invalid; the rest of the batch is sent',
    async (bad) => {
      const drops: string[] = [];
      const client = new AforoClient({ apiKey: 'k', flushOnExit: false, flushInterval: 60_000, onDrop: (e, r) => drops.push(`${r}:${e[0].customerId}`) });
      await client.track({ customerId: 'cust_A', metricName: 'api_calls' });
      await client.track({ customerId: 'cust_B', metricName: 'api_calls', occurredAt: bad });
      await client.flush();
      expect(drops).toEqual(['invalid:cust_B']);
      expect(bodyJson(mockFetch.mock.calls[0][1]).events.map((e: any) => e.customerId)).toEqual(['cust_A']);
      await client.shutdown();
    },
  );

  it.each(['2026-11-09T10:00:00Z', '2026-11-09T10:00:00.123+05:30', '2026-11-09t10:00:00z'])('accepts occurredAt %s', async (ok) => {
    const client = new AforoClient({ apiKey: 'k', flushOnExit: false, flushInterval: 60_000 });
    await client.track({ customerId: 'c', metricName: 'm', occurredAt: ok });
    expect(client.bufferedCount).toBe(1);
    expect(client.droppedCount).toBe(0);
    await client.shutdown();
  });

  it('track() drops a metadata that is not a plain object as invalid', async () => {
    const drops: string[] = [];
    const client = new AforoClient({ apiKey: 'k', flushOnExit: false, flushInterval: 60_000, onDrop: (_e, r) => drops.push(r) });
    await client.track({ customerId: 'c', metricName: 'm', metadata: ['eu'] as any });
    await client.track({ customerId: 'c', metricName: 'm', metadata: 'eu' as any });
    await client.track({ customerId: 'c', metricName: 'm', metadata: new Date() as any });
    await client.track({ customerId: 'c', metricName: 'm', metadata: { region: 'eu' } });
    expect(drops).toEqual(['invalid', 'invalid', 'invalid']);
    expect(client.bufferedCount).toBe(1);
    expect(describeLimitViolation({ quantity: 1, occurredAt: '2026-11-09T10:00:00Z', metadata: [1] })).toMatch(/metadata must be a plain object/);
    await client.shutdown();
  });

  it('the core refuses the same shapes for every variant (safety net at enqueue)', async () => {
    const { core, drops } = recordingCore(() => accepted());
    expect(core.enqueue(ev(1, { occurredAt: '2026-11-09T10:00:00' }))).toBe(false);
    expect(core.enqueue(ev(2, { metadata: [1, 2] }))).toBe(false);
    expect(core.enqueue(ev(3, { metadata: null }))).toBe(true);
    expect(drops.map((d) => d.reason)).toEqual(['invalid', 'invalid']);
    await core.shutdown();
  });
});

// ── R3: integer fields outside the Java range are left off, event kept ───

describe('integer fields outside the ingestor range', () => {
  it('removes the field, sends the event and warns once per field', async () => {
    const warns: string[] = [];
    const { core, sent } = recordingCore(() => accepted(), { logger: { ...silent, warn: (m: string) => warns.push(m) } });
    core.enqueue(ev(1, { statusCode: 70000, responseTimeMs: 3_000_000_000, executionDurationMs: Number.NaN, messageCount: 3 }));
    core.enqueue(ev(2, { statusCode: 99999, dataBytes: 2 ** 64 }));
    core.enqueue(ev(3, { statusCode: 404, mqttQos: 1, executionDurationMs: 12.5 }));
    await core.flush();
    const [a, b, c] = sent[0];
    expect(a).not.toHaveProperty('statusCode');
    expect(a).not.toHaveProperty('responseTimeMs');
    expect(a).not.toHaveProperty('executionDurationMs');
    expect(a.messageCount).toBe(3);
    expect(b).not.toHaveProperty('statusCode');
    expect(b).not.toHaveProperty('dataBytes');
    expect(c).toMatchObject({ statusCode: 404, mqttQos: 1, executionDurationMs: 12.5 });
    expect(warns.filter((w) => w.startsWith('statusCode'))).toHaveLength(1);
    expect(core.droppedCount).toBe(0);
    await core.shutdown();
  });

  it('a 25-day WebSocket duration (2.16e9 ms) is not sent as an int', async () => {
    const { core, sent } = recordingCore(() => accepted());
    core.enqueue(ev(1, { executionDurationMs: 25 * 24 * 3600 * 1000 }));
    await core.flush();
    expect(sent[0][0]).not.toHaveProperty('executionDurationMs');
    await core.shutdown();
  });
});

// ── R4: API key trimmed, unusable characters refused without echoing it ──

describe('API key handling', () => {
  it('trims the key and sends it trimmed', async () => {
    const headers: Array<Record<string, string>> = [];
    const core = new TransportCore<any>({
      baseUrl: 'https://ingest.example', apiKey: '  sk_live_abc \n', flushOnExit: false, logger: silent, compression: 'none',
      fetch: async (_u, init) => { headers.push(init.headers); return accepted(1); },
    });
    core.enqueue(ev(1));
    await core.flush();
    expect(headers[0]['X-API-Key']).toBe('sk_live_abc');
    await core.shutdown();
  });

  it.each(['sk_live_SECRET\nX', 'sk_live_SECRET X', 'sk_live_SECRET\u0000', 'sk_live_SECRET€'])(
    'throws for %j without ever showing the key',
    (key) => {
      let message = '';
      try {
        new AforoClient({ apiKey: key });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/whitespace, control or non-ASCII/);
      expect(message).not.toContain('SECRET');
      expect(() => checkApiKey(key)).toThrow();
    },
  );

  it('still requires a key', () => {
    expect(() => new AforoClient({ apiKey: '   ' })).toThrow('apiKey is required');
  });
});

// ── R5: 429 + X-RateLimit-Limit below the batch size splits it ───────────

describe('429 with X-RateLimit-Limit below the batch size', () => {
  it('re-queues the batch at the head in order and sends parts of at most the limit', async () => {
    const { core, sent, drops } = recordingCore((events) =>
      events.length > 100
        ? response(429, { 'X-RateLimit-Limit': '100', 'Retry-After': '30' }, '{"status":429}')
        : response(202, { 'X-RateLimit-Limit': '100' }, JSON.stringify({ success: true, data: { accepted: events.length, failed: 0 } })),
    );
    for (let i = 0; i < 250; i++) core.enqueue(ev(i));
    await core.flush();
    expect(sent.map((b) => b.length)).toEqual([250, 100, 100, 50]);
    const delivered = sent.slice(1).flat().map((e) => e.idempotencyKey);
    expect(delivered).toEqual(Array.from({ length: 250 }, (_, i) => `k${i}`));
    expect(core.sentCount).toBe(250);
    expect(drops).toEqual([]);
    // The cap holds while the server keeps reporting the limit.
    for (let i = 250; i < 400; i++) core.enqueue(ev(i));
    await core.flush();
    expect(sent.slice(4).map((b) => b.length)).toEqual([100, 50]);
    await core.shutdown();
  });

  it('a 2xx without the header lifts the cap; other 429s are retried as before', async () => {
    let mode: 'limit' | 'plain429' | 'ok' = 'limit';
    const { core, sent } = recordingCore((events) => {
      if (mode === 'limit') {
        return events.length > 2
          ? response(429, { 'X-RateLimit-Limit': '2' })
          : response(202, { 'X-RateLimit-Limit': '2' }, JSON.stringify({ success: true, data: { accepted: events.length, failed: 0 } }));
      }
      if (mode === 'plain429') { mode = 'ok'; return response(429, { 'Retry-After': '0' }); }
      return accepted(events.length);
    });
    for (let i = 0; i < 5; i++) core.enqueue(ev(i));
    await core.flush();
    expect(sent.map((b) => b.length)).toEqual([5, 2, 2, 1]);
    mode = 'plain429';
    for (let i = 5; i < 9; i++) core.enqueue(ev(i));
    await core.flush();
    // 4 events, capped at 2: first request 429 without header → retried unchanged; then accepted, cap lifted.
    expect(sent.slice(4).map((b) => b.length)).toEqual([2, 2, 2]);
    for (let i = 9; i < 14; i++) core.enqueue(ev(i));
    await core.flush();
    expect(sent.slice(7).map((b) => b.length)).toEqual([5]);
    await core.shutdown();
  });

  it('a single event that gets 429 with a lower limit is retried, not split', async () => {
    let calls = 0;
    const { core } = recordingCore(() => (++calls === 1 ? response(429, { 'X-RateLimit-Limit': '0' }) : accepted(1)));
    core.enqueue(ev(1));
    await core.flush();
    expect(calls).toBe(2);
    expect(core.sentCount).toBe(1);
    await core.shutdown();
  });

  describe('against the mock ingestor (opt-in rateLimit fault)', () => {
    let mock: MockIngestor;
    beforeAll(async () => { mock = await startMockIngestor(); });
    afterAll(async () => { await mock.stop(); });

    it('every event is delivered once, in parts of at most the limit', async () => {
      await mock.reset();
      await mock.faults([{ rateLimit: 40, retryAfter: '30', times: -1 }]);
      const core = new TransportCore<any>({ baseUrl: mock.url, apiKey: 'k', flushOnExit: false, flushIntervalMs: 60_000, logger: silent,
        retryBaseMs: 1, breakerInitialMs: 20, breakerMaxMs: 50, fetch: realFetch });
      for (let i = 0; i < 100; i++) core.enqueue(ev(i));
      // One flush is normally enough; under a loaded CI box a slow request can end a cycle early.
      await waitFor(async () => (await core.flush()).queued === 0 && (await mock.state()).acceptedCount === 100, 'all 100 accepted', 25_000);
      const s = await mock.state();
      expect(s.requests[0]).toMatchObject({ status: 429, eventCount: 100 });
      for (const r of s.requests) {
        if (r.eventCount > 40) expect(r.status).toBe(429);
        if (r.status === 202) expect(r.eventCount).toBeLessThanOrEqual(40);
      }
      expect(s.requests.filter((r) => r.status === 429)).toHaveLength(1);
      expect(s.uniqueKeys).toBe(100);
      expect(s.acceptedCount).toBe(100);
      await core.shutdown();
    }, 30_000);
  });
});

// ── #6: shutdown keeps the process alive until it settles ────────────────

describe('shutdown deadline timer', () => {
  it('is ref’d while shutdown runs and cleared when it settles', async () => {
    const core = new TransportCore<any>({
      baseUrl: 'https://ingest.example', apiKey: 'k', flushOnExit: false, logger: silent, shutdownTimeoutMs: 200,
      fetch: async () => { throw new Error('ECONNREFUSED'); },
    });
    core.enqueue(ev(1));
    const done = core.shutdown();
    const timer = (core as any).deadlineTimer as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(true);
    const result = await done;
    expect(result.leftover).toBe(1);
    expect(core.droppedCount).toBe(1);
  });
});

// ── R6 / R7: middleware exclusions and throwing functions ────────────────

function fakeExpress(path: string, statusCode = 200) {
  const res = new EventEmitter() as any;
  res.statusCode = statusCode;
  return { req: { originalUrl: path, url: path, method: 'GET', headers: {} } as any, res };
}

describe('middleware excluded paths match an entry or below it', () => {
  it('isExcludedPath', () => {
    const d = DEFAULT_EXCLUDE_PATHS;
    for (const p of ['/health', '/health/', '/health/live', '/health?probe=1', '/ready', '/metrics/x', '/favicon.ico']) {
      expect(isExcludedPath(p, d)).toBe(true);
    }
    for (const p of ['/healthcare/patients/7', '/metrics-api/v1', '/readyz', '/ready-to-ship/orders', '/api/health']) {
      expect(isExcludedPath(p, d)).toBe(false);
    }
    expect(isExcludedPath('/api/data', ['/api/'])).toBe(true);
  });

  it('express meters /healthcare/... and skips /health/live', async () => {
    const drops: string[] = [];
    const client = new AforoClient({ apiKey: 'k', flushOnExit: false, flushInterval: 60_000, onDrop: (_e, r) => drops.push(r) });
    const mw = expressMiddleware({ client, customerResolver: () => 'cust_42' });
    for (const p of ['/healthcare/patients/7', '/health/live', '/metrics-api/report']) {
      const { req, res } = fakeExpress(p);
      mw(req, res, () => {});
      res.emit('finish');
    }
    await tick(10);
    expect(client.bufferedCount).toBe(2);
    await client.shutdown();
  });
});

describe('a metering function that throws drops the event as invalid (counted)', () => {
  it('express: customerResolver throws on an unauthenticated request', async () => {
    const drops: Array<{ reason: string; path?: string }> = [];
    const client = new AforoClient({ apiKey: 'k', flushOnExit: false, flushInterval: 60_000,
      onDrop: (e, r) => drops.push({ reason: r, path: e[0].endpointPath }) });
    const mw = expressMiddleware({ client, customerResolver: (req: any) => req.user.aforoCustomerId });
    const { req, res } = fakeExpress('/api/orders/2');
    mw(req, res, () => {});
    expect(() => res.emit('finish')).not.toThrow();
    await tick(10);
    expect(client.droppedCount).toBe(1);
    expect(drops).toEqual([{ reason: 'invalid', path: '/api/orders/2' }]);
    await client.shutdown();
  });

  it('express: a throwing metadata or metricName function is counted too', async () => {
    const client = new AforoClient({ apiKey: 'k', flushOnExit: false, flushInterval: 60_000 });
    const mw1 = expressMiddleware({ client, customerResolver: () => 'c', metadata: () => { throw new Error('x'); } });
    const mw2 = expressMiddleware({ client, customerResolver: () => 'c', metricName: () => { throw new Error('y'); } });
    for (const mw of [mw1, mw2]) {
      const { req, res } = fakeExpress('/api/x');
      mw(req, res, () => {});
      res.emit('finish');
    }
    await tick(10);
    expect(client.droppedCount).toBe(2);
    await client.shutdown();
  });

  it('koa: a throwing customerResolver is counted', async () => {
    const client = new AforoClient({ apiKey: 'k', flushOnExit: false, flushInterval: 60_000 });
    const mw = koaMiddleware({ client, customerResolver: (ctx: any) => ctx.state.user.id });
    await mw({ path: '/api/x', method: 'GET', status: 200, state: {}, request: {}, response: {}, get: () => '' }, async () => {});
    await tick(10);
    expect(client.droppedCount).toBe(1);
    await client.shutdown();
  });
});

describe('koa meters requests answered through a thrown error', () => {
  const mockFetch = jest.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(accepted());
    (global as any).fetch = mockFetch;
  });

  it.each([
    [Object.assign(new Error('no such order'), { status: 404 }), 404],
    [new Error('boom'), 500],
  ])('meters %s with status %i and rethrows it unchanged', async (err, status) => {
    const client = new AforoClient({ apiKey: 'k', flushOnExit: false, flushInterval: 60_000 });
    const mw = koaMiddleware({ client, customerResolver: () => 'cust_42' });
    const ctx = { path: '/api/orders/9', method: 'GET', status: 404, state: {}, request: {}, response: {}, get: () => '' };
    await expect(mw(ctx, async () => { throw err; })).rejects.toBe(err);
    await client.flush();
    expect(bodyJson(mockFetch.mock.calls[0][1]).events[0]).toMatchObject({ customerId: 'cust_42', statusCode: status });
    await client.shutdown();
  });
});
