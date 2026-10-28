/**
 * G288 (Node): wrapMqttClient meters PUBLISH only after the publish
 * succeeded, and a connection that drops and comes back within
 * `reconnectDebounceMs` is one session — no new CONNECT/DISCONNECT pair is
 * billed for the flap. The broker hooks (wrapAedesBroker) follow the same
 * rule per client id. Same semantics as python-mqtt's wrap_paho_client.
 *
 * Debounce tests use Jest fake timers for the debounce timer only; the
 * transport's idle wait is 1e9 ms, so nothing else is advanced. Events are
 * read back from a fetch stub after real timers are restored.
 */
import { EventEmitter } from 'events';
import { AforoMqttBilling, CoreTransportError } from '../index';

let captured: any[];
beforeEach(() => {
  captured = [];
  global.fetch = jest.fn(async (_input: any, init: any = {}) => {
    captured.push(JSON.parse(init.body));
    return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' } as unknown as Response;
  }) as any;
});
afterEach(() => jest.useRealTimers());

const events = () => captured.flatMap((b) => b.events ?? []);
const types = () => events().map((e: any) => e.mqttEventType);

function billing(extra: Record<string, unknown> = {}) {
  return new AforoMqttBilling({
    tenantId: 't',
    productId: 'p',
    apiKey: 'sk_g288',
    ingestorUrl: 'https://ingest.example',
    flushCount: 1000,
    flushIntervalMs: 1e9,
    flushOnExit: false,
    onError: () => {},
    ...extra,
  });
}

/** An mqtt.js-shaped client whose publish hands its callback to the test. */
function fakeClient(clientId = 'dev1') {
  const client: any = new EventEmitter();
  client.options = { clientId };
  client.disconnecting = false;
  const pending: Array<(err?: Error | null) => void> = [];
  client.publish = jest.fn((_t: string, _m: any, opts?: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    pending.push((err) => done?.(err ?? null, { cmd: 'publish' }));
    return client;
  });
  return { client, pending };
}

async function settle(b: AforoMqttBilling) {
  jest.useRealTimers();
  await b.flush();
}

describe('wrapMqttClient: PUBLISH after success', () => {
  test('nothing is metered until the publish callback reports success', async () => {
    const b = billing();
    const { client, pending } = fakeClient();
    b.wrapMqttClient(client, { customerId: 'cust_1' });
    const userCb = jest.fn();
    client.publish('sensors/t', 'x', { qos: 1 }, userCb);
    await b.flush();
    expect(types()).toEqual([]);
    pending[0](null);
    await b.flush();
    expect(types()).toEqual(['PUBLISH']);
    expect(events()[0]).toMatchObject({ mqttTopic: 'sensors/t', mqttQos: 1 });
    expect(userCb).toHaveBeenCalledWith(null, { cmd: 'publish' });
    await b.shutdown();
  });

  test('a publish that fails (callback error) is not metered; the caller still gets the error', async () => {
    const b = billing();
    const { client, pending } = fakeClient();
    b.wrapMqttClient(client, { customerId: 'cust_1' });
    const userCb = jest.fn();
    client.publish('sensors/t', 'x', { qos: 1 }, userCb);
    const err = new Error('client disconnecting');
    pending[0](err);
    await b.flush();
    expect(types()).toEqual([]);
    expect(userCb).toHaveBeenCalledWith(err, { cmd: 'publish' });
    await b.shutdown();
  });

  test('the callback in place of opts is supported and the original arity is kept', async () => {
    const b = billing();
    const { client, pending } = fakeClient();
    const orig = client.publish;
    b.wrapMqttClient(client, { customerId: 'cust_1' });
    const userCb = jest.fn();
    client.publish('sensors/t', 'x', userCb);
    expect(orig.mock.calls[0]).toHaveLength(3);
    expect(typeof orig.mock.calls[0][2]).toBe('function');
    pending[0](null);
    await b.flush();
    expect(types()).toEqual(['PUBLISH']);
    expect(userCb).toHaveBeenCalledTimes(1);
    await b.shutdown();
  });

  test('a publish without a callback is metered when the client confirms it', async () => {
    const b = billing();
    const { client, pending } = fakeClient();
    b.wrapMqttClient(client, { customerId: 'cust_1' });
    expect(client.publish('sensors/t', 'x')).toBe(client);
    await b.flush();
    expect(types()).toEqual([]);
    pending[0](null);
    await b.flush();
    expect(types()).toEqual(['PUBLISH']);
    await b.shutdown();
  });

  test('a publish that throws synchronously is not metered and the throw reaches the caller', async () => {
    const b = billing();
    const client: any = new EventEmitter();
    client.options = { clientId: 'dev1' };
    client.publish = () => {
      throw new Error('bad topic');
    };
    b.wrapMqttClient(client, { customerId: 'cust_1' });
    expect(() => client.publish('a/#', 'x')).toThrow('bad topic');
    await b.flush();
    expect(types()).toEqual([]);
    await b.shutdown();
  });
});

describe('wrapMqttClient: reconnect flaps', () => {
  test('a drop and reconnect inside the window bills one CONNECT and no DISCONNECT', async () => {
    jest.useFakeTimers();
    const b = billing({ reconnectDebounceMs: 30_000 });
    const { client } = fakeClient();
    b.wrapMqttClient(client, { customerId: 'cust_1' });
    client.emit('connect');
    client.emit('close'); // dropped
    client.emit('close'); // failed reconnect attempts emit close again
    jest.advanceTimersByTime(10_000);
    client.emit('connect'); // back within the window
    jest.advanceTimersByTime(60_000);
    await settle(b);
    expect(types()).toEqual(['CONNECT']);
    await b.shutdown();
    expect(types()).toEqual(['CONNECT']); // still connected: nothing pending at shutdown
  });

  test('a drop that does not come back is billed as DISCONNECT at the drop time once the window passes', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-26T10:00:00Z') });
    const b = billing({ reconnectDebounceMs: 30_000 });
    const { client } = fakeClient();
    b.wrapMqttClient(client, { customerId: 'cust_1' });
    client.emit('connect');
    jest.advanceTimersByTime(5_000);
    client.emit('close');
    jest.advanceTimersByTime(29_999);
    expect(b.queuedCount).toBe(1);
    jest.advanceTimersByTime(1);
    await settle(b);
    expect(types()).toEqual(['CONNECT', 'DISCONNECT']);
    expect(events()[1].occurredAt).toBe('2026-10-26T10:00:05.000Z');
    await b.shutdown();
  });

  test('a clean end() bills DISCONNECT at once; a later connect is a new session', async () => {
    jest.useFakeTimers();
    const b = billing({ reconnectDebounceMs: 30_000 });
    const { client } = fakeClient();
    b.wrapMqttClient(client, { customerId: 'cust_1' });
    client.emit('connect');
    client.disconnecting = true;
    client.emit('close');
    client.emit('end');
    client.disconnecting = false;
    client.emit('connect');
    await settle(b);
    expect(types()).toEqual(['CONNECT', 'DISCONNECT', 'CONNECT']);
    await b.shutdown();
  });

  test("end() while a drop is pending bills that DISCONNECT immediately", async () => {
    jest.useFakeTimers();
    const b = billing({ reconnectDebounceMs: 30_000 });
    const { client } = fakeClient();
    b.wrapMqttClient(client, { customerId: 'cust_1' });
    client.emit('connect');
    client.emit('close');
    client.emit('end');
    await settle(b);
    expect(types()).toEqual(['CONNECT', 'DISCONNECT']);
    await b.shutdown();
  });

  test('shutdown sends a pending DISCONNECT instead of dropping it', async () => {
    jest.useFakeTimers();
    const drops: string[] = [];
    const b = billing({ reconnectDebounceMs: 30_000, onDrop: (_e: unknown, r: string) => drops.push(r) });
    const { client } = fakeClient();
    b.wrapMqttClient(client, { customerId: 'cust_1' });
    client.emit('connect');
    client.emit('close');
    jest.useRealTimers();
    await b.shutdown();
    expect(types()).toEqual(['CONNECT', 'DISCONNECT']);
    expect(drops).toEqual([]);
  });

  test('reconnectDebounceMs: 0 turns the window off: every connect and disconnect is billed at once', async () => {
    const b = billing({ reconnectDebounceMs: 0 });
    const { client } = fakeClient();
    b.wrapMqttClient(client, { customerId: 'cust_1' });
    client.emit('connect');
    client.emit('close');
    client.emit('connect');
    await b.flush();
    expect(types()).toEqual(['CONNECT', 'DISCONNECT', 'CONNECT']);
    await b.shutdown();
  });

  test('the per-client option overrides the client-level one', async () => {
    const b = billing({ reconnectDebounceMs: 30_000 });
    const { client } = fakeClient();
    b.wrapMqttClient(client, { customerId: 'cust_1', reconnectDebounceMs: 0 });
    client.emit('connect');
    client.emit('close');
    await b.flush();
    expect(types()).toEqual(['CONNECT', 'DISCONNECT']);
    await b.shutdown();
  });

  test('an invalid reconnectDebounceMs fails at construction / wrap time', () => {
    expect(() => billing({ reconnectDebounceMs: -1 })).toThrow(/reconnectDebounceMs/);
    expect(() => billing({ reconnectDebounceMs: Number.NaN })).toThrow(/reconnectDebounceMs/);
    const b = billing();
    expect(() => b.wrapMqttClient(fakeClient().client, { customerId: 'c', reconnectDebounceMs: -5 })).toThrow(/reconnectDebounceMs/);
    return b.shutdown();
  });
});

describe('wrapAedesBroker: reconnect flaps per client id', () => {
  const opts = { customerResolver: (id: string) => `cust_${id}` };
  const tick = () => new Promise((r) => setImmediate(r));

  test('an unclean disconnect and reconnect within the window is one session', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const b = billing({ reconnectDebounceMs: 30_000 });
    const broker = new EventEmitter();
    b.wrapAedesBroker(broker as any, opts);
    broker.emit('client', { id: 'dev1' });
    await tick();
    broker.emit('clientDisconnect', { id: 'dev1' });
    await tick();
    jest.advanceTimersByTime(5_000);
    broker.emit('client', { id: 'dev1' });
    await tick();
    jest.advanceTimersByTime(60_000);
    await tick();
    await settle(b);
    expect(types()).toEqual(['CONNECT']);
    await b.shutdown();
  });

  test('a clean DISCONNECT packet is billed at once', async () => {
    const b = billing({ reconnectDebounceMs: 30_000 });
    const broker = new EventEmitter();
    b.wrapAedesBroker(broker as any, opts);
    broker.emit('client', { id: 'dev1' });
    await tick();
    broker.emit('clientDisconnect', { id: 'dev1', _disconnected: true });
    await tick();
    await b.flush();
    expect(types()).toEqual(['CONNECT', 'DISCONNECT']);
    expect(events()[1].customerId).toBe('cust_dev1');
    await b.shutdown();
  });

  test('a session takeover (new connection before the old one closes) bills no extra pair', async () => {
    const b = billing({ reconnectDebounceMs: 30_000 });
    const broker = new EventEmitter();
    b.wrapAedesBroker(broker as any, opts);
    broker.emit('client', { id: 'dev1' });
    await tick();
    broker.emit('client', { id: 'dev1' }); // takeover
    await tick();
    broker.emit('clientDisconnect', { id: 'dev1' }); // the old connection goes away
    await tick();
    await b.flush();
    expect(types()).toEqual(['CONNECT']);
    await b.shutdown();
  });

  test('a rejecting resolver on a debounced DISCONNECT is reported, never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    const errors: string[] = [];
    const b = billing({ reconnectDebounceMs: 30_000, onError: (e: Error) => errors.push(e.message) });
    const broker = new EventEmitter();
    b.wrapAedesBroker(broker as any, {
      customerResolver: async () => {
        throw new Error('directory down');
      },
    });
    broker.emit('clientDisconnect', { id: 'dev1' });
    await b.shutdown(); // bills the pending DISCONNECT now
    await tick();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    expect(errors.some((m) => m.includes('directory down'))).toBe(true);
  });

  test('an unclean disconnect that does not come back is billed after the window', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const b = billing({ reconnectDebounceMs: 30_000 });
    const broker = new EventEmitter();
    b.wrapAedesBroker(broker as any, opts);
    broker.emit('client', { id: 'dev1' });
    await tick();
    broker.emit('clientDisconnect', { id: 'dev1' });
    await tick();
    jest.advanceTimersByTime(30_000);
    await tick();
    await settle(b);
    expect(types()).toEqual(['CONNECT', 'DISCONNECT']);
    expect(events()[1].customerId).toBe('cust_dev1');
    await b.shutdown();
  });
});

// Real mqtt.js against a real aedes broker: a QoS 1 publish is metered only
// once the broker has acknowledged it.
let aedesFactory: any;
let mqttPkg: any;
try {
  const ns = require('aedes');
  aedesFactory = ns && (ns.default || ns);
  mqttPkg = require('mqtt');
} catch {
  /* optional peers not installed: the test below is skipped */
}
const itIfPeers = typeof aedesFactory === 'function' && mqttPkg?.connect ? test : test.skip;

itIfPeers('real mqtt.js: a QoS 1 publish is metered after the broker acknowledges it, not before', async () => {
  const net = await import('net');
  const aedes = aedesFactory();
  let release: (() => void) | undefined;
  aedes.authorizePublish = (_client: any, _packet: any, cb: (err: Error | null) => void) => {
    release = () => cb(null);
  };
  const server = net.createServer(aedes.handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const b = billing({ reconnectDebounceMs: 0 });
  const client = mqttPkg.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'real-dev', reconnectPeriod: 0 });
  try {
    b.wrapMqttClient(client, { customerId: 'cust_real' });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });
    const acked = client.publishAsync('sensors/real', 'x', { qos: 1 });
    // Wait until the broker holds the publish (it reached authorizePublish).
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 5));
    expect(release).toBeDefined();
    await b.flush();
    expect(types()).toEqual(['CONNECT']);
    release!();
    await acked;
    await b.flush();
    expect(types()).toEqual(['CONNECT', 'PUBLISH']);
  } finally {
    await new Promise<void>((r) => client.end(true, {}, () => r()));
    await b.shutdown();
    await new Promise<void>((r) => aedes.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('onError receives a CoreTransportError whose kind names the problem', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => '{"detail":"bad"}' })) as any;
  const errors: Error[] = [];
  const b = billing({ onError: (e: Error) => errors.push(e) });
  const { client, pending } = fakeClient();
  b.wrapMqttClient(client, { customerId: 'cust_1' });
  client.publish('t', 'x');
  pending[0](null);
  await b.flush();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(CoreTransportError);
  expect(errors[0]).toMatchObject({ kind: 'rejected', status: 400 });
  expect((errors[0] as CoreTransportError<any>).events.map((e: any) => e.mqttEventType)).toEqual(['PUBLISH']);
  await b.shutdown();
});
