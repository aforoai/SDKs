/**
 * executionStatus on MQTT usage events: explicit only (the SDK never derives
 * one), trimmed + upper-cased, omitted when unset.
 */

import { AforoMqttBilling } from '../index';
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
  productId: 'prod-mqtt-001',
  apiKey: 'sk_mqtt_abc',
  ingestorUrl: 'https://api.aforo.ai',
  flushCount: 100,
});

const events = () => bodies.flatMap((b) => b.events);
const settle = () => new Promise((r) => setTimeout(r, 10));

class FakeClient extends EventEmitter {
  options = { clientId: 'dev-1' };
  publish = jest.fn((_t: string, _m: any, _o?: any, _cb?: any) => undefined);
}

describe('wrapAedesBroker', () => {
  test('fixed string is trimmed + upper-cased', async () => {
    const billing = new AforoMqttBilling(config());
    const broker = new EventEmitter();
    billing.wrapAedesBroker(broker as any, { resolveCustomerId: () => 'cust_001', executionStatus: ' success ' });
    broker.emit('publish', { topic: 't', qos: 0, payload: Buffer.from('x') }, { id: 'dev-1' });
    await settle();
    await billing.shutdown();
    expect(events()[0].executionStatus).toBe('SUCCESS');
  });

  test('resolver receives the event and client ID', async () => {
    const billing = new AforoMqttBilling(config());
    const broker = new EventEmitter();
    const resolver = jest.fn((ev: any, clientId: string) => (ev.mqttEventType === 'PUBLISH' && clientId === 'dev-1' ? 'partial' : undefined));
    billing.wrapAedesBroker(broker as any, { resolveCustomerId: () => 'cust_001', executionStatus: resolver });
    broker.emit('publish', { topic: 't', qos: 0, payload: Buffer.from('x') }, { id: 'dev-1' });
    broker.emit('client', { id: 'dev-1' });
    await settle();
    await billing.shutdown();
    const byType = Object.fromEntries(events().map((e) => [e.mqttEventType, e]));
    expect(byType.PUBLISH.executionStatus).toBe('PARTIAL');
    expect('executionStatus' in byType.CONNECT).toBe(false);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  test('unset or blank → key omitted', async () => {
    const billing = new AforoMqttBilling(config());
    const a = new EventEmitter();
    const b = new EventEmitter();
    billing.wrapAedesBroker(a as any, { resolveCustomerId: () => 'cust_001' });
    billing.wrapAedesBroker(b as any, { resolveCustomerId: () => 'cust_002', executionStatus: '   ' });
    a.emit('publish', { topic: 't', qos: 0, payload: Buffer.from('x') }, { id: 'dev-1' });
    b.emit('publish', { topic: 't', qos: 0, payload: Buffer.from('x') }, { id: 'dev-2' });
    await settle();
    await billing.shutdown();
    expect(events()).toHaveLength(2);
    for (const ev of events()) expect('executionStatus' in ev).toBe(false);
  });
});

describe('wrapMqttClient', () => {
  test('explicit value on publishes; a throwing resolver omits the key', async () => {
    const billing = new AforoMqttBilling(config());
    const ok = new FakeClient();
    const bad = new FakeClient();
    billing.wrapMqttClient(ok as any, { customerId: 'cust_001', executionStatus: (ev) => (ev.mqttEventType === 'PUBLISH' ? 'Blocked' : undefined) });
    billing.wrapMqttClient(bad as any, { customerId: 'cust_002', executionStatus: () => { throw new Error('bug'); } });
    (ok as any).publish('a/b', 'hello');
    ok.emit('connect');
    (bad as any).publish('a/b', 'hello');
    await billing.shutdown();
    const [okPublish, okConnect, badPublish] = events();
    expect(okPublish.executionStatus).toBe('BLOCKED');
    expect('executionStatus' in okConnect).toBe(false);
    expect('executionStatus' in badPublish).toBe(false);
  });
});

describe('invalid executionStatus', () => {
  test('unknown or over-long value is reported via onError and omitted; the event is still sent', async () => {
    const onError = jest.fn();
    const billing = new AforoMqttBilling({ ...config(), onError });
    const a = new EventEmitter();
    const b = new EventEmitter();
    billing.wrapAedesBroker(a as any, { resolveCustomerId: () => 'cust_001', executionStatus: 'bogus' });
    billing.wrapAedesBroker(b as any, { resolveCustomerId: () => 'cust_002', executionStatus: 'X'.repeat(21) });
    a.emit('publish', { topic: 't/a', qos: 1, payload: Buffer.from('xyz') }, { id: 'dev-1' });
    b.emit('publish', { topic: 't/b', qos: 0, payload: Buffer.from('x') }, { id: 'dev-2' });
    await settle();
    await billing.shutdown();
    expect(events()).toHaveLength(2);
    for (const ev of events()) expect('executionStatus' in ev).toBe(false);
    expect(events()[0].mqttTopic).toBe('t/a');
    expect(events()[0].dataBytes).toBe(3);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0][0].message).toContain('unknown executionStatus "BOGUS"');
  });

  test('async resolver: Promise is omitted, rejection swallowed, onError told', async () => {
    const onError = jest.fn();
    const billing = new AforoMqttBilling({ ...config(), onError });
    const client = new FakeClient();
    billing.wrapMqttClient(client as any, {
      customerId: 'cust_001',
      executionStatus: (async () => { throw new Error('late'); }) as any,
    });
    (client as any).publish('a/b', 'hello');
    await settle();
    await billing.shutdown();
    expect(events()).toHaveLength(1);
    expect('executionStatus' in events()[0]).toBe(false);
    expect(JSON.stringify(bodies)).not.toContain('[object Promise]');
    expect(onError.mock.calls[0][0].message).toContain('Promise');
  });
});
