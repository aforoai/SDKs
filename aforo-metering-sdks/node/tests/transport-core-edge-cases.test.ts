/**
 * One test per row of contract/TRANSPORT-SPEC.md "Edge cases every core
 * handles the same way", plus the 2026-10-26 review findings for the Node
 * core (body-read deadline, unserializable events, exit flush, redirects,
 * breaker flapping on per-event retryable failures).
 *
 * Backoff and breaker waits use an injected sleep and random source. The
 * deadline tests use short real timeouts (100-300 ms) because the thing under
 * test is the timer itself; they wait on the client's own promises.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import {
  TransportCore,
  CoreFetch,
  CoreResponse,
  CoreSleep,
  CoreDropReason,
  CoreTransportError,
  parseRetryAfter,
} from '../src/transport-core/core';
import { startMockIngestor, MockIngestor, waitFor } from './support/mock-ingestor';
import { bodyJson } from './helpers/request-body';

jest.setTimeout(30_000);

interface Ev {
  idempotencyKey: string;
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

const API_KEY = 'sk_live_edge_case_secret';

function ev(i: number, metadata?: Record<string, unknown>): Ev {
  return {
    idempotencyKey: `k${i}`,
    customerId: 'c1',
    metricName: 'api_calls',
    quantity: 1,
    occurredAt: '2026-10-26T00:00:00Z',
    ...(metadata ? { metadata } : {}),
  };
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

/** Sleeps resolve at once and are recorded; nothing waits on the wall clock. */
function instantSleep(): { sleep: CoreSleep; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return new Promise((r) => setImmediate(r));
    },
  };
}

/** Short sleeps resolve at once; waits of 1e6 ms or more (breaker cooldowns) hold until woken. */
const holdLongSleep: CoreSleep = (ms, signal) =>
  ms >= 1e6
    ? new Promise((res) => (signal?.aborted ? res() : signal?.addEventListener('abort', () => res(), { once: true })))
    : new Promise((res) => setImmediate(res));

const live: TransportCore<Ev>[] = [];
afterEach(async () => {
  // A failed assertion must not leave a flusher running.
  await Promise.all(live.splice(0).map((c) => c.shutdown().catch(() => undefined)));
});

interface Rig {
  core: TransportCore<Ev>;
  calls: Array<{ keys: string[]; redirect?: string }>;
  drops: Array<{ reason: CoreDropReason; keys: string[] }>;
  errors: CoreTransportError<Ev>[];
  logs: { level: string; msg: string }[];
  delays: number[];
}

function rig(
  answer: (call: number, events: Ev[], signal: AbortSignal) => Promise<CoreResponse> | CoreResponse,
  opts: Partial<ConstructorParameters<typeof TransportCore<Ev>>[0]> = {},
): Rig {
  const calls: Rig['calls'] = [];
  const drops: Rig['drops'] = [];
  const errors: Rig['errors'] = [];
  const logs: Rig['logs'] = [];
  const { sleep, delays } = instantSleep();
  const fetch: CoreFetch = async (_url, init) => {
    const events = bodyJson(init).events as Ev[];
    calls.push({ keys: events.map((e) => e.idempotencyKey), redirect: (init as { redirect?: string }).redirect });
    return answer(calls.length, events, init.signal);
  };
  const core = new TransportCore<Ev>({
    baseUrl: 'https://ingest.example',
    apiKey: API_KEY,
    flushIntervalMs: 1e9,
    flushOnExit: false,
    fetch,
    sleep,
    random: () => 0.5,
    onDrop: (events, reason) => drops.push({ reason, keys: events.map((e) => e.idempotencyKey) }),
    onError: (e) => errors.push(e),
    shutdownTimeoutMs: 100,
    logger: {
      debug: (m) => logs.push({ level: 'debug', msg: m }),
      warn: (m) => logs.push({ level: 'warn', msg: m }),
      error: (m) => logs.push({ level: 'error', msg: m }),
    },
    ...opts,
  });
  live.push(core);
  return { core, calls, drops, errors, logs, delays };
}

/** A response whose headers arrive but whose body never does (unless the request is aborted). */
function stalledBody(signal: AbortSignal): CoreResponse {
  return {
    status: 202,
    headers: { get: () => null },
    text: () =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  };
}

/** Same, but the body promise ignores the abort signal entirely. */
function deafStalledBody(): CoreResponse {
  return { status: 202, headers: { get: () => null }, text: () => new Promise<string>(() => undefined) };
}

describe('edge case: request deadline covers reading the body', () => {
  test('a body that stalls after the headers is cut off at the deadline and retried', async () => {
    const r = rig((n, events, signal) => (n === 1 ? stalledBody(signal) : accepted(events.length)), { timeoutMs: 100 });
    r.core.enqueue(ev(1));
    const res = await r.core.flush();
    expect(res).toMatchObject({ sent: 1, queued: 0 });
    expect(r.calls.map((c) => c.keys)).toEqual([['k1'], ['k1']]);
    await r.core.shutdown();
  });

  test('a body read that ignores the abort signal still cannot hang flush() or shutdown()', async () => {
    const r = rig(() => deafStalledBody(), { timeoutMs: 100, maxRetries: 0, shutdownTimeoutMs: 300 });
    r.core.enqueue(ev(1));
    const res = await r.core.flush();
    expect(res).toMatchObject({ sent: 0, requeued: 1, queued: 1 });
    const done = await r.core.shutdown();
    expect(done.leftover).toBe(1);
    expect(r.drops).toEqual([{ reason: 'shutdown', keys: ['k1'] }]);
  });
});

describe('edge case: redirects are never followed', () => {
  test('requests ask fetch not to follow redirects', async () => {
    const r = rig((_n, events) => accepted(events.length));
    r.core.enqueue(ev(1));
    await r.core.flush();
    expect(r.calls[0].redirect).toBe('manual');
    await r.core.shutdown();
  });

  test('a 3xx is an outage: logged at ERROR with the target host, batch requeued, breaker open, nothing dropped', async () => {
    const r = rig(() => response(307, '', { location: 'http://evil.example:8080/v1/ingest/batch' }), { breakerInitialMs: 1e7 });
    r.core.enqueue(ev(1));
    const res = await r.core.flush();
    expect(res).toMatchObject({ sent: 0, failed: 0, requeued: 1, queued: 1 });
    expect(r.core.isBreakerOpen).toBe(true);
    expect(r.drops).toEqual([]);
    expect(r.calls).toHaveLength(1); // not retried as if transient
    const errorLines = r.logs.filter((l) => l.level === 'error').map((l) => l.msg);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('307');
    expect(errorLines[0]).toContain('evil.example');
    expect(errorLines[0]).not.toContain(API_KEY);
    expect(r.errors.map((e) => e.kind)).toEqual(['outage']);
    expect(r.errors[0].status).toBe(307);
    await r.core.shutdown();
  });
});

describe('edge case: every 5xx is retried', () => {
  test.each([501, 505, 599])('HTTP %i is retried, not dropped', async (status) => {
    const r = rig((n, events) => (n === 1 ? response(status) : accepted(events.length)));
    r.core.enqueue(ev(1));
    const res = await r.core.flush();
    expect(res).toMatchObject({ sent: 1, failed: 0 });
    expect(r.drops).toEqual([]);
    await r.core.shutdown();
  });
});

describe('edge case: per-event retryable in a 2xx', () => {
  const allRetryable = (events: Ev[]) =>
    response(202, {
      success: true,
      data: { accepted: 0, failed: events.length, errors: events.map((_e, index) => ({ index, message: 'busy', retryable: true })) },
    });

  test('re-sent after the jittered backoff, at most maxRetries times, then an outage', async () => {
    const delays: number[] = [];
    const r = rig((_n, events) => allRetryable(events), {
      maxRetries: 3,
      breakerInitialMs: 1e7,
      breakerMaxMs: 1e8,
      retryBaseMs: 500,
      sleep: (ms, signal) => {
        delays.push(ms);
        return holdLongSleep(ms, signal);
      },
    });
    r.core.enqueue(ev(1));
    void r.core.flush(); // wake the flusher; the retries then run on their own
    await waitFor(() => r.core.isBreakerOpen, 'breaker opens after the per-event retry cap');
    expect(r.calls).toHaveLength(4); // first send + 3 retries
    // Backoff grows with each retry: random 0.5 of 500·2^n.
    const backoffs = delays.filter((d) => d < 1e6);
    expect(backoffs.slice(0, 3)).toEqual([250, 500, 1000]);
    expect(r.errors.map((e) => e.kind)).toEqual(['outage']);
    expect(r.core.queued).toBe(1); // still queued, keys kept
    await r.core.shutdown();
  });

  test('a cap reached right after a 2xx does not reset the breaker: cooldowns keep growing', async () => {
    const r = rig((_n, events) => allRetryable(events), {
      maxRetries: 1,
      breakerInitialMs: 1000,
      breakerMaxMs: 1e9,
      retryBaseMs: 10,
      shutdownTimeoutMs: 0,
    });
    r.core.enqueue(ev(1));
    await waitFor(() => r.logs.filter((l) => l.msg.startsWith('breaker open')).length >= 4, 'four breaker cooldowns');
    const cooldowns = r.logs
      .filter((l) => l.msg.startsWith('breaker open'))
      .map((l) => Number(/in (\d+) ms/.exec(l.msg)![1]))
      .slice(0, 4);
    expect(cooldowns).toEqual([500, 1000, 2000, 4000]);
    await r.core.shutdown();
  });
});

describe('edge case: breaker cooldown', () => {
  test('is max(250 ms, random(0, ceiling)) even when the ceiling is below 250 ms', async () => {
    const r = rig(() => response(503), { maxRetries: 0, breakerInitialMs: 100, random: () => 0 });
    r.core.enqueue(ev(1));
    await waitFor(() => r.logs.some((l) => l.msg.startsWith('breaker open')), 'a breaker cooldown');
    const first = r.logs.find((l) => l.msg.startsWith('breaker open'))!.msg;
    expect(first).toContain('in 250 ms');
    await r.core.shutdown();
  });

  test('one successful send resets the cooldown ceiling', async () => {
    let failing = true;
    const r = rig((_n, events) => (failing ? response(503) : accepted(events.length)), {
      maxRetries: 0,
      breakerInitialMs: 1000,
      breakerMaxMs: 1e9,
      shutdownTimeoutMs: 0,
    });
    r.core.enqueue(ev(1));
    await waitFor(() => r.logs.filter((l) => l.msg.startsWith('breaker open')).length >= 3, 'three cooldowns');
    failing = false;
    await r.core.flush();
    expect(r.core.isBreakerOpen).toBe(false);
    failing = true;
    const before = r.logs.filter((l) => l.msg.startsWith('breaker open')).length;
    r.core.enqueue(ev(2));
    await r.core.flush();
    await waitFor(() => r.logs.filter((l) => l.msg.startsWith('breaker open')).length > before, 'a new cooldown');
    const next = r.logs.filter((l) => l.msg.startsWith('breaker open'))[before].msg;
    expect(next).toContain('in 500 ms'); // back to the first step
    await r.core.shutdown();
  });
});

describe('edge case: explicit flush() while the breaker is open', () => {
  test('makes an attempt now instead of waiting for the cooldown; an outage reopens it', async () => {
    let failing = true;
    const r = rig((_n, events) => (failing ? response(503) : accepted(events.length)), {
      maxRetries: 0,
      breakerInitialMs: 1e9, // the cooldown would never end on its own
      breakerMaxMs: 1e9,
      sleep: holdLongSleep,
    });
    r.core.enqueue(ev(1));
    await r.core.flush();
    expect(r.core.isBreakerOpen).toBe(true);
    const callsBefore = r.calls.length;
    await r.core.flush();
    expect(r.calls.length).toBeGreaterThan(callsBefore);
    expect(r.core.isBreakerOpen).toBe(true);
    failing = false;
    const res = await r.core.flush();
    expect(res.sent).toBe(1);
    expect(r.core.isBreakerOpen).toBe(false);
    await r.core.shutdown();
  });
});

describe('edge case: shutdown after an outage', () => {
  test('keeps retrying with backoff until the deadline and sends what it can', async () => {
    let failures = 6;
    const r = rig((_n, events) => (failures-- > 0 ? response(503) : accepted(events.length)), {
      maxRetries: 1,
      breakerInitialMs: 1e7,
      shutdownTimeoutMs: 5_000,
    });
    r.core.enqueue(ev(1));
    await r.core.flush();
    expect(r.core.isBreakerOpen).toBe(true);
    const done = await r.core.shutdown();
    expect(done).toMatchObject({ leftover: 0, timedOut: false });
    expect(r.core.sentCount).toBe(1);
    expect(r.drops).toEqual([]);
  });

  test('reports what is left as shutdown when the outage outlasts the deadline', async () => {
    const r = rig(() => response(503), { maxRetries: 1, breakerInitialMs: 1e7, shutdownTimeoutMs: 200 });
    r.core.enqueue(ev(1));
    r.core.enqueue(ev(2));
    const done = await r.core.shutdown();
    expect(done.leftover).toBe(2);
    expect(r.drops).toEqual([{ reason: 'shutdown', keys: ['k1', 'k2'] }]);
  });
});

describe('edge case: batch split in flight at shutdown', () => {
  test('every event of a 413-split batch is accounted for exactly once, and pending flush() callers complete', async () => {
    const r = rig(
      (_n, events, signal) => {
        if (events.length > 1) return response(413);
        if (events[0].idempotencyKey === 'k0') return accepted(1);
        // The second half hangs until close() cuts the request.
        return new Promise<CoreResponse>((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
      },
      { shutdownTimeoutMs: 200 },
    );
    for (let i = 0; i < 4; i++) r.core.enqueue(ev(i));
    const pending = r.core.flush();
    await waitFor(() => r.calls.some((c) => c.keys.length === 1 && c.keys[0] !== 'k0'), 'the unsent half is in flight');
    const done = await r.core.shutdown();
    await expect(pending).resolves.toBeDefined();
    const dropped = r.drops.flatMap((d) => d.keys);
    expect(r.core.sentCount + dropped.length).toBe(4);
    expect(new Set(dropped).size).toBe(dropped.length);
    expect(dropped).not.toContain('k0');
    expect(done.leftover).toBe(dropped.length);
  });
});

describe('edge case: unserializable event', () => {
  test.each([
    ['BigInt', { big: BigInt(1) }],
    ['cycle', (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })()],
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
  ])('%s in metadata is dropped as invalid at enqueue and never reaches a batch', async (_name, metadata) => {
    const r = rig((_n, events) => accepted(events.length));
    expect(r.core.enqueue(ev(1, metadata as Record<string, unknown>))).toBe(false);
    r.core.enqueue(ev(2));
    const res = await r.core.flush();
    expect(res.sent).toBe(1);
    expect(r.calls.flatMap((c) => c.keys)).toEqual(['k2']);
    expect(r.drops).toEqual([{ reason: 'invalid', keys: ['k1'] }]);
    expect(r.core.droppedCount).toBe(1);
    await r.core.shutdown();
  });

  test('the event is snapshotted at enqueue: a later mutation does not change what is sent', async () => {
    let body = '';
    const r = rig((_n, events) => {
      body = JSON.stringify(events);
      return accepted(events.length);
    });
    const e = ev(1);
    r.core.enqueue(e);
    e.quantity = 99;
    await r.core.flush();
    expect(JSON.parse(body)[0].quantity).toBe(1);
    await r.core.shutdown();
  });
});

describe('edge case: callbacks may call flush() or close()', () => {
  test('onDrop calling flush() and onError calling shutdown() do not deadlock; throws are caught', async () => {
    let core!: TransportCore<Ev>;
    let flushFromHook: Promise<unknown> | undefined;
    let shutdownFromHook: Promise<unknown> | undefined;
    const { sleep } = instantSleep();
    core = new TransportCore<Ev>({
      baseUrl: 'https://ingest.example',
      apiKey: API_KEY,
      flushIntervalMs: 1e9,
      flushOnExit: false,
      sleep,
      fetch: async () => response(400, { detail: 'bad' }),
      onDrop: () => {
        flushFromHook = core.flush();
        throw new Error('hook bug');
      },
      onError: () => {
        shutdownFromHook = core.shutdown();
        throw new Error('hook bug');
      },
      logger: { debug: () => undefined, warn: () => undefined, error: () => undefined },
    });
    core.enqueue(ev(1));
    await core.flush();
    await expect(flushFromHook).resolves.toBeDefined();
    await expect(shutdownFromHook).resolves.toMatchObject({ queued: 0 });
  });
});

describe('edge case: 2xx with errors[] but failed missing or 0', () => {
  test.each([{}, { failed: 0 }])('errors[] is authoritative (%j)', async (extra) => {
    const r = rig((_n, events) =>
      response(202, {
        success: true,
        data: { accepted: events.length, ...extra, errors: [{ index: 0, message: 'bad metric', retryable: false }, { index: 1, message: 'busy', retryable: true }] },
      }),
    );
    r.core.enqueue(ev(0));
    r.core.enqueue(ev(1));
    r.core.enqueue(ev(2));
    const res = await r.core.flush();
    expect(res).toMatchObject({ sent: 1, failed: 1, requeued: 1 });
    expect(r.drops).toEqual([{ reason: 'rejected', keys: ['k0'] }]);
    expect(r.core.queued).toBe(1);
    await r.core.shutdown();
  });
});

describe('edge case: Retry-After', () => {
  test('fractional delta-seconds and an HTTP-date in the past', () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    expect(parseRetryAfter('1.5', now, 60_000)).toBe(1500);
    expect(parseRetryAfter('Mon, 26 Oct 2026 11:00:00 GMT', now, 60_000)).toBe(0);
  });
});

describe('edge case: second close()', () => {
  test('returns the first close result and never drains twice', async () => {
    const r = rig(() => response(503), { maxRetries: 0, breakerInitialMs: 1e7, shutdownTimeoutMs: 100 });
    r.core.enqueue(ev(1));
    const a = r.core.shutdown();
    const b = r.core.shutdown();
    expect(b).toBe(a);
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb).toBe(ra);
    await expect(r.core.shutdown()).resolves.toBe(ra);
    expect(r.drops.filter((d) => d.reason === 'shutdown')).toHaveLength(1);
  });
});

describe('against the mock ingestor (real HTTP)', () => {
  let mock: MockIngestor;
  beforeAll(async () => {
    mock = await startMockIngestor(__dirname);
  });
  afterAll(async () => {
    await mock.stop();
  });
  beforeEach(async () => {
    await mock.reset();
  });

  function realCore(extra: Partial<ConstructorParameters<typeof TransportCore<Ev>>[0]> = {}) {
    const drops: Array<{ reason: CoreDropReason; keys: string[] }> = [];
    const logs: string[] = [];
    const core = new TransportCore<Ev>({
      baseUrl: mock.url,
      apiKey: 'it-key',
      flushIntervalMs: 1e9,
      flushOnExit: false,
      retryBaseMs: 5,
      maxRetries: 1,
      timeoutMs: 300,
      breakerInitialMs: 1e7,
      onDrop: (events, reason) => drops.push({ reason, keys: events.map((e) => e.idempotencyKey) }),
      logger: { debug: () => undefined, warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      ...extra,
    });
    return { core, drops, logs };
  }

  test('stalled body: cut off at the deadline, re-sent, recovered without loss', async () => {
    await mock.faults([{ stallBody: true, times: 1 }]);
    const { core } = realCore();
    core.enqueue(ev(1));
    const res = await core.flush();
    expect(res).toMatchObject({ sent: 1, queued: 0 });
    const state = await mock.state();
    expect(state.requests.map((q) => q.status)).toEqual([-3, 202]);
    await core.shutdown();
  });

  test('dripping body: a total deadline fires even though each byte arrives in time', async () => {
    await mock.faults([{ dripMs: 50, times: 1 }]);
    const { core } = realCore();
    core.enqueue(ev(1));
    const started = Date.now();
    const res = await core.flush();
    expect(res).toMatchObject({ sent: 1, queued: 0 });
    const state = await mock.state();
    expect(state.requests.map((q) => q.status)).toEqual([-3, 202]);
    expect(Date.now() - started).toBeLessThan(3_000); // the dripped body alone takes ~4 s
    await core.shutdown();
  });

  test('redirect: not followed, the batch stays queued, the target host is logged, the key is not', async () => {
    await mock.faults([{ status: 307, location: 'http://127.0.0.1:1/v1/ingest/batch', times: -1 }]);
    const { core, drops, logs } = realCore();
    core.enqueue(ev(1));
    const res = await core.flush();
    expect(res).toMatchObject({ sent: 0, requeued: 1, queued: 1 });
    expect(drops).toEqual([]);
    expect(logs.some((l) => l.includes('127.0.0.1:1'))).toBe(true);
    expect(logs.join('\n')).not.toContain('it-key');
    const state = await mock.state();
    expect(state.requests).toHaveLength(1);
    await mock.clearFaults();
    const after = await core.flush();
    expect(after).toMatchObject({ sent: 1, queued: 0 });
    await core.shutdown();
  });

  test('exit flush: the process stays alive through a retry and delivers the batch', async () => {
    // Compile the core to a temp CommonJS file and run it in a child process
    // that just tracks one event and lets Node exit on its own.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aforo-exit-'));
    try {
      const src = fs.readFileSync(path.join(__dirname, '../src/transport-core/core.ts'), 'utf8');
      const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
      fs.writeFileSync(path.join(dir, 'core.js'), js);
      fs.writeFileSync(
        path.join(dir, 'main.js'),
        `const { TransportCore } = require('./core.js');
         const core = new TransportCore({ baseUrl: process.argv[2], apiKey: 'it-key', flushIntervalMs: 60000,
           retryBaseMs: 300, retryMaxDelayMs: 300, maxRetries: 2, random: () => 0.99, shutdownTimeoutMs: 5000 });
         core.enqueue({ idempotencyKey: 'exit-1', customerId: 'c1', metricName: 'api_calls', quantity: 1, occurredAt: new Date().toISOString() });`,
      );
      await mock.faults([{ status: 503, times: 1 }]);
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [path.join(dir, 'main.js'), mock.url], { stdio: 'ignore' });
        child.on('exit', (c) => resolve(c));
      });
      expect(code).toBe(0);
      const state = await mock.state();
      expect(state.requests.map((q) => q.status)).toEqual([503, 202]);
      expect(state.uniqueKeys).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
