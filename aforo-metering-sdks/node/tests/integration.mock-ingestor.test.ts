/**
 * AforoClient against the repo's fault-injecting mock ingestor (real HTTP).
 * Waits on conditions and on the client's own promises, never on fixed sleeps.
 */
import { AforoClient } from '../src/client';
import { ResolvedEvent, DropReason } from '../src/types';
import { startMockIngestor, MockIngestor } from './support/mock-ingestor';

jest.setTimeout(30_000);

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

function client(extra: Partial<ConstructorParameters<typeof AforoClient>[0]> = {}) {
  return new AforoClient({
    apiKey: 'it-key',
    baseUrl: mock.url,
    flushInterval: 60_000,
    retryBaseMs: 5,
    maxRetries: 2,
    timeout: 2_000,
    flushOnExit: false,
    ...extra,
  });
}

async function trackN(c: AforoClient, n: number, prefix = 'k'): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const key = `${prefix}-${i}`;
    keys.push(key);
    await c.track({ customerId: 'cust_1', metricName: 'api_calls', idempotencyKey: key });
  }
  return keys;
}

test('outage then recovery: nothing lost, keys unchanged', async () => {
  await mock.faults([{ status: 503, times: -1 }]);
  const drops: DropReason[] = [];
  const c = client({ onDrop: (_e, r) => drops.push(r) });
  const keys = await trackN(c, 5);
  const during = await c.flush();
  expect(during).toMatchObject({ sent: 0, requeued: 5, queued: 5 });

  await mock.clearFaults();
  const after = await c.flush();
  expect(after).toMatchObject({ sent: 5, queued: 0 });

  const state = await mock.state();
  expect(state.uniqueKeys).toBe(5);
  // Faulted requests are answered before the mock reads keys; the accepted one carries the originals.
  expect(state.requests.filter((r) => r.status === 202).map((r) => r.idempotencyKeys)).toEqual([keys]);
  expect(state.requests.length).toBe(4); // 3 attempts during the outage + the recovery probe
  expect(drops).toEqual([]);
  expect(state.requests.every((r) => r.contentEncoding === null && r.apiKeyPresent)).toBe(true);
  expect(state.requests[0].userAgent).toMatch(/^aforo-node\//);
  await c.shutdown();
});

test('429 with Retry-After in delta-seconds and HTTP-date forms', async () => {
  const soon = new Date(Date.now() + 1000).toUTCString();
  await mock.faults([
    { status: 429, retryAfter: '1' },
    { status: 429, retryAfter: soon },
  ]);
  const c = client();
  const keys = await trackN(c, 2);
  const r = await c.flush();
  expect(r.sent).toBe(2);
  const state = await mock.state();
  expect(state.requests.map((q) => q.status)).toEqual([429, 429, 202]);
  expect(state.requests[2].idempotencyKeys).toEqual(keys);
  await c.shutdown();
});

test('a hung response is cut by the request timeout and retried', async () => {
  await mock.faults([{ hang: true }]);
  const c = client({ timeout: 200 });
  await trackN(c, 1);
  const r = await c.flush();
  expect(r.sent).toBe(1);
  const state = await mock.state();
  expect(state.requests.map((q) => q.status)).toEqual([-2, 202]);
  await c.shutdown();
});

test('shutdown honours its deadline and reports leftovers', async () => {
  await mock.faults([{ hang: true, times: -1 }]);
  const drops: Array<{ reason: DropReason; keys: string[] }> = [];
  const c = client({
    shutdownTimeoutMs: 300,
    onDrop: (events: ResolvedEvent[], reason) => drops.push({ reason, keys: events.map((e) => e.idempotencyKey) }),
  });
  const keys = await trackN(c, 4);
  const started = Date.now();
  await c.shutdown();
  expect(Date.now() - started).toBeLessThan(3000);
  expect(drops).toEqual([{ reason: 'shutdown', keys }]);
  expect(c.droppedCount).toBe(4);
  await mock.clearFaults();
});

test('one request in flight at a time, even under a burst', async () => {
  await mock.faults([{ delayMs: 20, times: -1 }]);
  const c = client({ flushCount: 100 });
  await trackN(c, 1000);
  await c.flush();
  await mock.clearFaults();
  const state = await mock.state();
  expect(state.uniqueKeys).toBe(1000);
  expect(state.maxInFlight).toBe(1);
  await c.shutdown();
});

test('overflow while the breaker is open evicts the oldest', async () => {
  await mock.faults([{ status: 503, times: -1 }]);
  const drops: Array<{ reason: DropReason; keys: string[] }> = [];
  const c = client({
    maxQueueSize: 3,
    onDrop: (events, reason) => drops.push({ reason, keys: events.map((e) => e.idempotencyKey) }),
  });
  await trackN(c, 3, 'a');
  await c.flush(); // outage: requeued, breaker open
  await trackN(c, 2, 'b');
  expect(drops.flatMap((d) => d.keys)).toEqual(['a-0', 'a-1']);
  expect(drops.every((d) => d.reason === 'overflow')).toBe(true);
  await mock.clearFaults();
  await c.flush();
  const state = await mock.state();
  expect(state.events.map((e) => e.idempotencyKey)).toEqual(['a-2', 'b-0', 'b-1']);
  await c.shutdown();
});

test('per-event retryable failure is resent with the same key', async () => {
  await mock.faults([{ perEvent: [{ index: 1, message: 'busy', retryable: true }] }]);
  const c = client();
  const keys = await trackN(c, 3);
  await c.flush();
  await c.flush();
  const state = await mock.state();
  expect(state.requests[1].idempotencyKeys).toEqual([keys[1]]);
  expect(state.uniqueKeys).toBe(3);
  await c.shutdown();
});
