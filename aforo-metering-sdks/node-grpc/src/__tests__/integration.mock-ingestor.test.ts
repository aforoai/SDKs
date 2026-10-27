/**
 * AforoGrpcBilling against the repo's fault-injecting mock ingestor (real HTTP,
 * real timers). Waits on the SDK's own promises, never on fixed sleeps.
 */
import { AforoGrpcBilling, type DropReason } from '../index';
import { startMockIngestor, type MockIngestor } from '../../test-support/mock-ingestor';

jest.setTimeout(30_000);


let mock: MockIngestor;
/** Let the wrapped handlers' promise callbacks run (they record the event). */
const settled = () => new Promise((r) => setImmediate(r));
beforeAll(async () => {
  mock = await startMockIngestor(__dirname);
});
afterAll(async () => {
  await mock.stop();
});
beforeEach(async () => {
  await mock.reset();
});

function billing(extra: Record<string, unknown> = {}) {
  return new AforoGrpcBilling({
    tenantId: 't1',
    productId: 'p1',
    apiKey: 'it-key',
    ingestorUrl: mock.url,
    flushIntervalMs: 60_000,
    serviceName: 'acme.v1.UserService',
    customerResolver: () => 'cust_1',
    timeoutMs: 2000,
    flushOnExit: false,
    onError: () => undefined,
    ...extra,
  } as any);
}

/** `frames + 1` unary calls, each one event. */
function record(b: AforoGrpcBilling, frames: number): void {
  const wrapped = b.wrapUnary('GetUser', async () => ({ ok: true }));
  for (let i = 0; i <= frames; i++) wrapped({ metadata: { getMap: () => ({}) } } as any, () => undefined);
}

test('outage then recovery: nothing lost, accepted keys are the originals', async () => {
  await mock.faults([{ status: 503, times: -1 }]);
  const drops: DropReason[] = [];
  const b = billing({ onDrop: (_e: unknown, r: DropReason) => drops.push(r) });
  record(b, 4);
  await settled();
  expect(await b.flush()).toMatchObject({ sent: 0, requeued: 5, queued: 5 });
  await mock.clearFaults();
  expect(await b.flush()).toMatchObject({ sent: 5, queued: 0 });
  const state = await mock.state();
  expect(state.uniqueKeys).toBe(5);
  expect(state.duplicates).toBe(0);
  expect(drops).toEqual([]);
  expect(state.requests.every((r) => r.contentEncoding === null)).toBe(true);
  expect(state.requests[0].userAgent).toMatch(/^aforo-grpc-metering\//);
  await b.shutdown();
});

test('429 with Retry-After in seconds and as an HTTP-date', async () => {
  await mock.faults([
    { status: 429, retryAfter: '1' },
    { status: 429, retryAfter: new Date(Date.now() + 1000).toUTCString() },
  ]);
  const b = billing();
  record(b, 1);
  await settled();
  expect(await b.flush()).toMatchObject({ sent: 2 });
  const state = await mock.state();
  expect(state.requests.map((r) => r.status)).toEqual([429, 429, 202]);
  await b.shutdown();
});

test('a hung response is cut by timeoutMs and retried', async () => {
  await mock.faults([{ hang: true }]);
  const b = billing({ timeoutMs: 200 });
  record(b, 0);
  await settled();
  expect(await b.flush()).toMatchObject({ sent: 1 });
  expect((await mock.state()).requests.map((r) => r.status)).toEqual([-2, 202]);
  await b.shutdown();
});

test('shutdown honours shutdownTimeoutMs and reports leftovers', async () => {
  await mock.faults([{ hang: true, times: -1 }]);
  const drops: Array<[number, DropReason]> = [];
  const b = billing({ shutdownTimeoutMs: 300, onDrop: (e: unknown[], r: DropReason) => drops.push([e.length, r]) });
  record(b, 2);
  await settled();
  const started = Date.now();
  await b.shutdown();
  expect(Date.now() - started).toBeLessThan(3000);
  expect(drops).toEqual([[3, 'shutdown']]);
  expect(b.droppedCount).toBe(3);
  await mock.clearFaults();
});

test('one request in flight at a time under a burst', async () => {
  await mock.faults([{ delayMs: 20, times: -1 }]);
  const b = billing({ flushCount: 100 });
  record(b, 999);
  await settled();
  await b.flush();
  await mock.clearFaults();
  const state = await mock.state();
  expect(state.uniqueKeys).toBe(1000);
  expect(state.maxInFlight).toBe(1);
  await b.shutdown();
});
