/**
 * Tests for AforoMqttBilling. Unique bits vs. gRPC family canary:
 *   - 6 event types (PUBLISH / DELIVER / SUBSCRIBE / UNSUBSCRIBE / CONNECT / DISCONNECT)
 *   - DELIVER off by default (opt-in via emitDeliverEvents)
 *   - QoS + retained flags carried on every event
 *   - wrapAedesBroker + wrapMqttClient integrations
 */

import { AforoMqttBilling } from '../index';
import { EventEmitter } from 'events';

// ── HTTP capture ────────────────────────────────────────────────────────

let capturedRequests: any[];

beforeEach(() => {
  capturedRequests = [];
  global.fetch = jest.fn(async (input: any, init: any = {}) => {
    let body: any = init.body;
    try { body = JSON.parse(init.body); } catch { /* ignore */ }
    capturedRequests.push({ url: String(input), init, body });
    return { ok: true, status: 200, statusText: 'OK' } as unknown as Response;
  }) as any;
});

const config = () => ({
  tenantId: 'tenant-001',
  productId: 'prod-mqtt-001',
  apiKey: 'sk_mqtt_abc',
  ingestorUrl: 'https://api.aforo.ai',
});

const drainedEvents = () => capturedRequests.flatMap(r => r.body?.events ?? []);

// ── Aedes broker wrapping ───────────────────────────────────────────────

describe('wrapAedesBroker', () => {
  test('PUBLISH event: records topic, qos, retained, bytes', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 1 });
    const broker = new EventEmitter();
    billing.wrapAedesBroker(broker as any, {
      resolveCustomerId: () => 'cust_from_broker',
    });

    broker.emit('publish', {
      topic: 'sensors/room-a/temperature',
      qos: 1,
      retain: false,
      payload: Buffer.from('23.4'),
    }, { id: 'device-001', username: 'api' });
    await new Promise((r) => setTimeout(r, 20));

    const ev = drainedEvents()[0];
    expect(ev.productType).toBe('MQTT_BROKER');
    expect(ev.mqttEventType).toBe('PUBLISH');
    expect(ev.mqttTopic).toBe('sensors/room-a/temperature');
    expect(ev.mqttQos).toBe(1);
    expect(ev.mqttRetained).toBe(false);
    expect(ev.mqttClientId).toBe('device-001');
    expect(ev.dataBytes).toBe(4);   // "23.4"
    expect(ev.customerId).toBe('cust_from_broker');
    expect(ev.metricName).toBe('mqtt_broker.publish');
    await billing.shutdown();
  });

  test('broker-originated publish (null client) is NOT metered', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 100 });
    const broker = new EventEmitter();
    billing.wrapAedesBroker(broker as any, { resolveCustomerId: () => 'c' });

    broker.emit('publish', { topic: 't', qos: 0, retain: false, payload: Buffer.from('x') }, null);
    await billing.shutdown();

    expect(drainedEvents()).toHaveLength(0);
  });

  test('SUBSCRIBE event for each topic in a multi-topic subscription', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 100 });
    const broker = new EventEmitter();
    billing.wrapAedesBroker(broker as any, { resolveCustomerId: () => 'cust_001' });

    broker.emit('subscribe', [
      { topic: 'sensors/+/temperature', qos: 1 },
      { topic: 'sensors/+/humidity', qos: 2 },
    ], { id: 'device-001' });
    await new Promise((r) => setTimeout(r, 20));  // let async broker handler finish
    await billing.shutdown();

    const subs = drainedEvents().filter((e: any) => e.mqttEventType === 'SUBSCRIBE');
    expect(subs).toHaveLength(2);
    expect(subs.map((e: any) => e.mqttTopic).sort())
        .toEqual(['sensors/+/humidity', 'sensors/+/temperature']);
    expect(subs.find((e: any) => e.mqttTopic === 'sensors/+/temperature').mqttQos).toBe(1);
    expect(subs.find((e: any) => e.mqttTopic === 'sensors/+/humidity').mqttQos).toBe(2);
  });

  test('CONNECT + DISCONNECT lifecycle events', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 100 });
    const broker = new EventEmitter();
    billing.wrapAedesBroker(broker as any, { resolveCustomerId: () => 'cust_001' });

    broker.emit('client', { id: 'device-001', username: 'api' });
    broker.emit('clientDisconnect', { id: 'device-001', username: 'api' });
    await new Promise((r) => setTimeout(r, 20));  // let async broker handlers finish
    await billing.shutdown();

    const events = drainedEvents();
    expect(events.find((e: any) => e.mqttEventType === 'CONNECT')).toBeDefined();
    expect(events.find((e: any) => e.mqttEventType === 'DISCONNECT')).toBeDefined();
  });

  test('resolveCustomerId returning undefined → event NOT metered', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 100 });
    const broker = new EventEmitter();
    billing.wrapAedesBroker(broker as any, { resolveCustomerId: () => undefined });

    broker.emit('publish', {
      topic: 't', qos: 0, retain: false, payload: Buffer.from('x'),
    }, { id: 'unknown-device' });
    await billing.shutdown();

    expect(drainedEvents()).toHaveLength(0);
  });

  test('resolveMetadata callback attaches per-client tags', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 1 });
    const broker = new EventEmitter();
    billing.wrapAedesBroker(broker as any, {
      resolveCustomerId: () => 'cust_001',
      resolveMetadata: (clientId) => ({ deviceClass: 'sensor-v3', clientId }),
    });

    broker.emit('publish', {
      topic: 't', qos: 0, retain: false, payload: Buffer.from('x'),
    }, { id: 'device-001' });
    await new Promise((r) => setTimeout(r, 20));

    const ev = drainedEvents()[0];
    expect(ev.metadata.deviceClass).toBe('sensor-v3');
    expect(ev.metadata.clientId).toBe('device-001');
    await billing.shutdown();
  });
});

// ── mqtt.js client wrapping ─────────────────────────────────────────────

describe('wrapMqttClient', () => {
  test('PUBLISH is recorded when client.publish is invoked', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 1 });
    const origPublish = jest.fn(() => 'published');
    const client: any = new EventEmitter();
    client.publish = origPublish;
    client.options = { clientId: 'device-123' };

    billing.wrapMqttClient(client, { customerId: 'cust_001' });
    client.publish('devices/123/status', '{"online":true}', { qos: 1, retain: true });
    await new Promise((r) => setTimeout(r, 20));

    const ev = drainedEvents()[0];
    expect(ev.mqttEventType).toBe('PUBLISH');
    expect(ev.mqttTopic).toBe('devices/123/status');
    expect(ev.mqttQos).toBe(1);
    expect(ev.mqttRetained).toBe(true);
    expect(ev.mqttClientId).toBe('device-123');
    expect(ev.customerId).toBe('cust_001');
    expect(origPublish).toHaveBeenCalled();  // original still called
    await billing.shutdown();
  });

  test('CONNECT + DISCONNECT lifecycle fired on connect/close events', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 100 });
    const client: any = new EventEmitter();
    client.publish = jest.fn();
    client.options = { clientId: 'c1' };

    billing.wrapMqttClient(client, { customerId: 'cust_001' });
    client.emit('connect');
    client.emit('close');
    await billing.shutdown();

    const events = drainedEvents();
    expect(events.find((e: any) => e.mqttEventType === 'CONNECT')).toBeDefined();
    expect(events.find((e: any) => e.mqttEventType === 'DISCONNECT')).toBeDefined();
  });

  test('DELIVER event (on message) is NOT emitted when emitDeliverEvents=false', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 100 });
    const client: any = new EventEmitter();
    client.publish = jest.fn();
    client.options = { clientId: 'c1' };

    billing.wrapMqttClient(client, { customerId: 'cust_001' });
    client.emit('message', 't', Buffer.from('x'), { qos: 0, retain: false });
    await billing.shutdown();

    const delivers = drainedEvents().filter((e: any) => e.mqttEventType === 'DELIVER');
    expect(delivers).toHaveLength(0);
  });

  test('DELIVER event IS emitted when emitDeliverEvents=true', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 100, emitDeliverEvents: true });
    const client: any = new EventEmitter();
    client.publish = jest.fn();
    client.options = { clientId: 'c1' };

    billing.wrapMqttClient(client, { customerId: 'cust_001' });
    client.emit('message', 'sensors/a', Buffer.from('payload'), { qos: 1, retain: false });
    await billing.shutdown();

    const delivers = drainedEvents().filter((e: any) => e.mqttEventType === 'DELIVER');
    expect(delivers).toHaveLength(1);
    expect(delivers[0].mqttTopic).toBe('sensors/a');
    expect(delivers[0].mqttQos).toBe(1);
    expect(delivers[0].dataBytes).toBe(7);   // "payload"
  });
});

// ── Event shape ─────────────────────────────────────────────────────────

describe('event shape', () => {
  test('idempotencyKey: mqtt:{tenant}:{clientId}:{eventType}:{millis}:{8-hex}', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 1 });
    const broker = new EventEmitter();
    billing.wrapAedesBroker(broker as any, { resolveCustomerId: () => 'cust_001' });

    broker.emit('publish', {
      topic: 'a/b', qos: 0, retain: false, payload: Buffer.from('x'),
    }, { id: 'c1' });
    await new Promise((r) => setTimeout(r, 20));

    const key = drainedEvents()[0].idempotencyKey;
    expect(key).toMatch(/^mqtt:tenant-001:c1:PUBLISH:\d+:[a-z0-9]{8}$/);
    await billing.shutdown();
  });

  test('metricName per event type', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 100 });
    const broker = new EventEmitter();
    billing.wrapAedesBroker(broker as any, { resolveCustomerId: () => 'cust_001' });

    broker.emit('publish', { topic: 't', qos: 0, retain: false, payload: Buffer.from('x') }, { id: 'c' });
    broker.emit('subscribe', [{ topic: 't', qos: 0 }], { id: 'c' });
    broker.emit('unsubscribe', ['t'], { id: 'c' });
    broker.emit('client', { id: 'c' });
    broker.emit('clientDisconnect', { id: 'c' });
    await new Promise((r) => setTimeout(r, 20));  // let async broker handlers finish
    await billing.shutdown();

    const names = drainedEvents().map((e: any) => e.metricName).sort();
    expect(names).toEqual([
      'mqtt_broker.connect',
      'mqtt_broker.disconnect',
      'mqtt_broker.publish',
      'mqtt_broker.subscribe',
      'mqtt_broker.unsubscribe',
    ]);
  });
});

function assertBatchContract(reqs: any[], apiKey: string, allowed: string[]) {
  const allowedSet = new Set(allowed);
  expect(reqs.length).toBeGreaterThan(0);
  for (const r of reqs) {
    expect(r.url).toBe('https://api.aforo.ai/v1/ingest/batch');
    expect((r.init.headers as Record<string, string>)['X-API-Key']).toBe(apiKey);
    expect(Object.keys(r.body)).toEqual(['events']);
    expect(r.body.events.length).toBeGreaterThan(0);
    expect(r.body.events.length).toBeLessThanOrEqual(1000);
    for (const e of r.body.events) {
      for (const k of Object.keys(e)) expect(allowedSet.has(k) ? k : `unexpected field ${k}`).toBe(k);
      expect(JSON.stringify(e)).not.toContain(apiKey);
      for (const k of ['customerId', 'metricName', 'occurredAt', 'idempotencyKey', 'mqttTopic']) {
        expect(typeof e[k]).toBe('string');
        expect(e[k].trim()).not.toBe('');
      }
      expect(e.quantity).toBeGreaterThan(0);
      expect([0, 1, 2]).toContain(e.mqttQos);
    }
  }
}

describe('ingest batch contract', () => {
  const FIELDS = ['customerId', 'metricName', 'quantity', 'occurredAt', 'idempotencyKey', 'productType', 'metadata', 'mqttTopic', 'mqttQos', 'mqttRetained',
    'mqttEventType', 'mqttClientId', 'dataBytes'];

  test('events carry only IngestUsageEventRequest fields; CONNECT/DISCONNECT get a $SYS topic', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 100 });
    const broker = new EventEmitter();
    billing.wrapAedesBroker(broker as any, { resolveCustomerId: () => 'cust_001' });
    broker.emit('client', { id: 'c' });
    broker.emit('publish', { topic: 't', qos: 7, retain: false, payload: Buffer.from('x') }, { id: 'c' });
    broker.emit('unsubscribe', [''], { id: 'c' });
    broker.emit('clientDisconnect', { id: 'c' });
    await new Promise((r) => setTimeout(r, 20));
    await billing.shutdown();
    assertBatchContract(capturedRequests, 'sk_mqtt_abc', FIELDS);
    const events = drainedEvents();
    expect(events.map((e: any) => e.mqttEventType).sort()).toEqual(['CONNECT', 'DISCONNECT', 'PUBLISH']);
    expect(events.find((e: any) => e.mqttEventType === 'CONNECT').mqttTopic).toBe('$SYS/clients/c/connected');
    expect(events.find((e: any) => e.mqttEventType === 'DISCONNECT').mqttTopic).toBe('$SYS/clients/c/disconnected');
    expect(events.find((e: any) => e.mqttEventType === 'PUBLISH').mqttQos).toBe(0);
  });

  test('>1000 buffered events are split into requests of <=1000', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 5000 });
    const client: any = new EventEmitter();
    client.publish = jest.fn();
    client.options = { clientId: 'c1' };
    billing.wrapMqttClient(client, { customerId: 'cust_001' });
    for (let i = 0; i < 2500; i++) client.publish('t/' + i, 'x', { qos: 1 });
    await billing.shutdown();
    expect(capturedRequests.map((r) => r.body.events.length)).toEqual([1000, 1000, 500]);
    assertBatchContract(capturedRequests, 'sk_mqtt_abc', FIELDS);
  });

  test('over-long topic and clientId are trimmed to ingestor limits', async () => {
    const billing = new AforoMqttBilling({ ...config(), flushCount: 100 });
    const client: any = new EventEmitter();
    client.publish = jest.fn();
    billing.wrapMqttClient(client, { customerId: 'cust_001', clientId: 'k'.repeat(300) });
    client.publish('t'.repeat(900), 'x');
    await billing.shutdown();
    const ev = drainedEvents()[0];
    expect(ev.mqttTopic.length).toBe(500);
    expect(ev.mqttClientId.length).toBe(128);
    expect(ev.idempotencyKey.length).toBeLessThanOrEqual(255);
  });
});

describe('productType', () => {
  test('defaults to MQTT_BROKER; client option is trimmed + uppercased; per-integration value wins', async () => {
    const def = new AforoMqttBilling({ ...config(), flushCount: 100 });
    const c0: any = new EventEmitter();
    c0.publish = jest.fn();
    def.wrapMqttClient(c0, { customerId: 'cust_001' });
    c0.publish('t/1', 'x');
    await def.shutdown();
    expect(drainedEvents()[0].productType).toBe('MQTT_BROKER');

    capturedRequests = [];
    const b = new AforoMqttBilling({ ...config(), flushCount: 100, productType: ' agentic_api ' });
    const mk = () => { const c: any = new EventEmitter(); c.publish = jest.fn(); return c; };
    const cDefault = mk(), cCustom = mk(), cBlank = mk();
    b.wrapMqttClient(cDefault, { customerId: 'c_default' });
    b.wrapMqttClient(cCustom, { customerId: 'c_custom', productType: ' custom_type ' });
    b.wrapMqttClient(cBlank, { customerId: 'c_blank', productType: '  ' });
    cDefault.publish('t/1', 'x');
    cCustom.publish('t/1', 'x');
    cBlank.publish('t/1', 'x');
    const broker: any = new EventEmitter();
    b.wrapAedesBroker(broker, { resolveCustomerId: () => 'c_broker', productType: 'api' });
    broker.emit('publish', { topic: 't/2', payload: 'y' }, { id: 'dev-1' });
    await new Promise((r) => setTimeout(r, 20));
    await b.shutdown();
    expect(drainedEvents().map((e: any) => `${e.customerId}=${e.productType}`)).toEqual([
      'c_default=AGENTIC_API', 'c_custom=CUSTOM_TYPE', 'c_blank=AGENTIC_API', 'c_broker=API',
    ]);
  });

  test('blank / whitespace mqttTopic is dropped client-side', async () => {
    const b = new AforoMqttBilling({ ...config(), flushCount: 100 });
    const c: any = new EventEmitter();
    c.publish = jest.fn();
    b.wrapMqttClient(c, { customerId: 'cust_001' });
    c.publish('', 'x');
    c.publish('   ', 'x');
    await b.shutdown();
    expect(capturedRequests).toHaveLength(0);
  });
});

describe('batch response handling', () => {
  const resp = (status: number, body: any = {}, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300, status, statusText: String(status),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response);
  const respondWith = (next: () => Response) => {
    global.fetch = jest.fn(async (input: any, init: any = {}) => {
      capturedRequests.push({ url: String(input), init, body: JSON.parse(init.body) });
      return next();
    }) as any;
  };

  test('4xx (not 408/429) is not retried and reports errors[].message', async () => {
    const onError = jest.fn();
    respondWith(() => resp(400, { errors: [{ index: 0, message: 'field is required' }] }));
    await meterOnce(onError);
    expect(capturedRequests).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toMatch(/HTTP 400.*field is required.*not retried/);
  });

  test('429 honours Retry-After and 408 is retried; same idempotencyKeys re-sent', async () => {
    const onError = jest.fn();
    const seq = [resp(429, {}, { 'retry-after': '0' }), resp(408, {}, { 'retry-after': '0' }), resp(202, { accepted: 1, failed: 0 })];
    respondWith(() => seq.shift()!);
    await meterOnce(onError);
    expect(capturedRequests).toHaveLength(3);
    expect(new Set(capturedRequests.map((r: any) => r.body.events[0].idempotencyKey)).size).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test('202 with failed > 0 reports per-event errors[].message via onError', async () => {
    const onError = jest.fn();
    respondWith(() => resp(202, { accepted: 0, duplicates: 0, failed: 1, errors: [{ index: 0, message: 'bad event' }] }));
    await meterOnce(onError);
    expect(capturedRequests).toHaveLength(1);
    expect(onError.mock.calls[0][0].message).toMatch(/rejected 1 event\(s\).*#0: bad event/);
  });
});

async function meterOnce(onError: (e: Error) => void) {
  const b = new AforoMqttBilling({ ...config(), flushCount: 100, onError });
  const c: any = new EventEmitter();
  c.publish = jest.fn();
  b.wrapMqttClient(c, { customerId: 'cust_001' });
  c.publish('t/1', 'x');
  await b.shutdown();
}
