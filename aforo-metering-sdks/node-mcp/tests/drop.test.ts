/**
 * Delivery and drop accounting against the repo's fault-injecting mock
 * ingestor (real HTTP, no fetch stubs): an outage keeps events and re-sends
 * them with the same keys, a non-retryable 4xx drops them as 'rejected', 401
 * is an outage, per-event `retryable` failures are re-queued, a slow response
 * past the request timeout is retried, shutdown honours its deadline, overflow
 * drops the oldest while the ingestor is down, and only one request is ever in
 * flight. Retries are disabled (maxRetries: 0) and flushes are explicit, so no
 * test waits on a backoff timer.
 */
import { AforoMcpBilling, type McpDropReason, type UsageEvent } from '../src/index';
import { startMockIngestor, waitFor, type MockIngestor } from './support/mock-ingestor';

jest.setTimeout(20_000);

describe('AforoMcpBilling delivery (mock ingestor)', () => {
  let mock: MockIngestor;
  let created: AforoMcpBilling[];
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeAll(async () => { mock = await startMockIngestor(); });
  afterAll(async () => { await mock.stop(); });
  beforeEach(async () => {
    await mock.reset();
    created = [];
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    await mock.clearFaults();
    for (const b of created) await b.shutdown();
    warn.mockRestore();
    error.mockRestore();
  });

  function billing(extra: Record<string, unknown> = {}) {
    const drops: Array<{ events: UsageEvent[]; reason: McpDropReason }> = [];
    const errors: Error[] = [];
    const b = new AforoMcpBilling({
      tenantId: 'tenant_test', productId: 'prod_test', apiKey: 'sk_test', ingestorUrl: mock.url,
      customerId: 'cust_1', flushIntervalMs: 3_600_000, heartbeatEnabled: false, maxRetries: 0,
      flushOnExit: false,
      onDrop: (events, reason) => drops.push({ events, reason }),
      onError: (e) => errors.push(e),
      ...extra,
    });
    created.push(b);
    return { b, drops, errors };
  }

  const record = (b: AforoMcpBilling, n: number) => {
    for (let i = 0; i < n; i++) b.recordToolInvocation(`tool_${i}`, 'agent_1', 'sess_1', 'SUCCESS', 5);
  };

  test('an outage keeps the events; the next flush delivers them with the same keys', async () => {
    const { b, drops, errors } = billing();
    const sentKeys: string[][] = [];
    const realFetch = global.fetch;
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      sentKeys.push(JSON.parse(init.body).events.map((e: UsageEvent) => e.idempotencyKey));
      return realFetch(url, init);
    });
    await mock.faults([{ status: 503, times: 1 }]);
    record(b, 3);
    const first = await b.flush();
    expect(first).toMatchObject({ sent: 0, requeued: 3, queued: 3 });
    expect(b.droppedCount).toBe(0);
    expect(drops).toEqual([]);
    expect(errors[0].message).toMatch(/unavailable/);

    const second = await b.flush();
    expect(second).toMatchObject({ sent: 3, queued: 0 });
    const state = await mock.state();
    expect(state.requests.map((r) => r.status)).toEqual([503, 202]);
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).toEqual(sentKeys[0]);
    expect(state.requests[1].idempotencyKeys).toEqual(sentKeys[0]);
    expect(state.acceptedCount).toBe(3);
    spy.mockRestore();
  });

  test('a network reset is an outage too, not a drop', async () => {
    const { b, drops } = billing();
    await mock.faults([{ reset: true, times: 1 }]);
    record(b, 1);
    expect(await b.flush()).toMatchObject({ requeued: 1 });
    expect(drops).toEqual([]);
    expect(await b.flush()).toMatchObject({ sent: 1 });
  });

  test('401 is treated as an outage (a fixed key must not lose usage) and logged once', async () => {
    const { b, drops } = billing();
    await mock.faults([{ status: 401, times: 2 }]);
    record(b, 1);
    await b.flush();
    await b.flush();
    expect(drops).toEqual([]);
    expect(error.mock.calls.filter((c) => /API key is wrong or revoked/.test(String(c[0])))).toHaveLength(1);
    expect(await b.flush()).toMatchObject({ sent: 1 });
  });

  test('a non-retryable 4xx drops the batch as "rejected" without retrying', async () => {
    const { b, drops, errors } = billing({ maxRetries: 3 });
    await mock.faults([{ status: 422, times: 1 }]);
    record(b, 2);
    expect(await b.flush()).toMatchObject({ failed: 2 });
    expect((await mock.state()).requests).toHaveLength(1);
    expect(b.droppedCount).toBe(2);
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('rejected');
    expect(drops[0].events.every((e) => typeof e.idempotencyKey === 'string')).toBe(true);
    expect(errors.some((e) => /422/.test(e.message))).toBe(true);
  });

  test('per-event failures: retryable ones are re-sent with their keys, the others dropped', async () => {
    const { b, drops } = billing();
    await mock.faults([{ perEvent: [{ index: 0, message: 'try later', retryable: true }, { index: 1, message: 'unknown metric', retryable: false }] }]);
    record(b, 3);
    const first = await b.flush();
    expect(first).toMatchObject({ sent: 1, failed: 1, requeued: 1 });
    expect(drops).toEqual([{ events: [expect.objectContaining({ toolName: 'tool_1' })], reason: 'rejected' }]);
    const keyOfFirst = (await mock.state()).requests[0].idempotencyKeys[0];
    await b.flush();
    const state = await mock.state();
    expect(state.requests[1].idempotencyKeys).toEqual([keyOfFirst]);
    expect(state.acceptedCount).toBe(2);
  });

  test('a response slower than the request timeout is retried, not lost', async () => {
    const { b, drops } = billing({ timeoutMs: 100 });
    await mock.faults([{ delayMs: 600, times: 1 }]);
    record(b, 1);
    expect(await b.flush()).toMatchObject({ requeued: 1 });
    expect(drops).toEqual([]);
    expect(await b.flush()).toMatchObject({ sent: 1 });
    // The slow answer may also have been accepted: the ingestor deduplicates on the key.
    expect((await mock.state()).uniqueKeys).toBe(1);
  });

  test('shutdown with a request in flight stops at its deadline and reports the leftovers', async () => {
    const { b, drops } = billing({ shutdownTimeoutMs: 300 });
    await mock.faults([{ hang: true, times: -1 }]);
    record(b, 2);
    const started = Date.now();
    await b.shutdown();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(drops).toEqual([{ events: expect.any(Array), reason: 'shutdown' }]);
    expect(drops[0].events).toHaveLength(2);
    expect(b.droppedCount).toBe(2);
    // After shutdown a new call is counted and reported as 'closed', not thrown.
    b.recordToolInvocation('late', 'agent_1', undefined, 'SUCCESS', 1);
    expect(drops[1].reason).toBe('closed');
  });

  test('while the ingestor is down the queue is bounded: the oldest event is dropped as "overflow"', async () => {
    const { b, drops } = billing({ maxQueueSize: 2 });
    await mock.faults([{ status: 503, times: -1 }]);
    record(b, 2);
    await b.flush();
    b.recordToolInvocation('newest', 'agent_1', 'sess_1', 'SUCCESS', 1);
    expect(drops).toEqual([{ events: [expect.objectContaining({ toolName: 'tool_0' })], reason: 'overflow' }]);
    expect(b.queuedCount).toBe(2);
  });

  test('one flusher: a burst never has more than one request in flight', async () => {
    const { b } = billing({ flushCount: 10, flushIntervalMs: 20 });
    await mock.faults([{ delayMs: 30, times: 5 }]);
    record(b, 55);
    await b.flush();
    await waitFor(async () => (await mock.state()).acceptedCount >= 55, 'all events accepted', 5000).catch(async (e) => {
      const st = await mock.state();
      throw new Error(`${e.message}: ${JSON.stringify({ accepted: st.acceptedCount, reqs: st.requests.map((r) => [r.status, r.eventCount]), q: b.queuedCount })}`);
    });
    expect((await mock.state()).maxInFlight).toBe(1);
  });

  test('a throwing onDrop never breaks flushing; the drop is still counted', async () => {
    const { b } = billing({ onDrop: () => { throw new Error('hook bug'); } });
    await mock.faults([{ status: 400, times: 1 }]);
    record(b, 1);
    await expect(b.flush()).resolves.toMatchObject({ failed: 1 });
    expect(b.droppedCount).toBe(1);
  });

  test('happy path: everything accepted, nothing dropped, no warnings', async () => {
    const { b, drops } = billing();
    record(b, 4);
    expect(await b.flush()).toMatchObject({ sent: 4, failed: 0 });
    expect(drops).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    const state = await mock.state();
    expect(state.requests[0].apiKeyPresent).toBe(true);
    expect(state.requests[0].userAgent).toMatch(/^aforo-mcp-metering-node\/2\./);
  });

  test('refuses a plain-http ingestor on a non-local host unless allowInsecureHttp', () => {
    const base = { tenantId: 't', productId: 'p', apiKey: 'k', customerId: 'c', flushOnExit: false };
    expect(() => new AforoMcpBilling({ ...base, ingestorUrl: 'http://ingest.example.com' })).toThrow(/https/);
    const ok = new AforoMcpBilling({ ...base, ingestorUrl: 'http://ingest.example.com', allowInsecureHttp: true });
    created.push(ok);
  });

  test('the API key never appears in inspect(), JSON or a log line', async () => {
    const { b } = billing({ apiKey: 'sk_secret_value_123' });
    await mock.faults([{ status: 500, times: 1 }]);
    record(b, 1);
    await b.flush();
    const util = require('util');
    const seen = [util.inspect(b, { depth: 5 }), JSON.stringify(b), ...warn.mock.calls.flat(), ...error.mock.calls.flat()].map(String).join('\n');
    expect(seen).not.toContain('sk_secret_value_123');
  });
});
