/**
 * Transport core hooks: onAccepted (the parsed 2xx body of every accepted
 * batch) and the structured onError (`CoreTransportError.kind` + events).
 * Injected fetch / sleep / random only: nothing here waits on the wall clock.
 */
import { TransportCore, CoreTransportError, CoreFetch, CoreResponse, CoreSleep } from '../src/transport-core/core';
import { bodyJson } from './helpers/request-body';

interface Ev {
  idempotencyKey: string;
  customerId: string;
  metricName: string;
  quantity: number;
}

const API_KEY = 'sk_live_hooks_secret_456';
const ev = (i: number): Ev => ({ idempotencyKey: `k${i}`, customerId: 'c1', metricName: 'api_calls', quantity: 1 });

function response(status: number, body: unknown = {}): CoreResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Short waits resolve at once; long ones (idle interval, breaker) wait for their wake signal. */
const sleep: CoreSleep = (ms, signal) =>
  ms < 1e6
    ? Promise.resolve()
    : new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });

function make(
  answer: (call: number, events: Ev[]) => Promise<CoreResponse> | CoreResponse,
  opts: Partial<ConstructorParameters<typeof TransportCore<Ev>>[0]> = {},
) {
  const accepted: Array<{ body: unknown; keys: string[] }> = [];
  const errors: CoreTransportError<Ev>[] = [];
  const plainErrors: Error[] = [];
  let calls = 0;
  const fetch: CoreFetch = async (_url, init) => {
    calls++;
    return answer(calls, bodyJson(init).events as Ev[]);
  };
  const core = new TransportCore<Ev>({
    baseUrl: 'https://ingest.example',
    apiKey: API_KEY,
    flushIntervalMs: 1e9,
    breakerInitialMs: 1e7,
    breakerMaxMs: 1e8,
    flushOnExit: false,
    // Tests that end during an outage keep retrying until this deadline; keep it short.
    shutdownTimeoutMs: 20,
    fetch,
    sleep,
    random: () => 0.5,
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
    onAccepted: (body, events) => accepted.push({ body, keys: events.map((e) => e.idempotencyKey) }),
    onError: (err) => {
      if (err instanceof CoreTransportError) errors.push(err as CoreTransportError<Ev>);
      else plainErrors.push(err);
    },
    ...opts,
  });
  return { core, accepted, errors, plainErrors, calls: () => calls };
}

describe('transport core: onAccepted', () => {
  test('receives the envelope-unwrapped data object and the batch after each 2xx', async () => {
    const h = make((_n, events) =>
      response(202, { success: true, data: { accepted: events.length, failed: 0, errors: [], killedSessionIds: ['s1'] } }),
    );
    h.core.enqueue(ev(1));
    h.core.enqueue(ev(2));
    await h.core.flush();
    expect(h.accepted).toEqual([{ body: { accepted: 2, failed: 0, errors: [], killedSessionIds: ['s1'] }, keys: ['k1', 'k2'] }]);
    await h.core.shutdown();
  });

  test('a body without the envelope is passed as is; an empty body is passed as undefined', async () => {
    const h = make((n) => (n === 1 ? response(200, { accepted: 1, killedSessionIds: [] }) : response(204, '')));
    h.core.enqueue(ev(1));
    await h.core.flush();
    h.core.enqueue(ev(2));
    await h.core.flush();
    expect(h.accepted).toEqual([
      { body: { accepted: 1, killedSessionIds: [] }, keys: ['k1'] },
      { body: undefined, keys: ['k2'] },
    ]);
    expect(h.core.sentCount).toBe(2);
    await h.core.shutdown();
  });

  test('is called once per accepted chunk when a 413 splits the batch', async () => {
    const h = make((_n, events) => (events.length > 1 ? response(413) : response(202, { data: { accepted: 1 } })));
    h.core.enqueue(ev(1));
    h.core.enqueue(ev(2));
    await h.core.flush();
    expect(h.accepted.map((a) => a.keys)).toEqual([['k1'], ['k2']]);
    await h.core.shutdown();
  });

  test('is not called for a rejected or failed batch', async () => {
    const h = make(() => response(400, { detail: 'bad' }));
    h.core.enqueue(ev(1));
    await h.core.flush();
    expect(h.accepted).toEqual([]);
    await h.core.shutdown();
  });

  test('a throwing onAccepted is caught; the batch still counts as sent', async () => {
    const debug: string[] = [];
    const h = make((_n, events) => response(202, { data: { accepted: events.length } }), {
      onAccepted: () => {
        throw new Error('handler bug');
      },
      logger: { debug: (m) => debug.push(m), warn: () => {}, error: () => {} },
    });
    h.core.enqueue(ev(1));
    const r = await h.core.flush();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(debug.some((m) => m.includes('onAccepted hook threw'))).toBe(true);
    await h.core.shutdown();
  });
});

describe('transport core: structured onError', () => {
  test('outage: kind "outage", the kept events, a readable message', async () => {
    const h = make(() => {
      throw new TypeError('fetch failed');
    });
    h.core.enqueue(ev(1));
    h.core.enqueue(ev(2));
    await h.core.flush();
    expect(h.plainErrors).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toBeInstanceOf(Error);
    expect(h.errors[0]).toMatchObject({ kind: 'outage', willRetry: true });
    expect(h.errors[0].events.map((e) => e.idempotencyKey)).toEqual(['k1', 'k2']);
    expect(h.errors[0].message).toMatch(/Aforo ingestor unavailable/);
    await h.core.shutdown();
  });

  test('401 / 403: kind "auth" with the HTTP status, once per breaker opening', async () => {
    let status = 401;
    const h = make((_n, events) => (status === 202 ? response(202, { data: { accepted: events.length } }) : response(status)));
    h.core.enqueue(ev(1));
    await h.core.flush();
    await h.core.flush();
    expect(h.errors.map((e) => e.kind)).toEqual(['auth']);
    expect(h.errors[0]).toMatchObject({ status: 401, willRetry: true });
    expect(h.errors[0].message).toMatch(/HTTP 401/);
    expect(h.errors[0].message).not.toContain(API_KEY);
    status = 202;
    await h.core.flush();
    status = 403;
    h.core.enqueue(ev(2));
    await h.core.flush();
    expect(h.errors.map((e) => [e.kind, e.status])).toEqual([
      ['auth', 401],
      ['auth', 403],
    ]);
    await h.core.shutdown();
  });

  test('an outage that turns into 401 while the breaker is open still reports "auth"', async () => {
    let status = 503;
    const h = make(() => response(status));
    h.core.enqueue(ev(1));
    await h.core.flush();
    status = 401;
    await h.core.flush();
    expect(h.errors.map((e) => e.kind)).toEqual(['outage', 'auth']);
    await h.core.shutdown();
  });

  test('other 4xx: kind "rejected" with the dropped events and status', async () => {
    const h = make(() => response(422, { detail: 'bad metric' }));
    h.core.enqueue(ev(7));
    await h.core.flush();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ kind: 'rejected', status: 422, willRetry: false });
    expect(h.errors[0].events.map((e) => e.idempotencyKey)).toEqual(['k7']);
    expect(h.errors[0].message).toMatch(/bad metric/);
    await h.core.shutdown();
  });

  test('2xx per-event rejection and a single-event 413: kind "rejected" with those events', async () => {
    const h = make((n, events) =>
      n === 1
        ? response(202, { data: { accepted: 1, failed: 1, errors: [{ index: 1, message: 'bad', retryable: false }] } })
        : events.length >= 1
          ? response(413)
          : response(202),
    );
    h.core.enqueue(ev(1));
    h.core.enqueue(ev(2));
    await h.core.flush();
    h.core.enqueue(ev(3));
    await h.core.flush();
    expect(h.errors.map((e) => [e.kind, e.events.map((x) => x.idempotencyKey)])).toEqual([
      ['rejected', ['k2']],
      ['rejected', ['k3']],
    ]);
    expect(h.errors[1].status).toBe(413);
    await h.core.shutdown();
  });

  test('shutdown leftovers: kind "shutdown" with the leftover events', async () => {
    const h = make(() => response(503), {
      shutdownTimeoutMs: 30,
      fetch: (_url, init) =>
        new Promise<CoreResponse>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    h.core.enqueue(ev(1));
    h.core.enqueue(ev(2));
    await h.core.shutdown();
    const shutdown = h.errors.filter((e) => e.kind === 'shutdown');
    expect(shutdown).toHaveLength(1);
    expect(shutdown[0].events.map((e) => e.idempotencyKey)).toEqual(['k1', 'k2']);
    expect(shutdown[0].willRetry).toBe(false);
  });

  test('enqueue after shutdown: kind "closed" with the event (first, then every 1000th)', async () => {
    const h = make((_n, events) => response(202, { data: { accepted: events.length } }));
    await h.core.shutdown();
    for (let i = 0; i < 1001; i++) h.core.enqueue(ev(i));
    const closed = h.errors.filter((e) => e.kind === 'closed');
    expect(closed).toHaveLength(2);
    expect(closed[0].events.map((e) => e.idempotencyKey)).toEqual(['k0']);
    expect(closed[0].willRetry).toBe(false);
  });

  test('retryable per-event failures that never clear: kind "outage"', async () => {
    const h = make(() => response(202, { data: { accepted: 0, failed: 1, errors: [{ index: 0, message: 'busy', retryable: true }] } }), {
      maxRetries: 1,
    });
    h.core.enqueue(ev(1));
    await h.core.flush();
    await h.core.flush();
    expect(h.errors.map((e) => e.kind)).toEqual(['outage']);
    await h.core.shutdown();
  });

  test('CoreTransportError is exported, an Error, and keeps the API key out of its JSON', () => {
    const err = new CoreTransportError<Ev>('rejected', 'Aforo ingestor rejected 1 event', [ev(1)], { status: 400 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CoreTransportError');
    expect(err).toMatchObject({ kind: 'rejected', status: 400, willRetry: false });
    expect(JSON.stringify(err)).not.toContain(API_KEY);
    expect(new CoreTransportError('outage', 'x', []).willRetry).toBe(true);
    expect(new CoreTransportError('auth', 'x', []).willRetry).toBe(true);
  });
});

describe('transport core: breaker cooldown drawn as 0', () => {
  test('a zero cooldown still resends without new traffic', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const h = make(
      (n, events) => {
        calls = n;
        return n <= 4 ? response(503) : response(202, { data: { accepted: events.length } });
      },
      {
        random: () => 0, // every jitter draw, the breaker cooldown included, comes out at its floor
        breakerInitialMs: 1000,
        breakerMaxMs: 1000,
        sleep: (ms, signal) => {
          sleeps.push(ms);
          return ms < 1e6 ? Promise.resolve() : new Promise((r) => signal?.addEventListener('abort', () => r(), { once: true }));
        },
      },
    );
    h.core.enqueue(ev(1));
    h.core.enqueue(ev(2));
    const first = await h.core.flush();
    expect(first.requeued).toBe(2);
    // No enqueue, no flush(), and the idle interval (1e9 ms) never fires: only the breaker can resend.
    for (let i = 0; i < 1000 && h.core.sentCount < 2; i++) await new Promise((r) => setImmediate(r));
    expect(h.core.sentCount).toBe(2);
    expect(h.core.queued).toBe(0);
    expect(calls).toBe(5);
    expect(sleeps.some((ms) => ms > 0 && ms < 1e6)).toBe(true); // the cooldown wait has a floor, never 0
    await h.core.shutdown();
  });
});
