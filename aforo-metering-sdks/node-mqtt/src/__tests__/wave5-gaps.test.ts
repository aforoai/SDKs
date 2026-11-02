/**
 * Wave 5 gap tests for @aforoai/mqtt-metering (G265, G266/G296, G268, G270,
 * G297). Each one failed on 1.2.2.
 */
import { EventEmitter } from 'events';
import { inspect } from 'util';
import { AforoMqttBilling, type DropReason } from '../index';
import { ackingPublish } from '../../test-support/mqtt-fakes';
import { bodyJson } from '../../test-support/request-body';

const KEY = 'sk_mqtt_wave5_secret';
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const ok = () => ({ ok: true, status: 202, headers: new Map(), text: async () => '{"success":true,"data":{"accepted":1,"failed":0,"errors":[]}}' });
const sent = () => mockFetch.mock.calls.flatMap((c) => bodyJson(c[1]).events);
const tick = () => new Promise((r) => setImmediate(r));

function billing(extra: Record<string, unknown> = {}) {
  return new AforoMqttBilling({
    tenantId: 't1',
    productId: 'p1',
    apiKey: KEY,
    ingestorUrl: 'https://ingest.example',
    flushIntervalMs: 1e9,
    onError: () => undefined,
    ...extra,
  } as any);
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => ok());
});

describe('G265: customer resolver required', () => {
  test('wrapAedesBroker without customerResolver or trustCustomerHeader throws', async () => {
    const b = billing();
    expect(() => b.wrapAedesBroker(new EventEmitter() as any, {} as any)).toThrow(/customerResolver/);
    await b.shutdown();
  });

  test('trustCustomerHeader bills the MQTT username', async () => {
    const b = billing();
    const broker = new EventEmitter();
    b.wrapAedesBroker(broker as any, { trustCustomerHeader: true });
    broker.emit('publish', { topic: 'a/b', payload: Buffer.from('x'), qos: 0 }, { id: 'dev1', username: 'cust_u' });
    await tick();
    await b.flush();
    expect(sent().map((e) => e.customerId)).toEqual(['cust_u']);
    await b.shutdown();
  });

  test('a resolver that returns nothing: dropped as invalid and counted', async () => {
    const reasons: DropReason[] = [];
    const b = billing({ onDrop: (_e: unknown, r: DropReason) => reasons.push(r) });
    const broker = new EventEmitter();
    b.wrapAedesBroker(broker as any, { customerResolver: async () => undefined });
    broker.emit('publish', { topic: 'a/b', payload: Buffer.from('x') }, { id: 'dev1', username: 'cust_u' });
    await tick();
    await b.flush();
    expect(sent()).toEqual([]);
    expect(reasons).toEqual(['invalid']);
    expect(b.droppedCount).toBe(1);
    await b.shutdown();
  });
});

describe('G297: broker listeners never leak a rejection', () => {
  test('a rejecting resolver is caught and reported, not an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    const errors: string[] = [];
    const b = billing({ onError: (e: Error) => errors.push(e.message) });
    const broker = new EventEmitter();
    b.wrapAedesBroker(broker as any, {
      customerResolver: async () => {
        throw new Error('directory down');
      },
      // No reconnect window, so the DISCONNECT resolves its customer now (the
      // debounced path is covered in g288-mqtt-client.test.ts).
      reconnectDebounceMs: 0,
    });
    for (const ev of ['publish', 'subscribe', 'unsubscribe', 'client', 'clientDisconnect']) {
      const payload = ev === 'publish' ? { topic: 't', payload: Buffer.from('x') } : ev === 'subscribe' ? [{ topic: 't', qos: 0 }] : ev === 'unsubscribe' ? ['t'] : { id: 'c' };
      if (ev === 'client' || ev === 'clientDisconnect') broker.emit(ev, { id: 'dev1' });
      else broker.emit(ev, payload, { id: 'dev1' });
    }
    await tick();
    await tick();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    expect(errors.filter((m) => m.includes('directory down')).length).toBe(5);
    await b.shutdown();
  });
});

describe('G266/G296/G268: bounded queue, one flusher, request deadline', () => {
  test('crossing flushCount never starts a request synchronously; requests carry a signal', async () => {
    const b = billing({ flushCount: 2 });
    const client = Object.assign(new EventEmitter(), { publish: ackingPublish(), options: { clientId: 'c1' } });
    b.wrapMqttClient(client as any, { customerId: 'cust_1' });
    for (let i = 0; i < 6; i++) (client as any).publish('t', 'x');
    expect(mockFetch).not.toHaveBeenCalled();
    await b.flush();
    expect(mockFetch.mock.calls.every((c) => c[1].signal)).toBe(true);
    await b.shutdown();
  });

  test('the queue is bounded: the oldest is evicted as overflow', async () => {
    const reasons: DropReason[] = [];
    const b = billing({ maxQueueSize: 2, onDrop: (_e: unknown, r: DropReason) => reasons.push(r) });
    const client = Object.assign(new EventEmitter(), { publish: ackingPublish(), options: { clientId: 'c1' } });
    b.wrapMqttClient(client as any, { customerId: 'cust_1' });
    for (let i = 0; i < 3; i++) (client as any).publish('t', 'x');
    expect(reasons).toEqual(['overflow']);
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
