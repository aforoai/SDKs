/**
 * Unit tests for the Node transport core (src/transport-core/core.ts).
 * Every retry / backoff / breaker wait goes through an injected sleep and
 * random source, so no test here waits on the wall clock for a backoff.
 */
import { inspect } from 'util';
import {
  TransportCore,
  CoreFetch,
  CoreResponse,
  CoreSleep,
  CoreDropReason,
  checkBaseUrl,
  fullJitter,
  parseRetryAfter,
  COMPRESSION_MIN_BYTES,
} from '../src/transport-core/core';
import { bodyJson } from './helpers/request-body';

interface Ev {
  idempotencyKey: string;
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
}

const API_KEY = 'sk_live_secret_value_123';

function ev(i: number): Ev {
  return { idempotencyKey: `k${i}`, customerId: 'c1', metricName: 'api_calls', quantity: 1, occurredAt: '2026-10-26T00:00:00Z' };
}

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): CoreResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const accepted = (n: number) => response(202, { success: true, data: { accepted: n, duplicates: 0, failed: 0, errors: [] } });

/**
 * Fake sleep: waits shorter than `holdAtOrAbove` resolve at once and are
 * recorded; longer ones (idle interval, breaker cooldown) wait until their
 * signal aborts, i.e. until flush() / shutdown() / track() wakes the flusher.
 */
function fakeSleep(holdAtOrAbove = 1e7): { sleep: CoreSleep; delays: number[] } {
  const delays: number[] = [];
  const sleep: CoreSleep = (ms, signal) => {
    if (ms < holdAtOrAbove) {
      delays.push(ms);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  };
  return { sleep, delays };
}

interface Harness {
  core: TransportCore<Ev>;
  calls: Array<{ url: string; headers: Record<string, string>; keys: string[]; body: string | Uint8Array }>;
  drops: Array<{ reason: CoreDropReason; keys: string[] }>;
  logs: string[];
  delays: number[];
  maxInFlight: () => number;
}

function harness(
  answer: (call: number, events: Ev[]) => Promise<CoreResponse> | CoreResponse,
  opts: Partial<ConstructorParameters<typeof TransportCore<Ev>>[0]> = {},
): Harness {
  const calls: Harness['calls'] = [];
  const drops: Harness['drops'] = [];
  const logs: string[] = [];
  const { sleep, delays } = fakeSleep();
  let inFlight = 0;
  let max = 0;
  const fetch: CoreFetch = async (url, init) => {
    inFlight++;
    max = Math.max(max, inFlight);
    try {
      const events = bodyJson(init).events as Ev[];
      calls.push({ url, headers: init.headers, keys: events.map((e) => e.idempotencyKey), body: init.body });
      return await answer(calls.length, events);
    } finally {
      inFlight--;
    }
  };
  const core = new TransportCore<Ev>({
    baseUrl: 'https://ingest.example',
    apiKey: API_KEY,
    flushIntervalMs: 1e9,
    breakerInitialMs: 1e7,
    breakerMaxMs: 1e8,
    flushOnExit: false,
    fetch,
    sleep,
    random: () => 0.5,
    onDrop: (events, reason) => drops.push({ reason, keys: events.map((e) => e.idempotencyKey) }),
    logger: { debug: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    ...opts,
  });
  return { core, calls, drops, logs, delays, maxInFlight: () => max };
}

describe('transport core: queue and single flusher', () => {
  test('enqueue never sends; one flusher sends batches one at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async (_n, events) => {
      await gate;
      return accepted(events.length);
    }, { flushCount: 100 });
    for (let i = 0; i < 450; i++) h.core.enqueue(ev(i));
    expect(h.calls.length).toBe(0); // track() itself never starts a request
    // The flusher wakes on its own; gzip makes the send a few ticks later than enqueue.
    for (let i = 0; i < 100 && h.calls.length === 0; i++) await new Promise((r) => setImmediate(r));
    expect(h.calls.length).toBe(1); // the flusher woke and sent one batch (the gate holds the rest)
    const done = h.core.flush();
    const second = h.core.flush();
    release();
    await Promise.all([done, second]);
    expect(h.calls.map((c) => c.keys.length)).toEqual([100, 100, 100, 100, 50]);
    expect(h.maxInFlight()).toBe(1);
    await h.core.shutdown();
  });

  /** Size of the decoded JSON a call carried. */
  const utf8 = (body: unknown) => Buffer.byteLength(JSON.stringify(bodyJson({ body })), 'utf8');

  test('gzip only at 1 KiB or more; the same bytes on every retry; compression none sends JSON', async () => {
    const small = harness((_n, events) => accepted(events.length));
    small.core.enqueue(ev(1));
    await small.core.flush();
    expect(typeof small.calls[0].body).toBe('string');
    expect(small.calls[0].headers['Content-Encoding']).toBeUndefined();
    await small.core.shutdown();

    const retried = harness((n, events) => (n === 1 ? response(503) : accepted(events.length)));
    for (let i = 0; i < 50; i++) retried.core.enqueue(ev(i));
    await retried.core.flush();
    expect(retried.calls).toHaveLength(2);
    expect(retried.calls[0].body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(retried.calls[1].body as Uint8Array).equals(Buffer.from(retried.calls[0].body as Uint8Array))).toBe(true);
    expect(utf8(retried.calls[0].body)).toBeGreaterThan((retried.calls[0].body as Uint8Array).length);
    await retried.core.shutdown();

    const off = harness((_n, events) => accepted(events.length), { compression: 'none' });
    for (let i = 0; i < 50; i++) off.core.enqueue(ev(i));
    await off.core.flush();
    expect(typeof off.calls[0].body).toBe('string');
    expect(off.calls[0].headers['Content-Encoding']).toBeUndefined();
    await off.core.shutdown();

    expect(() => new TransportCore<Ev>({ baseUrl: 'https://x.example', apiKey: 'k', compression: 'br' as any, flushOnExit: false }))
      .toThrow(/compression/);
  });

  test('default batch is 500 events, clamped to 1000, gzip-encoded (G269, wave 8)', async () => {
    const h = harness((_n, events) => accepted(events.length));
    for (let i = 0; i < 1200; i++) h.core.enqueue(ev(i));
    await h.core.flush();
    expect(h.calls.map((c) => c.keys.length)).toEqual([500, 500, 200]);
    expect(h.calls[0].headers['Content-Encoding']).toBe('gzip');
    expect(h.calls[0].headers['X-API-Key']).toBe(API_KEY);
    expect(h.calls[0].url).toBe('https://ingest.example/v1/ingest/batch');
    await h.core.shutdown();

    const big = harness((_n, events) => accepted(events.length), { flushCount: 5000 });
    for (let i = 0; i < 1500; i++) big.core.enqueue(ev(i));
    await big.core.flush();
    expect(big.calls.map((c) => c.keys.length)).toEqual([1000, 500]);
    await big.core.shutdown();
  });

  test('overflow evicts the oldest event and reports it', async () => {
    const h = harness((_n, events) => accepted(events.length), { maxQueueSize: 3 });
    for (let i = 0; i < 5; i++) h.core.enqueue(ev(i));
    expect(h.drops).toEqual([{ reason: 'overflow', keys: ['k0'] }, { reason: 'overflow', keys: ['k1'] }]);
    expect(h.core.droppedCount).toBe(2);
    await h.core.flush();
    expect(h.calls[0].keys).toEqual(['k2', 'k3', 'k4']);
    await h.core.shutdown();
  });

  test('a body over the target size is split before sending', async () => {
    const h = harness((_n, events) => accepted(events.length), { targetRequestBodyBytes: 2048 });
    for (let i = 0; i < 40; i++) h.core.enqueue({ ...ev(i), metricName: 'm'.repeat(100) });
    await h.core.flush();
    expect(h.calls.length).toBeGreaterThan(1);
    for (const c of h.calls) expect(Buffer.byteLength(c.body)).toBeLessThanOrEqual(2048);
    expect(h.calls.flatMap((c) => c.keys)).toEqual(Array.from({ length: 40 }, (_, i) => `k${i}`));
    await h.core.shutdown();
  });
});

describe('transport core: retries', () => {
  test('full jitter: delay = random * min(max, base * 2^attempt)', async () => {
    const h = harness((n, events) => (n <= 3 ? response(503) : accepted(events.length)));
    h.core.enqueue(ev(1));
    const r = await h.core.flush();
    expect(r.sent).toBe(1);
    expect(h.delays).toEqual([250, 500, 1000]); // 0.5 * 500, 0.5 * 1000, 0.5 * 2000
    expect(h.calls.every((c) => c.keys[0] === 'k1')).toBe(true);
    expect(fullJitter(10, 500, 30000, () => 0.999)).toBeLessThan(30000);
    await h.core.shutdown();
  });

  test('Retry-After in delta-seconds is honoured and capped at 60 s', async () => {
    const h = harness((n, events) =>
      n === 1 ? response(429, {}, { 'Retry-After': '2' }) : n === 2 ? response(429, {}, { 'Retry-After': '120' }) : accepted(events.length),
    );
    h.core.enqueue(ev(1));
    await h.core.flush();
    expect(h.delays).toEqual([2000, 60000]);
    await h.core.shutdown();
  });

  test('Retry-After as an HTTP-date is honoured', async () => {
    const now = Date.parse('2026-10-26T10:00:00Z');
    const h = harness(
      (n, events) => (n === 1 ? response(503, {}, { 'Retry-After': 'Mon, 26 Oct 2026 10:00:07 GMT' }) : accepted(events.length)),
      { clock: () => now },
    );
    h.core.enqueue(ev(1));
    await h.core.flush();
    expect(h.delays).toEqual([7000]);
    expect(parseRetryAfter('garbage', now, 60000)).toBeUndefined();
    await h.core.shutdown();
  });

  test('a hung request is cut by the per-request timeout and retried', async () => {
    // Replace fetch with one that honours the abort signal, like real fetch.
    let calls = 0;
    const core = new TransportCore<Ev>({
      baseUrl: 'https://ingest.example',
      apiKey: API_KEY,
      timeoutMs: 30,
      flushIntervalMs: 1e9,
      flushOnExit: false,
      sleep: fakeSleep().sleep,
      random: () => 0,
      logger: { debug: () => {}, warn: () => {}, error: () => {} },
      fetch: (_url, init) =>
        new Promise<CoreResponse>((resolve, reject) => {
          calls++;
          if (calls === 1) {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            return;
          }
          resolve(accepted(1));
        }),
    });
    core.enqueue(ev(1));
    const r = await core.flush();
    expect(r.sent).toBe(1);
    expect(calls).toBe(2);
    await core.shutdown();
  });
});

describe('transport core: outage, breaker and status handling', () => {
  test('after retries the batch is requeued with the same keys; recovery sends it', async () => {
    let down = true;
    const h = harness((_n, events) => {
      if (down) throw new TypeError('fetch failed');
      return accepted(events.length);
    });
    for (let i = 0; i < 3; i++) h.core.enqueue(ev(i));
    const r1 = await h.core.flush();
    expect(r1).toMatchObject({ sent: 0, failed: 0, requeued: 3, queued: 3 });
    expect(h.calls.length).toBe(4); // 1 + maxRetries
    expect(h.core.isBreakerOpen).toBe(true);
    expect(h.drops).toEqual([]);
    down = false;
    const r2 = await h.core.flush(); // explicit flush probes despite the open breaker
    expect(r2).toMatchObject({ sent: 3, queued: 0 });
    expect(h.calls[h.calls.length - 1].keys).toEqual(['k0', 'k1', 'k2']);
    expect(h.core.isBreakerOpen).toBe(false);
    await h.core.shutdown();
  });

  test('401/403 keep the usage queued and log an error once per breaker opening', async () => {
    let status = 401;
    const h = harness((_n, events) => (status === 202 ? accepted(events.length) : response(status)));
    h.core.enqueue(ev(1));
    await h.core.flush();
    await h.core.flush();
    expect(h.drops).toEqual([]);
    expect(h.core.queued).toBe(1);
    expect(h.logs.filter((l) => l.includes('API key is wrong')).length).toBe(1);
    status = 202;
    await h.core.flush();
    expect(h.core.queued).toBe(0);
    expect(h.core.sentCount).toBe(1);
    await h.core.shutdown();
  });

  test('other 4xx drop the batch as rejected, not retried', async () => {
    const h = harness(() => response(400, { detail: 'bad metric' }));
    h.core.enqueue(ev(1));
    const r = await h.core.flush();
    expect(r.failed).toBe(1);
    expect(h.calls.length).toBe(1);
    expect(h.drops).toEqual([{ reason: 'rejected', keys: ['k1'] }]);
    await h.core.shutdown();
  });

  test('413 splits the batch; a single event still 413 is rejected', async () => {
    const h = harness((_n, events) => (events.length > 1 || events[0].idempotencyKey === 'k3' ? response(413) : accepted(1)));
    for (let i = 0; i < 4; i++) h.core.enqueue(ev(i));
    const r = await h.core.flush();
    expect(r.sent).toBe(3);
    expect(h.drops).toEqual([{ reason: 'rejected', keys: ['k3'] }]);
    await h.core.shutdown();
  });

  test('2xx per-event errors: retryable events are requeued, the rest rejected', async () => {
    const h = harness((n, events) =>
      n === 1
        ? response(202, {
            success: true,
            data: { accepted: 1, failed: 2, errors: [{ index: 0, message: 'busy', retryable: true }, { index: 2, message: 'bad', retryable: false }] },
          })
        : accepted(events.length),
    );
    for (let i = 0; i < 3; i++) h.core.enqueue(ev(i));
    const r1 = await h.core.flush();
    expect(r1).toMatchObject({ sent: 1, failed: 1, requeued: 1 });
    expect(h.drops).toEqual([{ reason: 'rejected', keys: ['k2'] }]);
    await h.core.flush();
    expect(h.calls[1].keys).toEqual(['k0']);
    await h.core.shutdown();
  });
});

describe('transport core: shutdown', () => {
  test('enqueue after shutdown does not throw and reports closed', async () => {
    const h = harness((_n, events) => accepted(events.length));
    await h.core.shutdown();
    expect(h.core.enqueue(ev(9))).toBe(false);
    expect(h.drops).toEqual([{ reason: 'closed', keys: ['k9'] }]);
    expect(h.core.droppedCount).toBe(1);
  });

  test('shutdown honours its deadline and reports leftovers as shutdown', async () => {
    const h = harness(
      () => new Promise<CoreResponse>(() => undefined),
      {
        shutdownTimeoutMs: 50,
        fetch: (_url, init) =>
          new Promise<CoreResponse>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      },
    );
    for (let i = 0; i < 3; i++) h.core.enqueue(ev(i));
    const started = Date.now();
    const r = await h.core.shutdown();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r).toMatchObject({ leftover: 3, timedOut: true });
    expect(h.drops).toEqual([{ reason: 'shutdown', keys: ['k0', 'k1', 'k2'] }]);
    expect(h.core.droppedCount).toBe(3);
  });

  test('installs no signal handlers; flushes on beforeExit', async () => {
    const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT'), exit: process.listenerCount('beforeExit') };
    const sent: string[] = [];
    const core = new TransportCore<Ev>({
      baseUrl: 'https://ingest.example',
      apiKey: API_KEY,
      flushIntervalMs: 1e9,
      sleep: fakeSleep().sleep,
      logger: { debug: () => {}, warn: () => {}, error: () => {} },
      fetch: async (_u, init) => {
        sent.push(...bodyJson(init).events.map((e: Ev) => e.idempotencyKey));
        return accepted(1);
      },
    });
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('beforeExit')).toBe(before.exit + 1);
    core.enqueue(ev(1));
    process.emit('beforeExit', 0);
    await core.shutdown(); // same promise the exit hook started
    expect(sent).toEqual(['k1']);
    expect(process.listenerCount('beforeExit')).toBe(before.exit);
  });
});

describe('transport core: URL and key handling', () => {
  test('https is required except for local hosts or with allowInsecureHttp', () => {
    expect(() => checkBaseUrl('http://api.example.com')).toThrow(/https/);
    expect(() => checkBaseUrl('ftp://api.example.com')).toThrow(/https/);
    expect(checkBaseUrl('http://localhost:8080/')).toBe('http://localhost:8080');
    expect(checkBaseUrl('http://127.0.0.1:9')).toBe('http://127.0.0.1:9');
    expect(checkBaseUrl('http://[::1]:9')).toBe('http://[::1]:9');
    expect(checkBaseUrl('http://ingest.internal', true)).toBe('http://ingest.internal');
    expect(() => new TransportCore({ baseUrl: 'http://ingest.example', apiKey: API_KEY, flushOnExit: false })).toThrow(/https/);
  });

  test('the API key never appears in inspect, JSON, logs, errors or onDrop', async () => {
    const errors: string[] = [];
    const h = harness(() => response(400, { detail: 'nope' }), { onError: (e) => errors.push(e.message) });
    h.core.enqueue(ev(1));
    await h.core.flush();
    let constructionError = '';
    try {
      new TransportCore({ baseUrl: 'http://bad.example', apiKey: API_KEY, flushOnExit: false });
    } catch (e) {
      constructionError = (e as Error).message;
    }
    const surfaces = [inspect(h.core, { depth: 5, showHidden: true }), JSON.stringify(h.core), h.logs.join('\n'), errors.join('\n'), JSON.stringify(h.drops), constructionError];
    for (const s of surfaces) expect(s).not.toContain(API_KEY);
    await h.core.shutdown();
  });
});

describe('transport core: defaults come from contract/ingest-contract.json transportPolicy', () => {
  test('every number matches the contract', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const policy = require('../../contract/ingest-contract.json').transportPolicy;
    const { CORE_DEFAULTS } = require('../src/transport-core/core');
    expect(CORE_DEFAULTS.path).toBe(policy.endpoint);
    expect(CORE_DEFAULTS.flushCount).toBe(policy.batch.defaultEvents);
    expect(CORE_DEFAULTS.maxBatchEvents).toBe(policy.batch.maxEvents);
    expect(CORE_DEFAULTS.targetRequestBodyBytes).toBe(policy.batch.targetRequestBodyBytes);
    expect(CORE_DEFAULTS.maxQueueSize).toBe(policy.queue.defaultCapacity);
    expect(CORE_DEFAULTS.timeoutMs).toBe(policy.timeouts.requestMs);
    expect(CORE_DEFAULTS.shutdownTimeoutMs).toBe(policy.timeouts.shutdownMs);
    expect(CORE_DEFAULTS.maxRetries).toBe(policy.retry.maxRetries);
    expect(CORE_DEFAULTS.retryBaseMs).toBe(policy.retry.baseMs);
    expect(CORE_DEFAULTS.retryMaxDelayMs).toBe(policy.retry.maxDelayMs);
    expect(CORE_DEFAULTS.retryAfterMaxMs).toBe(policy.retry.retryAfter.maxMs);
    expect(CORE_DEFAULTS.breakerInitialMs).toBe(policy.afterRetriesExhausted.breakerCooldownMs.initial);
    expect(CORE_DEFAULTS.breakerMaxMs).toBe(policy.afterRetriesExhausted.breakerCooldownMs.max);
    expect(policy.compression.gzip).toBe(true);
    expect(policy.compression.minBytes).toBe(COMPRESSION_MIN_BYTES);
  });
});
