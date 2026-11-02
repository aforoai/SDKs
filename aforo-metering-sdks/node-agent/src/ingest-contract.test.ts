/**
 * Ingest-contract guard (A+ delivery-guarantee prompt 7).
 *
 * Validates the OBSERVED wire request (endpoint path + body shape) against
 * the shared, checked-in contract fixture at contract/ingest-contract.json —
 * derived from the REAL usage-ingestor controllers/DTOs, never from this
 * SDK's own constants. node-agent posts batch-wrapped
 * IngestUsageEventRequest events to /v1/ingest/batch — this guard locks the
 * resolved default path and the {"events":[...]} body shape.
 */

import * as fs from 'fs';
import * as path from 'path';
import AforoAgent, { EXECUTION_STATUSES } from './index';
import { bodyJson } from '../test-support/request-body';

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

    const capturingFetch = jest.fn(async () => new Response(
      JSON.stringify({ success: true, data: { accepted: 2, duplicates: 0, failed: 0, errors: [] } }),
      { status: 202 },
    ));
    // endpoint deliberately omitted: the DEFAULT must resolve to the contracted path.
    const agent = new AforoAgent({
      apiKey: 'sk_agent_abc',
      customerId: 'cust_contract',
      agentId: 'agent_contract',
      fetchImpl: capturingFetch as unknown as typeof fetch,
      logger: null,
    });

    const session = agent.startSession({ sessionId: 'sess_contract' });
    await session.recordStep({ stepKind: 'THOUGHT' });
    await session.end({});

    expect(capturingFetch).toHaveBeenCalledTimes(1);
    const [url, options] = capturingFetch.mock.calls[0] as any[];
    expect(new URL(String(url)).pathname).toBe(endpoint);
    expect(new URL(String(url)).host).toBe('api.aforo.ai');
    expect(options.method).toBe('POST');
    const body = bodyJson(options);
    assertBodyMatchesContract(spec, body);
    // Auth: X-API-Key only (a non-JWT Bearer is rejected by the ingestor).
    expect(options.headers['X-API-Key']).toBe('sk_agent_abc');
    expect(options.headers['Authorization']).toBeUndefined();
    for (const ev of body.events) {
      expect(ev.productType).toBe('AI_AGENT');
      expect(ev.agentId).toBe('agent_contract');
      expect(ev.sessionId).toBe('sess_contract');
      expect(ev.quantity).toBeGreaterThan(0);
    }
  });

  test('ExecutionStatus lists exactly the contract\'s canonical statuses', () => {
    const canonical = fixture.endpoints['/v1/ingest/batch'].eventOptionalFields.executionStatus.values;
    expect([...EXECUTION_STATUSES].sort()).toEqual([...canonical].sort());
  });
});
