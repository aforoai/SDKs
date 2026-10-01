/**
 * Ingest-contract guard (A+ delivery-guarantee prompt 7).
 *
 * Validates the OBSERVED wire request (endpoint path + body shape) against
 * the shared, checked-in contract fixture at contract/ingest-contract.json —
 * derived from the REAL usage-ingestor controllers/DTOs, never from this
 * SDK's own constants. The 2026-07-05 D1 incident shipped this very SDK
 * posting a batch body to a single-event endpoint; its own green suite hid
 * 100% event loss because it asserted the SDK's own (wrong) constant.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AforoMqttBilling } from '../index';

const MODULE_KEY = 'node-mqtt';

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../contract/ingest-contract.json'), 'utf8'),
);

function assertRequired(obj: any, field: string): void {
  const v = obj[field];
  expect(v).toBeDefined();
  expect(v).not.toBeNull();
  if (typeof v === 'string') expect(v.trim()).not.toBe('');
}

/** Same assertion shape in every SDK suite (all languages). */
function assertBodyMatchesContract(spec: any, body: any): void {
  expect(body).not.toBeNull();
  expect(typeof body).toBe('object');
  if (spec.cardinality === 'batch-wrapped') {
    // A bare array here is the /v1/ingest/async-batch shape — wrong for this endpoint.
    expect(Array.isArray(body)).toBe(false);
    const events = body[spec.batchKey];
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(spec.maxEvents);
    for (const ev of events) {
      for (const field of spec.eventRequiredFields) assertRequired(ev, field);
    }
  } else if (spec.cardinality === 'single') {
    expect(Array.isArray(body)).toBe(false);
    for (const key of spec.forbiddenTopLevelKeys ?? []) {
      expect(body[key]).toBeUndefined();
    }
    for (const field of spec.requiredFields) assertRequired(body, field);
  } else {
    throw new Error(`Unhandled cardinality in fixture: ${spec.cardinality}`);
  }
}

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('ingest contract guard (shared fixture)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202 });
  });

  it('POSTs to the contracted endpoint with the contracted body shape', async () => {
    const sdkEntry = fixture.sdks[MODULE_KEY];
    expect(sdkEntry).toBeDefined(); // module must be registered in the fixture
    const endpoint: string = sdkEntry.endpoint;
    const spec = fixture.endpoints[endpoint];
    expect(spec).toBeDefined();

    const billing = new AforoMqttBilling({
      tenantId: 'tenant-001',
      productId: 'prod-mqtt-001',
      apiKey: 'sk_test_abc',
      ingestorUrl: 'https://ingest.test.aforo.ai',
    });

    // Record one PUBLISH event through the public wrapAedesBroker surface.
    const handlers: Record<string, Function> = {};
    const broker = { on: (evt: string, fn: Function) => { handlers[evt] = fn; } } as any;
    billing.wrapAedesBroker(broker, { resolveCustomerId: () => 'cust_contract' });
    await handlers['publish'](
      { topic: 'sensors/temp', payload: Buffer.from('22.5'), qos: 1, retain: false },
      { id: 'client-1' },
    );
    await billing.shutdown();

    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe(endpoint);
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    assertBodyMatchesContract(spec, body);
    // The API key travels as X-API-Key only; every event names its product type.
    expect(options.headers['X-API-Key']).toBe('sk_test_abc');
    expect(options.headers['Authorization']).toBeUndefined();
    for (const ev of body[spec.batchKey]) expect(ev.productType).toBe('MQTT_BROKER');
  });

  it('sends executionStatus as a contracted optional event field only when set (never derived)', async () => {
    const spec = fixture.endpoints[fixture.sdks[MODULE_KEY].endpoint];
    const statusSpec = spec.eventOptionalFields.executionStatus;
    expect(statusSpec).toBeDefined();

    const billing = new AforoMqttBilling({
      tenantId: 'tenant-001',
      productId: 'prod-mqtt-001',
      apiKey: 'sk_test_abc',
      ingestorUrl: 'https://ingest.test.aforo.ai',
    });
    const handlers: Record<string, Function> = {};
    const broker = { on: (evt: string, fn: Function) => { handlers[evt] = fn; } } as any;
    billing.wrapAedesBroker(broker, {
      resolveCustomerId: () => 'cust_contract',
      executionStatus: (ev) => (ev.mqttTopic === 'sensors/ok' ? 'success' : undefined),
    });
    await handlers['publish']({ topic: 'sensors/ok', payload: Buffer.from('1'), qos: 0 }, { id: 'client-1' });
    await handlers['publish']({ topic: 'sensors/other', payload: Buffer.from('2'), qos: 0 }, { id: 'client-1' });
    await billing.shutdown();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    assertBodyMatchesContract(spec, body);
    const [withStatus, withoutStatus] = body[spec.batchKey];
    expect(withStatus.executionStatus).toBe('SUCCESS');
    expect(statusSpec.values).toContain(withStatus.executionStatus);
    expect(withStatus.executionStatus.length).toBeLessThanOrEqual(statusSpec.maxLength);
    // The SDK derives nothing: no caller value → no key.
    expect('executionStatus' in withoutStatus).toBe(false);
  });
});
