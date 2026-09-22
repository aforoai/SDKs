/**
 * Tests for AforoGraphQlBilling. Unique bits vs. gRPC family canary:
 *   - AST-accurate complexity scoring (field_count + 5 × max_depth)
 *   - Operation type detection (QUERY / MUTATION / SUBSCRIPTION)
 *   - Express middleware body capture path
 */

import { AforoGraphQlBilling, defaultComplexityScorer } from '../index';
import { parse } from 'graphql';

// ── HTTP capture (same shape as the gRPC test) ──────────────────────────

interface Captured { url: string; init: RequestInit; body: any }
let capturedRequests: Captured[];
let nextFetchResponse: Response | (() => Response | Promise<Response>);

const okResponse = () =>
  ({ ok: true, status: 200, statusText: 'OK' } as unknown as Response);

beforeEach(() => {
  capturedRequests = [];
  nextFetchResponse = okResponse();
  global.fetch = jest.fn(async (input: any, init: any = {}) => {
    let body: any = init.body;
    try { body = JSON.parse(init.body); } catch { /* ignore */ }
    capturedRequests.push({ url: String(input), init, body });
    if (typeof nextFetchResponse === 'function') return nextFetchResponse();
    return nextFetchResponse;
  }) as any;
});

const config = () => ({
  tenantId: 'tenant-001',
  productId: 'prod-gql-001',
  apiKey: 'sk_gql_abc',
  ingestorUrl: 'https://api.aforo.ai',
  schemaVersion: 'v2.1',
});

// ── Complexity scorer (the protocol-unique bit) ─────────────────────────

describe('defaultComplexityScorer', () => {
  test('flat query: 3 fields, max_depth=1 → complexity = 3 + 5 = 8', () => {
    const doc = parse(`{ a b c }`);
    const { complexity, fieldCount } = defaultComplexityScorer(doc);
    expect(fieldCount).toBe(3);
    expect(complexity).toBe(3 + 5 * 1);
  });

  test('nested query: 4 fields total, max_depth=3 → 4 + 15 = 19', () => {
    // user { profile { name email } }  — 4 fields, 3 levels deep
    const doc = parse(`{ user { profile { name email } } }`);
    const { complexity, fieldCount } = defaultComplexityScorer(doc);
    expect(fieldCount).toBe(4);
    expect(complexity).toBe(4 + 5 * 3);
  });

  test('mutation returns non-zero complexity', () => {
    const doc = parse(`mutation Create { createUser { id } }`);
    const { complexity, fieldCount } = defaultComplexityScorer(doc);
    expect(fieldCount).toBe(2);   // createUser + id
    expect(complexity).toBeGreaterThan(0);
  });

  test('custom scorer is honoured (override default)', async () => {
    const billing = new AforoGraphQlBilling({
      ...config(),
      flushCount: 1,
      complexityScorer: () => ({ complexity: 999, fieldCount: 777 }),
    });
    billing.record({
      customerId: 'cust_001',
      query: `{ a }`,
      operationName: undefined,
      durationMs: 5,
      hasErrors: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    const ev = capturedRequests[0].body.events[0];
    expect(ev.gqlComplexity).toBe(999);
    expect(ev.gqlFieldCount).toBe(777);
    await billing.shutdown();
  });
});

// ── Operation type + name detection ─────────────────────────────────────

describe('record() operation detection', () => {
  test('query with explicit name', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 1 });
    billing.record({
      customerId: 'cust_001',
      query: `query GetUser { user { id } }`,
      operationName: 'GetUser',
      durationMs: 10,
      hasErrors: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    const ev = capturedRequests[0].body.events[0];
    expect(ev.gqlOperationType).toBe('QUERY');
    expect(ev.gqlOperationName).toBe('GetUser');
    expect(ev.productType).toBe('GRAPHQL_API');
    expect(ev.metricName).toBe('graphql_api.operations');
    expect(ev.metadata.schemaVersion).toBe('v2.1');
    await billing.shutdown();
  });

  test('anonymous operation → name = "anonymous"', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 1 });
    billing.record({
      customerId: 'cust_001',
      query: `{ user { id } }`,
      operationName: undefined,
      durationMs: 5,
      hasErrors: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    const ev = capturedRequests[0].body.events[0];
    expect(ev.gqlOperationType).toBe('QUERY');
    expect(ev.gqlOperationName).toBe('anonymous');
    await billing.shutdown();
  });

  test('mutation operation type detected', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 1 });
    billing.record({
      customerId: 'cust_001',
      query: `mutation DoThing { createUser { id } }`,
      operationName: 'DoThing',
      durationMs: 5,
      hasErrors: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedRequests[0].body.events[0].gqlOperationType).toBe('MUTATION');
    await billing.shutdown();
  });

  test('subscription operation type detected', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 1 });
    billing.record({
      customerId: 'cust_001',
      query: `subscription OnNew { newUser { id } }`,
      operationName: 'OnNew',
      durationMs: 5,
      hasErrors: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedRequests[0].body.events[0].gqlOperationType).toBe('SUBSCRIPTION');
    await billing.shutdown();
  });

  test('invalid query → record silently drops (no fetch, no throw)', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 1 });
    expect(() => {
      billing.record({
        customerId: 'cust_001',
        query: `{ this is not valid graphql`,
        operationName: undefined,
        durationMs: 5,
        hasErrors: false,
      });
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedRequests).toHaveLength(0);
    await billing.shutdown();
  });

  test('no customerId → record silently drops', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 1 });
    billing.record({
      customerId: '',
      query: `{ a }`,
      operationName: undefined,
      durationMs: 5,
      hasErrors: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedRequests).toHaveLength(0);
    await billing.shutdown();
  });

  test('hasErrors=true is forwarded onto gqlHasErrors', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 1 });
    billing.record({
      customerId: 'cust_001',
      query: `{ a }`,
      operationName: undefined,
      durationMs: 5,
      hasErrors: true,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedRequests[0].body.events[0].gqlHasErrors).toBe(true);
    await billing.shutdown();
  });
});

// ── Buffer + flush shape ────────────────────────────────────────────────

describe('flush', () => {
  test('POST to ingestor /v1/ingest/batch with correct headers', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 1 });
    billing.record({
      customerId: 'cust_001',
      query: `{ a }`,
      operationName: undefined,
      durationMs: 5,
      hasErrors: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    const req = capturedRequests[0];
    expect(req.url).toBe('https://api.aforo.ai/v1/ingest/batch');
    const headers = req.init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('sk_gql_abc');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['X-Tenant-Id']).toBe('tenant-001');
    await billing.shutdown();
  });

  test('idempotencyKey format: gql:{tenant}:{product}:{opName}:{millis}:{8-hex}', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 1 });
    billing.record({
      customerId: 'cust_001',
      query: `query MyOp { a }`,
      operationName: 'MyOp',
      durationMs: 5,
      hasErrors: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    const key = capturedRequests[0].body.events[0].idempotencyKey;
    expect(key).toMatch(/^gql:tenant-001:prod-gql-001:MyOp:\d+:[a-z0-9]{8}$/);
    await billing.shutdown();
  });

  test('shutdown flushes pending events', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 100 });
    for (let i = 0; i < 3; i++) {
      billing.record({
        customerId: 'cust_001',
        query: `{ a${i} }`,
        operationName: undefined,
        durationMs: 5,
        hasErrors: false,
      });
    }
    await billing.shutdown();
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].body.events).toHaveLength(3);
  });
});

function assertBatchContract(reqs: Array<{ url: string; init: RequestInit; body: any }>, apiKey: string, allowed: string[]) {
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
      for (const k of ['customerId', 'metricName', 'occurredAt', 'idempotencyKey']) {
        expect(typeof e[k]).toBe('string');
        expect(e[k].trim()).not.toBe('');
      }
      expect(e.quantity).toBeGreaterThan(0);
    }
  }
}

describe('ingest batch contract', () => {
  const record = (b: AforoGraphQlBilling, i = 0) => b.record({
    customerId: 'cust_001', query: `query Op${i} { a { b } }`, operationName: `Op${i}`,
    durationMs: 5.6, hasErrors: false, responseBytes: 10,
  });
  const FIELDS = ['customerId', 'metricName', 'quantity', 'occurredAt', 'idempotencyKey', 'productType', 'metadata', 'gqlOperationType', 'gqlOperationName',
    'gqlComplexity', 'gqlFieldCount', 'gqlHasErrors', 'dataBytes', 'executionDurationMs'];

  test('events carry only IngestUsageEventRequest fields', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 100 });
    record(billing);
    await billing.shutdown();
    assertBatchContract(capturedRequests, 'sk_gql_abc', FIELDS);
    expect(capturedRequests[0].body.events[0].executionDurationMs).toBe(6);
  });

  test('>1000 buffered events are split into requests of <=1000', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 5000 });
    for (let i = 0; i < 2500; i++) record(billing, i);
    await billing.shutdown();
    expect(capturedRequests.map((r) => r.body.events.length)).toEqual([1000, 1000, 500]);
    assertBatchContract(capturedRequests, 'sk_gql_abc', FIELDS);
  });

  test('long operation name is trimmed to 255 and idempotencyKey to 255', async () => {
    const billing = new AforoGraphQlBilling({ ...config(), flushCount: 100 });
    const name = 'Op' + 'x'.repeat(400);
    billing.record({ customerId: 'cust_001', query: `query ${name} { a }`, operationName: name, durationMs: 1, hasErrors: false });
    await billing.shutdown();
    const ev = capturedRequests[0].body.events[0];
    expect(ev.gqlOperationName.length).toBe(255);
    expect(ev.idempotencyKey.length).toBeLessThanOrEqual(255);
    expect(ev.idempotencyKey).toMatch(/:\d+:[a-z0-9]{8}$/);
  });
});

describe('productType', () => {
  const rec = (b: AforoGraphQlBilling, productType?: string) => b.record({
    customerId: 'cust_001', query: `{ a }`, operationName: undefined, durationMs: 1, hasErrors: false, productType,
  });

  test('defaults to GRAPHQL_API; client option is trimmed + uppercased; per-call value wins', async () => {
    const def = new AforoGraphQlBilling({ ...config(), flushCount: 100 });
    rec(def);
    await def.shutdown();
    expect(capturedRequests[0].body.events[0].productType).toBe('GRAPHQL_API');

    capturedRequests = [];
    const b = new AforoGraphQlBilling({ ...config(), flushCount: 100, productType: ' agentic_api ' });
    rec(b);
    rec(b, ' custom_type ');   // unknown values pass through
    rec(b, '   ');             // blank override falls back to the client-level type
    await b.shutdown();
    expect(capturedRequests[0].body.events.map((e: any) => e.productType)).toEqual(['AGENTIC_API', 'CUSTOM_TYPE', 'AGENTIC_API']);
  });

  test('middleware({ productType }) is passed through to recorded events', async () => {
    const b = new AforoGraphQlBilling({ ...config(), flushCount: 100 });
    const mw = b.middleware({ productType: 'api' });
    const res: any = { statusCode: 200, end: () => undefined };
    mw({ body: { query: '{ a }' }, headers: { 'x-customer-id': 'cust_001' } }, res, () => undefined);
    res.end('{}');
    await b.shutdown();
    expect(capturedRequests[0].body.events[0].productType).toBe('API');
  });
});

describe('batch response handling', () => {
  const rec = (b: AforoGraphQlBilling) => b.record({
    customerId: 'cust_001', query: `{ a }`, operationName: undefined, durationMs: 1, hasErrors: false,
  });
  const resp = (status: number, body: any = {}, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300, status, statusText: String(status),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response);

  test('4xx (not 408/429) is not retried and reports errors[].message', async () => {
    const onError = jest.fn();
    const b = new AforoGraphQlBilling({ ...config(), flushCount: 100, onError });
    nextFetchResponse = () => resp(400, { errors: [{ index: 0, message: 'productType is required' }] });
    rec(b);
    await b.shutdown();
    expect(capturedRequests).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toMatch(/HTTP 400.*productType is required.*not retried/);
  });

  test('429 honours Retry-After and 408 is retried; same idempotencyKeys re-sent', async () => {
    const onError = jest.fn();
    const b = new AforoGraphQlBilling({ ...config(), flushCount: 100, onError });
    const seq = [resp(429, {}, { 'retry-after': '0' }), resp(408, {}, { 'retry-after': '0' }), resp(202, { accepted: 1, failed: 0 })];
    nextFetchResponse = () => seq.shift()!;
    rec(b);
    await b.shutdown();
    expect(capturedRequests).toHaveLength(3);
    expect(new Set(capturedRequests.map((r) => r.body.events[0].idempotencyKey)).size).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test('202 with failed > 0 reports per-event errors[].message via onError', async () => {
    const onError = jest.fn();
    const b = new AforoGraphQlBilling({ ...config(), flushCount: 100, onError });
    nextFetchResponse = () => resp(202, { accepted: 0, duplicates: 0, failed: 1, errors: [{ index: 0, message: 'bad event' }] });
    rec(b);
    await b.shutdown();
    expect(capturedRequests).toHaveLength(1);
    expect(onError.mock.calls[0][0].message).toMatch(/rejected 1 event\(s\).*#0: bad event/);
  });
});
