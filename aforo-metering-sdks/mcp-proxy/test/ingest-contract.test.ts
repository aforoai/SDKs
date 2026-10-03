/**
 * @file Ingest-contract guard (A+ delivery-guarantee prompt 7).
 *
 * Validates the OBSERVED wire request (endpoint path + body shape) against
 * the shared, checked-in contract fixture at contract/ingest-contract.json —
 * derived from the REAL usage-ingestor controllers/DTOs, never from this
 * proxy's own constants. A test that asserts the client against its own
 * endpoint constant has zero contract coverage (2026-07-05 D1 incident:
 * 16 variant SDKs posted a batch body to a single-event endpoint and every
 * flush 400'd behind green suites).
 *
 * Runs compiled from dist/test/ (node --test), so the fixture path resolves
 * from dist/test → repo root.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IngestorClient } from '../src/telemetry/IngestorClient.js';
import type { ProxyUsageEvent } from '../src/types.js';

const MODULE_KEY = 'mcp-proxy';

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../contract/ingest-contract.json'), 'utf8'),
);

function assertRequired(obj: any, field: string): void {
  const v = obj[field];
  assert.notEqual(v, undefined, `required field '${field}' missing`);
  assert.notEqual(v, null, `required field '${field}' null`);
  if (typeof v === 'string') assert.notEqual(v.trim(), '', `required field '${field}' blank`);
}

/** Same assertion shape in every SDK suite (all languages). */
function assertBodyMatchesContract(spec: any, body: any): void {
  assert.notEqual(body, null);
  assert.equal(typeof body, 'object');
  if (spec.cardinality === 'batch-wrapped') {
    // A bare array here is the /v1/ingest/async-batch shape — wrong for this endpoint.
    assert.equal(Array.isArray(body), false, 'batch body must be an object, not a bare array');
    const events = body[spec.batchKey];
    assert.equal(Array.isArray(events), true, `batch body must carry '${spec.batchKey}' array`);
    assert.ok(events.length > 0);
    assert.ok(events.length <= spec.maxEvents);
    for (const ev of events) {
      for (const field of spec.eventRequiredFields) assertRequired(ev, field);
    }
  } else if (spec.cardinality === 'single') {
    assert.equal(Array.isArray(body), false);
    for (const key of spec.forbiddenTopLevelKeys ?? []) {
      assert.equal(body[key], undefined, `single-event body must not carry '${key}'`);
    }
    for (const field of spec.requiredFields) assertRequired(body, field);
  } else {
    throw new Error(`Unhandled cardinality in fixture: ${spec.cardinality}`);
  }
}

function makeEvent(): ProxyUsageEvent {
  return {
    customerId: 'agent_contract',
    metricName: 'mcp_server.tool_invocations',
    quantity: 1,
    occurredAt: new Date().toISOString(),
    idempotencyKey: `key_contract_${Date.now()}`,
    productType: 'MCP_SERVER',
    toolName: 'search_documents',
    agentId: 'agent_contract',
    sessionId: 'session_1',
    executionStatus: 'SUCCESS',
    executionDurationMs: 42,
    metadata: { proxy: true, proxyVersion: '1.0.0', transport: 'stdio', productId: 'prod_1' },
  };
}

describe('ingest contract guard (shared fixture)', () => {
  const realFetch = globalThis.fetch;
  let observed: { url: string; init: any } | null = null;

  beforeEach(() => {
    observed = null;
    globalThis.fetch = (async (url: any, init: any) => {
      observed = { url: String(url), init };
      return new Response(JSON.stringify({ accepted: 1, duplicates: 0, failed: 0 }), { status: 202 });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('POSTs to the contracted endpoint with the contracted body shape', async () => {
    const sdkEntry = fixture.sdks[MODULE_KEY];
    assert.notEqual(sdkEntry, undefined, 'module must be registered in the fixture');
    const endpoint: string = sdkEntry.endpoint;
    const spec = fixture.endpoints[endpoint];
    assert.notEqual(spec, undefined);

    const client = new IngestorClient({
      baseUrl: 'https://ingest.test.aforo.ai',
      apiKey: 'sk_proxy_abc',
      tenantId: 'tenant-001',
      maxRetries: 1,
    });

    await client.sendBatch([makeEvent()]);

    assert.notEqual(observed, null, 'no wire request observed');
    assert.equal(new URL(observed!.url).pathname, endpoint);
    assert.equal(observed!.init.method, 'POST');
    assertBodyMatchesContract(spec, JSON.parse(observed!.init.body));
    // Auth: X-API-Key only (the server accepts it for every key type).
    assert.equal(observed!.init.headers['X-API-Key'], 'sk_proxy_abc');
    assert.equal(observed!.init.headers['Authorization'], undefined);
    // The production ingestor requires an explicit top-level productType.
    assert.equal(JSON.parse(observed!.init.body)[spec.batchKey][0].productType, 'MCP_SERVER');
  });
});
