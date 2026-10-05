/**
 * Ingest-contract guard (A+ delivery-guarantee prompt 7).
 *
 * Validates the OBSERVED wire request (endpoint path + body shape) against
 * the shared, checked-in contract fixture at contract/ingest-contract.json —
 * derived from the REAL usage-ingestor controllers/DTOs, never from this
 * SDK's own constants. A test that asserts the SDK against the SDK's own
 * endpoint constant has zero contract coverage (2026-07-05 D1 incident).
 */

import * as fs from 'fs';
import * as path from 'path';
import { AforoMcpBilling } from '../src/index';

const MODULE_KEY = 'node-mcp';

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
    mockFetch.mockResolvedValue({ ok: true, status: 202 });
  });

  it('POSTs to the contracted endpoint with the contracted body shape', async () => {
    const sdkEntry = fixture.sdks[MODULE_KEY];
    expect(sdkEntry).toBeDefined(); // module must be registered in the fixture
    const endpoint: string = sdkEntry.endpoint;
    const spec = fixture.endpoints[endpoint];
    expect(spec).toBeDefined();

    const billing = new AforoMcpBilling({
      tenantId: 'tenant_test',
      productId: 'prod_mcp_001',
      apiKey: 'sk_mcp_abc',
      ingestorUrl: 'https://ingest.test.aforo.ai',
    });

    billing.recordToolInvocation('search_documents', 'agent_contract', 'sess_1', 'SUCCESS', 42);
    await billing.shutdown();

    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe(endpoint);
    expect(options.method).toBe('POST');
    assertBodyMatchesContract(spec, JSON.parse(options.body));
    // Auth: X-API-Key only (the server accepts it for every key type).
    expect(options.headers['X-API-Key']).toBe('sk_mcp_abc');
    expect(options.headers['Authorization']).toBeUndefined();
    // The production ingestor requires an explicit top-level productType.
    const usage = JSON.parse(options.body)[spec.batchKey].find((e: any) => e.metricName !== 'system.session.heartbeat');
    expect(usage.productType).toBe('MCP_SERVER');
  });
});
