/**
 * executionStatus on WebSocket usage events: explicit only (the SDK never
 * derives one), the connection's outcome — set on the closing event only —
 * trimmed + upper-cased, omitted when unset or not a canonical value.
 */

import { AforoWsBilling } from '../index';
import { EventEmitter } from 'events';

let bodies: any[];

beforeEach(() => {
  bodies = [];
  global.fetch = jest.fn(async (_input: any, init: any = {}) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 202 } as unknown as Response;
  }) as any;
});

const config = () => ({
  tenantId: 'tenant-001',
  productId: 'prod-ws-001',
  apiKey: 'sk_ws_abc',
  ingestorUrl: 'https://api.aforo.ai',
  flushCount: 100,
});

class FakeWs extends EventEmitter {
  send(_data: any, _cb?: any) { /* stub */ }
}

const events = () => bodies.flatMap((b) => b.events);

test('fixed string is trimmed + upper-cased on the closing event only', async () => {
  const billing = new AforoWsBilling({ ...config(), perFrameEvents: true });
  const ws = new FakeWs();
  billing.trackConnection(ws as any, { customerId: 'cust_001', executionStatus: '  error ' });
  ws.emit('message', 'hi', false);
  (ws as any).send('yo');
  ws.emit('close', 1011, '');
  await billing.shutdown();
  expect(events()).toHaveLength(4);
  const [open, inbound, outbound, close] = events();
  // A connection-level ERROR must not make every frame bill at the ERROR weight.
  expect('executionStatus' in open).toBe(false);
  expect('executionStatus' in inbound).toBe(false);
  expect('executionStatus' in outbound).toBe(false);
  expect(close.metadata.event).toBe('CONNECTION_CLOSED');
  expect(close.executionStatus).toBe('ERROR');
});

test('the synthetic close on a socket error carries the connection status too', async () => {
  const billing = new AforoWsBilling(config());
  const ws = new FakeWs();
  billing.trackConnection(ws as any, { customerId: 'cust_001', executionStatus: 'timeout' });
  ws.emit('error', new Error('boom'));
  await billing.shutdown();
  const [open, errClose] = events();
  expect('executionStatus' in open).toBe(false);
  expect(errClose.metadata.event).toBe('CONNECTION_ERROR');
  expect(errClose.executionStatus).toBe('TIMEOUT');
});

test('resolver is only called for the closing event', async () => {
  const billing = new AforoWsBilling({ ...config(), perFrameEvents: true });
  const ws = new FakeWs();
  const resolver = jest.fn(() => 'success');
  billing.trackConnection(ws as any, { customerId: 'cust_001', executionStatus: resolver });
  ws.emit('message', 'hi', false);
  ws.emit('close', 1000, '');
  await billing.shutdown();
  expect(resolver).toHaveBeenCalledTimes(1);
  expect((resolver.mock.calls[0] as any[])[0].wsFrameType).toBe('CLOSE');
  expect(events().map((e) => e.executionStatus)).toEqual([undefined, undefined, 'SUCCESS']);
});

test('resolver receives the close event and can return undefined to omit', async () => {
  const billing = new AforoWsBilling(config());
  const ws = new FakeWs();
  billing.trackConnection(ws as any, {
    customerId: 'cust_001',
    executionStatus: (ev) => (ev.wsFrameType === 'CLOSE' && ev.metadata?.closeCode !== 1000 ? 'error' : undefined),
  });
  ws.emit('close', 1011, '');
  await billing.shutdown();
  const [open, close] = events();
  expect('executionStatus' in open).toBe(false);
  expect(close.executionStatus).toBe('ERROR');
});

test('unset or blank → key omitted (no derivation, even on abnormal close or error)', async () => {
  const billing = new AforoWsBilling(config());
  const a = new FakeWs();
  const b = new FakeWs();
  billing.trackConnection(a as any, { customerId: 'cust_001' });
  billing.trackConnection(b as any, { customerId: 'cust_002', executionStatus: '   ' });
  a.emit('close', 1006, '');
  b.emit('error', new Error('boom'));
  await billing.shutdown();
  expect(events()).toHaveLength(4);
  for (const ev of events()) expect('executionStatus' in ev).toBe(false);
});

test('a throwing resolver does not break metering — key omitted', async () => {
  const billing = new AforoWsBilling(config());
  const ws = new FakeWs();
  billing.trackConnection(ws as any, {
    customerId: 'cust_001',
    executionStatus: () => { throw new Error('bug'); },
  });
  ws.emit('close', 1000, '');
  await billing.shutdown();
  expect(events()).toHaveLength(2);
  for (const ev of events()) expect('executionStatus' in ev).toBe(false);
});

test('wrapServer passes the upgrade request to the resolver', async () => {
  const billing = new AforoWsBilling(config());
  const wss = new EventEmitter();
  billing.wrapServer(wss as any, {
    extractCustomerId: (req) => req.headers['x-customer-id'],
    executionStatus: (_ev, req) => req.headers['x-outcome'],
  });
  const ws = new FakeWs();
  wss.emit('connection', ws, { headers: { 'x-customer-id': 'cust_001', 'x-outcome': 'blocked' } });
  ws.emit('close', 1000, '');
  await billing.shutdown();
  expect('executionStatus' in events()[0]).toBe(false);
  expect(events()[1].executionStatus).toBe('BLOCKED');
});

test('unknown or over-long value is reported via onError and omitted; the event is still sent', async () => {
  const onError = jest.fn();
  const billing = new AforoWsBilling({ ...config(), onError });
  const a = new FakeWs();
  const b = new FakeWs();
  billing.trackConnection(a as any, { customerId: 'cust_001', executionStatus: 'bogus' });
  billing.trackConnection(b as any, { customerId: 'cust_002', executionStatus: 'X'.repeat(21) });
  a.emit('close', 1000, '');
  b.emit('close', 1000, '');
  await billing.shutdown();
  const closes = events().filter((e) => e.wsFrameType === 'CLOSE');
  expect(closes).toHaveLength(2);
  for (const ev of closes) expect('executionStatus' in ev).toBe(false);
  expect(closes[0].customerId).toBe('cust_001');
  expect(onError).toHaveBeenCalledTimes(2);
  expect(onError.mock.calls[0][0].message).toContain('unknown executionStatus "BOGUS"');
});

test('async resolver: Promise is omitted, rejection swallowed, onError told', async () => {
  const onError = jest.fn();
  const billing = new AforoWsBilling({ ...config(), onError });
  const ws = new FakeWs();
  billing.trackConnection(ws as any, {
    customerId: 'cust_001',
    executionStatus: (async () => { throw new Error('late'); }) as any,
  });
  ws.emit('close', 1000, '');
  await billing.shutdown();
  expect(events()).toHaveLength(2);
  expect('executionStatus' in events()[1]).toBe(false);
  expect(JSON.stringify(bodies)).not.toContain('[object Promise]');
  expect(onError.mock.calls[0][0].message).toContain('Promise');
});
