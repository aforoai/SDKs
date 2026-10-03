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
import { AforoGrpcBilling, outcomeFromGrpcStatus } from '../index';

const MODULE_KEY = 'node-grpc';

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

    const billing = new AforoGrpcBilling({
      tenantId: 'tenant-001',
      productId: 'prod-grpc-001',
      apiKey: 'sk_test_abc',
      ingestorUrl: 'https://ingest.test.aforo.ai',
      serviceName: 'acme.v1.UserService',
    });

    // Record one event through the public wrapUnary surface.
    const wrapped = billing.wrapUnary('GetUser', async () => ({ ok: true }));
    wrapped({ metadata: { getMap: () => ({ 'x-customer-id': 'cust_contract' }) } } as any, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the handler promise chain settle
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
    for (const ev of body[spec.batchKey]) expect(ev.productType).toBe('GRPC_API');
  });

  it('sends executionStatus as a contracted optional event field; every derivable value is contracted', async () => {
    const spec = fixture.endpoints[fixture.sdks[MODULE_KEY].endpoint];
    const statusSpec = spec.eventOptionalFields.executionStatus;
    expect(statusSpec).toBeDefined();

    // Every value outcomeFromGrpcStatus can return (codes 0-16 + unknown).
    const derivable = new Set<string>();
    for (let code = 0; code <= 17; code++) derivable.add(outcomeFromGrpcStatus(code));
    for (const v of derivable) {
      expect(statusSpec.values).toContain(v);
      expect(v.length).toBeLessThanOrEqual(statusSpec.maxLength);
    }

    const billing = new AforoGrpcBilling({
      tenantId: 'tenant-001',
      productId: 'prod-grpc-001',
      apiKey: 'sk_test_abc',
      ingestorUrl: 'https://ingest.test.aforo.ai',
      serviceName: 'acme.v1.UserService',
    });
    const call = { metadata: { getMap: () => ({ 'x-customer-id': 'cust_contract' }) } } as any;
    billing.wrapUnary('GetUser', async () => { throw Object.assign(new Error('late'), { code: 4 }); })(call, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await billing.shutdown();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    assertBodyMatchesContract(spec, body);
    const [event] = body[spec.batchKey];
    expect(event.executionStatus).toBe('TIMEOUT');
    expect(statusSpec.values).toContain(event.executionStatus);
  });
});
