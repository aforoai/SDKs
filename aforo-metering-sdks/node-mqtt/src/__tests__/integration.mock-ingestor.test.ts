/**
 * AforoMqttBilling against the repo's fault-injecting mock ingestor (real HTTP,
 * real timers). Waits on the SDK's own promises, never on fixed sleeps.
 */
import { EventEmitter } from 'events';
import { AforoMqttBilling, type DropReason } from '../index';
import { startMockIngestor, type MockIngestor } from '../../test-support/mock-ingestor';
import { ackingPublish } from '../../test-support/mqtt-fakes';

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

function billing(extra: Record<string, unknown> = {}) {
  return new AforoMqttBilling({
    tenantId: 't1',
    productId: 'p1',
    apiKey: 'it-key',
    ingestorUrl: mock.url,
    flushIntervalMs: 60_000,
    timeoutMs: 2000,
    flushOnExit: false,
    onError: () => undefined,
    ...extra,
  } as any);
}

/** One CONNECT event plus `frames` PUBLISH events from an mqtt.js-style client. */
function record(b: AforoMqttBilling, frames: number): void {
  const client: any = Object.assign(new EventEmitter(), { publish: ackingPublish(), options: { clientId: 'dev1' } });
  b.wrapMqttClient(client, { customerId: 'cust_1' });
  client.emit('connect');
  for (let i = 0; i < frames; i++) client.publish('sensors/t', 'x');
}

test('outage then recovery: nothing lost, accepted keys are the originals', async () => {
  await mock.faults([{ status: 503, times: -1 }]);
  const drops: DropReason[] = [];
  const b = billing({ onDrop: (_e: unknown, r: DropReason) => drops.push(r) });
  record(b, 4);
  expect(await b.flush()).toMatchObject({ sent: 0, requeued: 5, queued: 5 });
  await mock.clearFaults();
  expect(await b.flush()).toMatchObject({ sent: 5, queued: 0 });
  const state = await mock.state();
  expect(state.uniqueKeys).toBe(5);
  expect(state.duplicates).toBe(0);
  expect(drops).toEqual([]);
  // Plain JSON under 1 KiB, gzip at or above it (wave 8, G269); never another coding.
  expect(state.requests.every((r) => r.contentEncoding === null || r.contentEncoding === 'gzip')).toBe(true);
  expect(state.requests[0].userAgent).toMatch(/^aforo-mqtt-metering\//);
  await b.shutdown();
});

test('429 with Retry-After in seconds and as an HTTP-date', async () => {
  await mock.faults([
    { status: 429, retryAfter: '1' },
    { status: 429, retryAfter: new Date(Date.now() + 1000).toUTCString() },
  ]);
  const b = billing();
  record(b, 1);
  expect(await b.flush()).toMatchObject({ sent: 2 });
  const state = await mock.state();
  expect(state.requests.map((r) => r.status)).toEqual([429, 429, 202]);
  await b.shutdown();
});

test('a hung response is cut by timeoutMs and retried', async () => {
  await mock.faults([{ hang: true }]);
  const b = billing({ timeoutMs: 200 });
  record(b, 0);
  expect(await b.flush()).toMatchObject({ sent: 1 });
  expect((await mock.state()).requests.map((r) => r.status)).toEqual([-2, 202]);
  await b.shutdown();
});

test('shutdown honours shutdownTimeoutMs and reports leftovers', async () => {
  await mock.faults([{ hang: true, times: -1 }]);
  const drops: Array<[number, DropReason]> = [];
  const b = billing({ shutdownTimeoutMs: 300, onDrop: (e: unknown[], r: DropReason) => drops.push([e.length, r]) });
  record(b, 2);
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
  await b.flush();
  await mock.clearFaults();
  const state = await mock.state();
  expect(state.uniqueKeys).toBe(1000);
  expect(state.maxInFlight).toBe(1);
  await b.shutdown();
});
