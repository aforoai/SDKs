/**
 * Connection lifecycle events and the open-connection map (G279, matching
 * go-ws 2.0.0): CONNECTION_OPENED has its own frame type and metric, every
 * connection still open at shutdown gets a CONNECTION_CLOSED, and connections
 * that go quiet are closed by an idle sweep so the map stays bounded.
 */
import { EventEmitter } from 'events';
import { AforoWsBilling, WsUsageEvent, DropReason } from '../index';
import { bodyJson } from '../../test-support/request-body';

class FakeWs extends EventEmitter {
  readyState = 1;
  // Like ws: the send callback runs once the frame is written.
  send(_data: any, ...rest: any[]) { const cb = rest.find((a) => typeof a === 'function'); cb?.(); }
}

let sent: WsUsageEvent[];
beforeEach(() => {
  sent = [];
  global.fetch = jest.fn(async (_url: any, init: any) => {
    const events = bodyJson(init).events as WsUsageEvent[];
    sent.push(...events);
    return new Response(JSON.stringify({ success: true, data: { accepted: events.length, duplicates: 0, failed: 0, errors: [] } }), { status: 202 });
  }) as any;
});

function billing(extra: Record<string, unknown> = {}) {
  const drops: Array<{ reason: DropReason; events: WsUsageEvent[] }> = [];
  const b = new AforoWsBilling({
    tenantId: 't1', productId: 'p1', apiKey: 'sk_test', ingestorUrl: 'https://api.aforo.ai',
    flushIntervalMs: 60_000, flushOnExit: false,
    onDrop: (events: WsUsageEvent[], reason: DropReason) => drops.push({ reason, events }),
    ...extra,
  } as any);
  return { b, drops };
}

const byEvent = (name: string) => sent.filter((e) => e.metadata?.event === name);

test('CONNECTION_OPENED is sent with wsFrameType OPEN and metric websocket_api.connection_opened', async () => {
  const { b } = billing();
  b.trackConnection(new FakeWs() as any, { customerId: 'cust_1' });
  await b.flush();
  const [open] = byEvent('CONNECTION_OPENED');
  expect(open.wsFrameType).toBe('OPEN');
  expect(open.metricName).toBe('websocket_api.connection_opened');
  expect(open.idempotencyKey).toMatch(/:OPEN:/);
  await b.shutdown();
});

test('shutdown emits CONNECTION_CLOSED (GOING_AWAY, closedBy sdk_shutdown) for every connection still open', async () => {
  const { b } = billing();
  const a = new FakeWs();
  const c = new FakeWs();
  b.trackConnection(a as any, { customerId: 'cust_a' });
  b.trackConnection(c as any, { customerId: 'cust_c' });
  a.emit('message', 'hello', false);
  c.emit('close', 1000);
  expect(b.openConnections).toBe(1);
  await b.shutdown();
  const closes = byEvent('CONNECTION_CLOSED');
  expect(closes.map((e) => e.customerId).sort()).toEqual(['cust_a', 'cust_c']);
  const forA = closes.find((e) => e.customerId === 'cust_a')!;
  expect(forA.wsCloseReason).toBe('GOING_AWAY');
  expect(forA.metadata).toMatchObject({ closeCode: 1001, closedBy: 'sdk_shutdown', recvCount: 1 });
  expect(b.openConnections).toBe(0);
  // The socket closing later does not bill the connection a second time.
  a.emit('close', 1000);
  expect(byEvent('CONNECTION_CLOSED')).toHaveLength(2);
});

test('a connection opened during or after shutdown is not billed OPEN without a CLOSE', async () => {
  const { b, drops } = billing();
  const done = b.shutdown();
  b.trackConnection(new FakeWs() as any, { customerId: 'cust_late' });
  await done;
  expect(byEvent('CONNECTION_OPENED')).toHaveLength(0);
  expect(drops.some((d) => d.reason === 'closed' && d.events[0].customerId === 'cust_late')).toBe(true);
  expect(b.openConnections).toBe(0);
});

test('idle sweep closes a quiet connection (ABNORMAL_CLOSURE, closedBy sdk_idle_timeout) and frees its slot', async () => {
  const { b } = billing({ connectionIdleTimeoutMs: 60_000 });
  const quiet = new FakeWs();
  const busy = new FakeWs();
  b.trackConnection(quiet as any, { customerId: 'cust_quiet' });
  b.trackConnection(busy as any, { customerId: 'cust_busy' });
  const later = Date.now() + 61_000;
  // busy sees activity "now + 61 s" (simulated through the sweep's clock below)
  expect(b.sweepIdleConnections(Date.now() + 30_000)).toBe(0);
  expect(b.sweepIdleConnections(later)).toBe(2);
  expect(b.openConnections).toBe(0);
  await b.flush();
  const closes = byEvent('CONNECTION_CLOSED');
  expect(closes).toHaveLength(2);
  expect(closes[0].wsCloseReason).toBe('ABNORMAL_CLOSURE');
  expect(closes[0].metadata).toMatchObject({ closeCode: 1006, closedBy: 'sdk_idle_timeout' });
  await b.shutdown();
});

test('activity keeps a connection out of the idle sweep', async () => {
  const { b } = billing({ connectionIdleTimeoutMs: 60_000 });
  const ws = new FakeWs();
  b.trackConnection(ws as any, { customerId: 'cust_1' });
  const realNow = Date.now;
  try {
    const base = realNow();
    Date.now = () => base + 50_000;
    ws.emit('message', 'ping', false);
    expect(b.sweepIdleConnections(base + 70_000)).toBe(0); // 20 s since the message
    expect(b.sweepIdleConnections(base + 111_000)).toBe(1);
  } finally {
    Date.now = realNow;
  }
  await b.shutdown();
});

test('a negative or non-numeric connectionIdleTimeoutMs is refused (it would leave the map unbounded)', () => {
  expect(() => billing({ connectionIdleTimeoutMs: -1 })).toThrow(/connectionIdleTimeoutMs/);
  expect(() => billing({ connectionIdleTimeoutMs: Number.NaN })).toThrow(/connectionIdleTimeoutMs/);
});

test('second shutdown() emits no second CONNECTION_CLOSED', async () => {
  const { b } = billing();
  b.trackConnection(new FakeWs() as any, { customerId: 'cust_1' });
  await Promise.all([b.shutdown(), b.shutdown()]);
  await b.shutdown();
  expect(byEvent('CONNECTION_CLOSED')).toHaveLength(1);
});
