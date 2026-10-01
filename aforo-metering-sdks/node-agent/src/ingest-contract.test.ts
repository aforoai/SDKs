/**
 * Ingest-contract guard (A+ delivery-guarantee prompt 7).
 *
 * Validates the OBSERVED wire request (endpoint path + body shape) against
 * the shared, checked-in contract fixture at contract/ingest-contract.json —
 * derived from the REAL usage-ingestor controllers/DTOs, never from this
 * SDK's own constants. node-agent is the one SDK contracted to the
 * Apigee-format SINGLE-event endpoint /v1/ingest/events (the 2026-07-05 D1
 * sweep reworked its wire path onto it) — this guard locks both the resolved
 * path and the single-event (NOT batch-wrapped) body shape.
 */

import * as fs from 'fs';
import * as path from 'path';
import AforoAgent, { EXECUTION_STATUSES } from './index';

const MODULE_KEY = 'node-agent';

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

describe('ingest contract guard (shared fixture)', () => {
  it('POSTs to the contracted endpoint with the contracted body shape', async () => {
    const sdkEntry = fixture.sdks[MODULE_KEY];
    expect(sdkEntry).toBeDefined(); // module must be registered in the fixture
    const endpoint: string = sdkEntry.endpoint;
    const spec = fixture.endpoints[endpoint];
    expect(spec).toBeDefined();

    const capturingFetch = jest.fn(async () => ({ ok: true, status: 202 }));
    const agent = new AforoAgent({
      tenantId: 'tenant-001',
      productId: 'prod-agent-001',
      apiKey: 'sk_agent_abc',
      customerId: 'cust_contract',
      fetchImpl: capturingFetch,
      // ingestorUrl deliberately omitted: the DEFAULT base must resolve to the
      // contracted path (default already includes /v1/ingest; SDK appends /events).
    } as any);

    await agent.emitEvent({
      eventType: 'agent_step',
      metricKey: 'step_count',
      value: 1,
      agentId: 'agent_contract',
      sessionId: 'sess_contract',
      properties: {},
    });
    await agent.flush();

    expect(capturingFetch).toHaveBeenCalled();
    const [url, options] = capturingFetch.mock.calls[0] as any[];
    expect(new URL(String(url)).pathname).toBe(endpoint);
    expect(options.method).toBe('POST');
    assertBodyMatchesContract(spec, JSON.parse(options.body));
    // Default host is the public API gateway.
    expect(new URL(String(url)).host).toBe('api.aforo.ai');
    // Auth: X-API-Key only (the server accepts it for every key type).
    expect(options.headers['X-API-Key']).toBe('sk_agent_abc');
    expect(options.headers['Authorization']).toBeUndefined();
    // The endpoint requires a top-level customerId; productType is AI_AGENT.
    const body = JSON.parse(options.body);
    expect(body.customerId).toBe('cust_contract');
    expect(body.productType).toBe('AI_AGENT');
  });

  test('ExecutionStatus lists exactly the contract\'s canonical statuses', () => {
    const canonical = fixture.endpoints['/v1/ingest/batch'].eventOptionalFields.executionStatus.values;
    expect([...EXECUTION_STATUSES].sort()).toEqual([...canonical].sort());
  });
});
