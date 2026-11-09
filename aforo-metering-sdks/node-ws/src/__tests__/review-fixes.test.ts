/**
 * Regression tests for the 2026-11-09 review of @aforoai/ws-metering:
 * re-tracking after an idle sweep (R8), a throwing extractMetadata (#9), and a
 * duration the ingestor's int cannot hold (#10, R3 in the transport core).
 */
import { EventEmitter } from 'events';
import { AforoWsBilling, WsUsageEvent } from '../index';
import { bodyJson } from '../../test-support/request-body';

class FakeWs extends EventEmitter {
  readyState = 1;
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
  const errors: Error[] = [];
  const b = new AforoWsBilling({
    tenantId: 't1', productId: 'p1', apiKey: 'sk_test', ingestorUrl: 'https://api.aforo.ai',
    flushIntervalMs: 60_000, flushOnExit: false, perFrameEvents: true, onError: (e: Error) => errors.push(e), ...extra,
  } as any);
  return { b, errors };
}
const byEvent = (name: string) => sent.filter((e) => e.metadata?.event === name);

describe('R8: a connection closed by the idle sweep is tracked again on its next frame', () => {
  test('frames after the sweep and the real close are billed', async () => {
    const { b } = billing();
    const ws = new FakeWs();
    b.trackConnection(ws as any, { customerId: 'cust_1' });
    ws.emit('message', Buffer.from('a'), false);
    expect(b.sweepIdleConnections(Date.now() + 2 * 60 * 60 * 1000)).toBe(1);
    expect(b.openConnections).toBe(0);

    // The socket was alive after all: a frame in, a frame out, then a real close.
    ws.emit('message', Buffer.from('bb'), false);
    (ws as any).send('ccc');
    expect(b.openConnections).toBe(1);
    ws.emit('close', 1000, '');
    expect(b.openConnections).toBe(0);
    await b.shutdown();

    const opens = byEvent('CONNECTION_OPENED');
    const closes = byEvent('CONNECTION_CLOSED');
    expect(opens).toHaveLength(2);
    expect(opens[1].metadata).toMatchObject({ resumedAfterIdleSweep: true });
    expect(opens[1].wsConnectionId).toBe(opens[0].wsConnectionId);
    expect(closes).toHaveLength(2);
    expect(closes[0].metadata).toMatchObject({ closedBy: 'sdk_idle_timeout', recvCount: 1 });
    expect(closes[1].metadata).toMatchObject({ recvCount: 1, sentCount: 1, recvBytes: 2, sentBytes: 3, closeCode: 1000 });
    expect(closes[1].metadata).not.toHaveProperty('closedBy');
    expect(sent.filter((e) => e.metricName === 'websocket_api.message')).toHaveLength(3);
  });

  test('a swept connection that just closes bills nothing more', async () => {
    const { b } = billing();
    const ws = new FakeWs();
    b.trackConnection(ws as any, { customerId: 'cust_1' });
    b.sweepIdleConnections(Date.now() + 2 * 60 * 60 * 1000);
    ws.emit('close', 1006, '');
    ws.emit('message', Buffer.from('late'), false); // after the real close: never re-tracked
    await b.shutdown();
    expect(byEvent('CONNECTION_OPENED')).toHaveLength(1);
    expect(byEvent('CONNECTION_CLOSED')).toHaveLength(1);
  });

  test('not re-tracked once shutdown() has started', async () => {
    const { b } = billing();
    const ws = new FakeWs();
    b.trackConnection(ws as any, { customerId: 'cust_1' });
    b.sweepIdleConnections(Date.now() + 2 * 60 * 60 * 1000);
    const done = b.shutdown();
    ws.emit('message', Buffer.from('x'), false);
    await done;
    expect(byEvent('CONNECTION_OPENED')).toHaveLength(1);
    expect(b.droppedCount).toBe(0);
  });
});

describe('#9: a throwing extractMetadata never escapes the connection listener', () => {
  test('reported through onError; the connection is metered without metadata', async () => {
    const { b, errors } = billing();
    const wss = new EventEmitter();
    b.wrapServer(wss as any, {
      customerResolver: () => 'cust_1',
      extractMetadata: (req: any) => ({ plan: req.session.plan }),
    });
    const ws = new FakeWs();
    expect(() => wss.emit('connection', ws, { headers: {} })).not.toThrow();
    ws.emit('close', 1000, '');
    await b.shutdown();
    expect(errors.map((e) => e.message).join()).toMatch(/extractMetadata threw/);
    expect(byEvent('CONNECTION_OPENED')).toHaveLength(1);
    expect(byEvent('CONNECTION_CLOSED')).toHaveLength(1);
    expect(byEvent('CONNECTION_OPENED')[0].metadata).not.toHaveProperty('plan');
  });
});

describe('#10: a connection open longer than an int of milliseconds', () => {
  test('its executionDurationMs is left off (the ingestor would 400 the whole batch); the event is sent', async () => {
    const { b } = billing({ perFrameEvents: false });
    const ws = new FakeWs();
    const realNow = Date.now;
    const t0 = realNow();
    b.trackConnection(ws as any, { customerId: 'cust_1' });
    try {
      Date.now = () => t0 + 25 * 24 * 3600 * 1000;
      ws.emit('message', Buffer.from('tick'), false);
      ws.emit('close', 1000, '');
    } finally {
      Date.now = realNow;
    }
    await b.shutdown();
    const [closed] = byEvent('CONNECTION_CLOSED');
    expect(closed).toBeDefined();
    expect(closed).not.toHaveProperty('executionDurationMs');
    expect(closed.messageCount).toBe(1);
    expect(b.droppedCount).toBe(0);
  });
});
