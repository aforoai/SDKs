/**
 * Topic and client id come off incoming MQTT packets. Over-long ones are
 * truncated to the ingestor's limits (mqttTopic 500, mqttClientId 128) and the
 * event is still sent; fields the caller sets still drop the event as invalid.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'events';
import { AforoMqttBilling, truncateToLimit, type MqttUsageEvent } from '../index';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const sent = (): MqttUsageEvent[] => mockFetch.mock.calls.flatMap((c) => JSON.parse(c[1].body).events);
const tick = () => new Promise((r) => setImmediate(r));
const wholeCharacterEnd = (text: string) => {
  const last = text.charCodeAt(text.length - 1);
  return !(last >= 0xd800 && last <= 0xdbff);
};

describe('request-derived mqttTopic / mqttClientId', () => {
  let warn: jest.SpyInstance;
  let billing: AforoMqttBilling;
  let drops: Array<{ events: MqttUsageEvent[]; reason: string }>;
  const truncationWarnings = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('truncated to'));

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    drops = [];
    billing = new AforoMqttBilling({
      tenantId: 'tenant-001', productId: 'prod-mqtt-001', apiKey: 'k', ingestorUrl: 'https://api.aforo.ai',
      flushCount: 100, onDrop: (events, reason) => drops.push({ events, reason }),
    });
  });

  afterEach(async () => {
    await billing.shutdown();
    warn.mockRestore();
  });

  function broker(resolveCustomerId: (clientId: string) => string | undefined = () => 'cust_001') {
    const b = new EventEmitter();
    const seen: string[] = [];
    billing.wrapAedesBroker(b as any, {
      resolveCustomerId: (clientId) => { seen.push(clientId); return resolveCustomerId(clientId); },
    });
    return { b, seen };
  }
  const publish = (b: EventEmitter, topic: string, clientId = 'device-1') =>
    b.emit('publish', { topic, qos: 0, retain: false, payload: Buffer.from('x') }, { id: clientId });

  test('broker publish: over-long topic is cut to exactly 500 and sent; one WARN across two events', async () => {
    const { b } = broker();
    publish(b, 't/' + 'a'.repeat(900));
    publish(b, 'u/' + 'b'.repeat(700));
    await tick();
    await billing.shutdown();

    const events = sent();
    expect(events).toHaveLength(2);
    expect(events[0].mqttTopic).toBe(('t/' + 'a'.repeat(900)).slice(0, 500));
    expect(events[1].mqttTopic).toHaveLength(500);
    expect(events[0].metricName).toBe('mqtt_broker.publish');
    expect(billing.droppedCount).toBe(0);
    expect(truncationWarnings()).toHaveLength(1);
    expect(truncationWarnings()[0]).toMatch(/mqttTopic .* truncated to 500 characters/);
  });

  test('broker publish: the cut never splits a surrogate pair', async () => {
    const { b } = broker();
    publish(b, 'a'.repeat(499) + '\u{1F600}' + '/tail');
    await tick();
    await billing.shutdown();

    const [ev] = sent();
    expect(ev.mqttTopic).toBe('a'.repeat(499));
    expect(wholeCharacterEnd(ev.mqttTopic)).toBe(true);
  });

  test('broker subscribe / unsubscribe: over-long topics are truncated and sent', async () => {
    const { b } = broker();
    b.emit('subscribe', [{ topic: 's/' + 'a'.repeat(900), qos: 1 }], { id: 'device-1' });
    b.emit('unsubscribe', ['x/' + 'b'.repeat(900)], { id: 'device-1' });
    await tick();
    await billing.shutdown();

    const events = sent();
    expect(events.map((e) => e.mqttEventType).sort()).toEqual(['SUBSCRIBE', 'UNSUBSCRIBE']);
    for (const ev of events) expect(ev.mqttTopic).toHaveLength(500);
  });

  test('broker: over-long client id is cut to 128 on the event; the resolver and the key see the full id', async () => {
    const shared = 'dev-' + 'k'.repeat(200);
    const idA = shared + '-alpha';
    const idB = shared + '-beta';
    const { b, seen } = broker();
    publish(b, 't/1', idA);
    publish(b, 't/1', idA);
    publish(b, 't/1', idB);
    b.emit('client', { id: idA });
    b.emit('clientDisconnect', { id: idA });
    await tick();
    await billing.shutdown();

    const events = sent();
    expect(events).toHaveLength(5);
    const [a1, a2, b1] = events.filter((e) => e.mqttEventType === 'PUBLISH');
    expect(a1.mqttClientId).toBe(idA.slice(0, 128));
    expect(b1.mqttClientId).toBe(a1.mqttClientId); // same label after the cut
    expect(seen.every((id) => id === idA || id === idB)).toBe(true); // customer lookup gets the real id

    const stable = (key: string) => key.replace(/:\d+:[a-z0-9]+$/, '');
    for (const ev of events) expect(ev.idempotencyKey.length).toBeLessThanOrEqual(255);
    expect(stable(a1.idempotencyKey)).toBe(`mqtt:tenant-001:${sha256(idA)}:PUBLISH`);
    expect(stable(a2.idempotencyKey)).toBe(stable(a1.idempotencyKey));
    expect(stable(b1.idempotencyKey)).toBe(`mqtt:tenant-001:${sha256(idB)}:PUBLISH`);
    expect(stable(b1.idempotencyKey)).not.toBe(stable(a1.idempotencyKey));
    expect(a2.idempotencyKey).not.toBe(a1.idempotencyKey); // unique tail kept

    // CONNECT / DISCONNECT stand-in topics stay well-formed.
    const connect = events.find((e) => e.mqttEventType === 'CONNECT')!;
    const disconnect = events.find((e) => e.mqttEventType === 'DISCONNECT')!;
    expect(connect.mqttTopic).toBe(`$SYS/clients/${idA.slice(0, 128)}/connected`);
    expect(disconnect.mqttTopic).toBe(`$SYS/clients/${idA.slice(0, 128)}/disconnected`);

    const warnings = truncationWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/mqttClientId .* truncated to 128 characters/);
  });

  test('a client id that fits keeps the plain key', async () => {
    const { b } = broker();
    publish(b, 't/1', 'device-1');
    await tick();
    await billing.shutdown();

    const [ev] = sent();
    expect(ev.idempotencyKey).toMatch(/^mqtt:tenant-001:device-1:PUBLISH:\d+:[a-z0-9]+$/);
    expect(truncationWarnings()).toHaveLength(0);
  });

  test('mqtt.js client: over-long topics on publish and on incoming messages are truncated and sent', async () => {
    const b2 = new AforoMqttBilling({
      tenantId: 'tenant-001', productId: 'prod-mqtt-001', apiKey: 'k', ingestorUrl: 'https://api.aforo.ai',
      flushCount: 100, emitDeliverEvents: true,
    });
    const client: any = new EventEmitter();
    const original = jest.fn();
    client.publish = original;
    b2.wrapMqttClient(client, { customerId: 'cust_001', clientId: 'c1' });
    client.publish('p/' + 'a'.repeat(900), 'x');
    client.emit('message', 'm/' + 'b'.repeat(900), Buffer.from('x'), { qos: 0 });
    await b2.shutdown();

    const events = sent();
    expect(events.map((e) => e.mqttEventType)).toEqual(['PUBLISH', 'DELIVER']);
    for (const ev of events) expect(ev.mqttTopic).toHaveLength(500);
    // The wrapped publish still gets the caller's topic untouched.
    expect(original.mock.calls[0][0]).toBe('p/' + 'a'.repeat(900));
    expect(b2.droppedCount).toBe(0);
  });

  test('mqtt.js client: an over-long clientId option is cut to 128 and the event is sent; key from the full id', async () => {
    const id = 'k'.repeat(300);
    const client: any = new EventEmitter();
    client.publish = jest.fn();
    billing.wrapMqttClient(client, { customerId: 'cust_001', clientId: id });
    client.publish('t/1', 'x');
    client.emit('connect');
    await billing.shutdown();

    const events = sent();
    expect(events.map((e) => e.mqttEventType)).toEqual(['PUBLISH', 'CONNECT']);
    expect(events[0].mqttClientId).toBe('k'.repeat(128));
    expect(events[1].mqttTopic).toBe(`$SYS/clients/${'k'.repeat(128)}/connected`);
    expect(events[0].idempotencyKey.replace(/:\d+:[a-z0-9]+$/, '')).toBe(`mqtt:tenant-001:${sha256(id)}:PUBLISH`);
    expect(billing.droppedCount).toBe(0);
    expect(truncationWarnings()).toHaveLength(1);
  });

  test('an over-long customerId is still dropped as invalid, even with an over-long topic', async () => {
    const { b } = broker(() => 'c'.repeat(65));
    publish(b, 't/' + 'a'.repeat(900));
    await tick();
    await billing.shutdown();

    expect(sent()).toHaveLength(0);
    expect(drops.map((d) => d.reason)).toEqual(['invalid']);
    expect(drops[0].events[0].customerId).toBe('c'.repeat(65));
  });

  test('truncateToLimit: at or under the limit is unchanged', () => {
    expect(truncateToLimit('a'.repeat(500), 500)).toHaveLength(500);
    expect(truncateToLimit('a'.repeat(498) + '\u{1F600}', 500)).toBe('a'.repeat(498) + '\u{1F600}');
  });
});
