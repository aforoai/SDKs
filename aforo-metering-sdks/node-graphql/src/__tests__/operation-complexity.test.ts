/**
 * Regression tests for the 2026-11-09 end-to-end run: the default scorer
 * counted every operation in the document, so `query A {...} mutation PickMe
 * {...}` sent with operationName PickMe was billed for A's fields too. Only the
 * operation that runs is counted now, in the Apollo plugin and the HTTP
 * middleware alike, with each fragment counted at every spread (the rule the
 * Java, Go and Python SDKs use).
 */
import { parse } from 'graphql';
import { AforoGraphQlBilling, aforoApolloPlugin, defaultComplexityScorer, GraphQlUsageEvent } from '../index';
import { bodyJson } from '../../test-support/request-body';

const MULTI = 'query A { a b c { d e } } mutation PickMe { x }';

let sent: GraphQlUsageEvent[];
beforeEach(() => {
  sent = [];
  global.fetch = jest.fn(async (_u: any, init: any) => {
    const events = bodyJson(init).events as GraphQlUsageEvent[];
    sent.push(...events);
    return new Response(JSON.stringify({ success: true, data: { accepted: events.length, failed: 0 } }), { status: 202 });
  }) as any;
});
const tick = () => new Promise((r) => setImmediate(r));
function billing() {
  return new AforoGraphQlBilling({
    tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://api.aforo.ai', flushOnExit: false, flushIntervalMs: 60_000,
    customerResolver: (ctx: any) => ctx?.customer ?? ctx?.headers?.['x-cust'],
  });
}

describe('defaultComplexityScorer counts the operation that runs', () => {
  test('a named operation in a multi-operation document counts only its own fields', () => {
    expect(defaultComplexityScorer(parse(MULTI), 'PickMe')).toEqual({ fieldCount: 1, complexity: 1 + 5 * 1 });
    expect(defaultComplexityScorer(parse(MULTI), 'A')).toEqual({ fieldCount: 5, complexity: 5 + 5 * 2 });
  });

  test('without an operation name the first operation is counted (the one the event is named after)', () => {
    expect(defaultComplexityScorer(parse(MULTI))).toEqual({ fieldCount: 5, complexity: 15 });
  });

  test('a fragment counts at every spread, at the depth where it is spread; unused fragments do not count', () => {
    const doc = parse(`
      query Q { user { ...U ...U } }
      query Other { ...Big }
      fragment U on User { id name }
      fragment Big on Query { p q r s t }
    `);
    // user + (id + name) per spread = 5 fields; id/name sit at depth 2 under user.
    expect(defaultComplexityScorer(doc, 'Q')).toEqual({ fieldCount: 5, complexity: 5 + 5 * 2 });
  });

  test('the shared cross-SDK documents score as in Java, Go and Python', () => {
    const cases: Array<[string, string | undefined, number, number]> = [
      ['query A { users { id } } mutation PickMe { createOrder(item:"cup") { id } }', 'PickMe', 2, 12],
      ['query Q { first: user(id: 1) { ...U } second: user(id: 2) { ...U } } fragment U on User { id profile { bio } } fragment Unused on User { id name email }', undefined, 8, 23],
      ['query C { user(id: 7) { id ... on User @include(if: true) { name } } }', undefined, 3, 13],
      ['query D($first: Int = 5) { top: teams(first: $first, filter: {active: true, tags: ["a", "b"]}) { members: users(limit: 10, order: DESC) { recent: orders(last: 3, status: [OPEN, PAID]) { id total(currency: "USD") } } } }', undefined, 5, 25],
      ['{ me { id name friends(first: 2) { name } } }', undefined, 5, 20],
    ];
    for (const [doc, op, fieldCount, complexity] of cases) {
      expect(defaultComplexityScorer(parse(doc), op)).toEqual({ fieldCount, complexity });
    }
  });

  test('a single-operation document without fragments scores as before', () => {
    const doc = parse('query { user { id name posts { title } } }');
    // user, id, name, posts, title; deepest nesting 3 (user > posts > title).
    expect(defaultComplexityScorer(doc)).toEqual({ fieldCount: 5, complexity: 5 + 5 * 3 });
  });

  test('nested spreads are measured once each and the scores are capped at 2^31-1', () => {
    // F0 spreads F1 twice, F1 spreads F2 twice, ... : 2^40 field selections if expanded.
    const levels = 40;
    const frags = Array.from({ length: levels }, (_, i) =>
      i === levels - 1 ? `fragment F${i} on T { leaf }` : `fragment F${i} on T { x ...F${i + 1} ...F${i + 1} }`);
    const doc = parse(`query Q { root { ...F0 } } ${frags.join(' ')}`);
    const t0 = Date.now();
    const { fieldCount, complexity } = defaultComplexityScorer(doc, 'Q');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(fieldCount).toBe(2_147_483_647);
    expect(complexity).toBe(2_147_483_647);
  });

  test('a fragment that spreads itself (invalid GraphQL) terminates', () => {
    const doc = parse('query Q { a ...F } fragment F on T { b ...F }');
    expect(defaultComplexityScorer(doc, 'Q')).toEqual({ fieldCount: 2, complexity: 2 + 5 * 1 });
  });
});

test('middleware: a multi-operation POST is billed for the operation named in operationName only', async () => {
  const b = billing();
  const mw = b.middleware();
  const res: any = { statusCode: 200, end: () => undefined };
  mw({ method: 'POST', url: '/graphql', body: { query: MULTI, operationName: 'PickMe' }, headers: { 'x-cust': 'cust_42' } }, res, () => {});
  res.end('{"data":{"x":1}}');
  await tick();
  await b.flush();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ gqlOperationName: 'PickMe', gqlOperationType: 'MUTATION', gqlFieldCount: 1, gqlComplexity: 6 });
  await b.shutdown();
});

test('Apollo plugin: a multi-operation request is billed for the operation that runs only', async () => {
  const b = billing();
  const hooks = await aforoApolloPlugin(b).requestDidStart();
  await hooks.willSendResponse({
    request: { query: MULTI, operationName: 'PickMe', http: { headers: new Map() } },
    source: MULTI,
    operationName: 'PickMe',
    contextValue: { customer: 'cust_42' },
    response: { body: { kind: 'single', singleResult: { data: { x: 1 } } }, http: { status: 200 } },
  });
  await tick();
  await b.flush();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ gqlOperationName: 'PickMe', gqlOperationType: 'MUTATION', gqlFieldCount: 1, gqlComplexity: 6 });
  await b.shutdown();
});
