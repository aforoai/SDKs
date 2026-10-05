/**
 * Ingest-contract guard (A+ delivery-guarantee prompt 7).
 *
 * Validates the OBSERVED wire request (endpoint path + body shape) against
 * the shared, checked-in contract fixture at contract/ingest-contract.json —
 * which is derived from the REAL usage-ingestor controllers/DTOs, never from
 * this SDK's own constants. A test that asserts the SDK against the SDK's own
 * endpoint constant has zero contract coverage (the 2026-07-05 D1 incident:
 * 16 variant SDKs posted a batch body to a single-event endpoint, every flush
 * 400'd, and 17 green suites hid 100% event loss).
 */

import * as fs from 'fs';
import * as path from 'path';
import { AforoClient } from '../src/client';

const MODULE_KEY = 'node';

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../contract/ingest-contract.json'), 'utf8'),
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
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });
  });

  it('POSTs to the contracted endpoint with the contracted body shape', async () => {
    const sdkEntry = fixture.sdks[MODULE_KEY];
    expect(sdkEntry).toBeDefined(); // module must be registered in the fixture
    const endpoint: string = sdkEntry.endpoint;
    const spec = fixture.endpoints[endpoint];
    expect(spec).toBeDefined();

    const client = new AforoClient({
      apiKey: 'test-key',
      baseUrl: 'https://ingest.test.aforo.ai',
      flushCount: 1, // flush on first track
      flushInterval: 60_000,
      maxRetries: 0,
      timeout: 5000,
    });

    await client.track({ customerId: 'cust_contract', metricName: 'api_calls', quantity: 1 });
    await client.shutdown();

    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe(endpoint);
    expect(options.method).toBe('POST');
    assertBodyMatchesContract(spec, JSON.parse(options.body));
    // Auth: X-API-Key only (the server accepts it for every key type).
    expect(options.headers['X-API-Key']).toBe('test-key');
    expect(options.headers['Authorization']).toBeUndefined();
    // The production ingestor requires an explicit top-level productType.
    expect(JSON.parse(options.body)[spec.batchKey][0].productType).toBe('API');
  });

  it('sends executionStatus as a contracted optional event field only when set', async () => {
    const spec = fixture.endpoints[fixture.sdks[MODULE_KEY].endpoint];
    const statusSpec = spec.eventOptionalFields.executionStatus;
    expect(statusSpec).toBeDefined();

    const client = new AforoClient({
      apiKey: 'test-key',
      baseUrl: 'https://ingest.test.aforo.ai',
      flushCount: 2,
      flushInterval: 60_000,
      maxRetries: 0,
      timeout: 5000,
    });
    await client.track({ customerId: 'cust_contract', metricName: 'api_calls', executionStatus: 'timeout' });
    await client.track({ customerId: 'cust_contract', metricName: 'api_calls' });
    await client.shutdown();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    assertBodyMatchesContract(spec, body);
    const [withStatus, withoutStatus] = body[spec.batchKey];
    expect(withStatus.executionStatus).toBe('TIMEOUT');
    expect(statusSpec.values).toContain(withStatus.executionStatus);
    expect(withStatus.executionStatus.length).toBeLessThanOrEqual(statusSpec.maxLength);
    expect('executionStatus' in withoutStatus).toBe(false);
  });
});
