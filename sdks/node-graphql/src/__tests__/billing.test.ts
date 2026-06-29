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
  ingestorUrl: 'https://ingestor.aforo.ai',
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
  test('POST to ingestor /v1/ingest/events with correct headers', async () => {
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
    expect(req.url).toBe('https://ingestor.aforo.ai/v1/ingest/events');
    const headers = req.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk_gql_abc');
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
