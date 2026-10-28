/**
 * Wave 5 gap tests for @aforoai/ws-metering (G265, G266/G296, G268, G270,
 * G297). Each one failed on 1.2.1.
 */
import { EventEmitter } from 'events';
import { inspect } from 'util';
import { AforoWsBilling, type DropReason } from '../index';

const KEY = 'sk_ws_wave5_secret';
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

class FakeWs extends EventEmitter {
  readyState = 1;
  // Like ws: the send callback runs once the frame is written.
  send(_data: any, ...rest: any[]) { const cb = rest.find((a) => typeof a === 'function'); cb?.(); }
}

const ok = () => ({ ok: true, status: 202, headers: new Map(), text: async () => '{"success":true,"data":{"accepted":1,"failed":0,"errors":[]}}' });
const sent = () => mockFetch.mock.calls.flatMap((c) => JSON.parse(c[1].body).events);

function billing(extra: Record<string, unknown> = {}) {
  return new AforoWsBilling({
    tenantId: 't1',
    productId: 'p1',
    apiKey: KEY,
    ingestorUrl: 'https://ingest.example',
    flushIntervalMs: 1e9,
    ...extra,
  } as any);
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => ok());
});

describe('G265: customer resolver required', () => {
  test('wrapServer without customerResolver or trustCustomerHeader throws', async () => {
    const b = billing();
    expect(() => b.wrapServer(new EventEmitter() as any, {} as any)).toThrow(/customerResolver/);
    await b.shutdown();
  });

  test('trustCustomerHeader reads x-customer-id from the upgrade request', async () => {
    const b = billing();
    const wss = new EventEmitter();
    b.wrapServer(wss as any, { trustCustomerHeader: true });
    wss.emit('connection', new FakeWs(), { headers: { 'x-customer-id': 'cust_h' } });
    await b.flush();
    expect(sent().map((e) => e.customerId)).toEqual(['cust_h']);
    await b.shutdown();
  });

  test('a resolver that returns nothing: dropped as invalid, counted, connection untouched', async () => {
    const reasons: DropReason[] = [];
    const b = billing({ onDrop: (_e: unknown, r: DropReason) => reasons.push(r) });
    const wss = new EventEmitter();
    b.wrapServer(wss as any, { customerResolver: () => undefined });
    const ws = new FakeWs();
    wss.emit('connection', ws, { headers: { 'x-customer-id': 'ignored' } });
    ws.emit('close', 1000);
    await b.flush();
    expect(sent()).toEqual([]);
    expect(reasons).toEqual(['invalid']);
    expect(b.droppedCount).toBe(1);
    await b.shutdown();
  });
});

describe('G297: error followed by close bills once', () => {
  test('one closing event per connection', async () => {
    const b = billing();
    const ws = new FakeWs();
    b.trackConnection(ws as any, { customerId: 'c1' });
    ws.emit('error', new Error('reset'));
    ws.emit('close', 1006);
    ws.emit('close', 1006);
    await b.flush();
    const closing = sent().filter((e) => e.wsFrameType === 'CLOSE');
    expect(closing).toHaveLength(1);
    await b.shutdown();
  });
});

describe('G266/G296/G268: bounded queue, one flusher, request deadline', () => {
  test('pushing past flushCount never starts a request synchronously', async () => {
    const b = billing({ flushCount: 2, perFrameEvents: true });
    const ws = new FakeWs();
    b.trackConnection(ws as any, { customerId: 'c1' });
    for (let i = 0; i < 10; i++) ws.emit('message', 'm', false);
    expect(mockFetch).not.toHaveBeenCalled();
    await b.flush();
    expect(mockFetch.mock.calls.every((c) => c[1].signal)).toBe(true);
    await b.shutdown();
  });

  test('the queue is bounded: the oldest is evicted as overflow', async () => {
    const reasons: DropReason[] = [];
    const b = billing({ maxQueueSize: 3, perFrameEvents: true, onDrop: (_e: unknown, r: DropReason) => reasons.push(r) });
    const ws = new FakeWs();
    b.trackConnection(ws as any, { customerId: 'c1' });
    for (let i = 0; i < 4; i++) ws.emit('message', 'm', false);
    expect(reasons).toEqual(['overflow', 'overflow']);
    await b.shutdown();
  });
});

describe('G270: https and key redaction', () => {
  test('plain http to a remote host is refused', () => {
    expect(() => billing({ ingestorUrl: 'http://ingest.example' })).toThrow(/https/);
  });

  test('the API key is not visible through inspect or JSON', async () => {
    const b = billing();
    expect(inspect(b, { depth: 10, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(b)).not.toContain(KEY);
    await b.shutdown();
  });
});
