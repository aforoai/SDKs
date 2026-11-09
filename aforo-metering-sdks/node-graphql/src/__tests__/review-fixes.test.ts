/**
 * Regression tests for the 2026-11-09 review (#7):
 *  - aforoApolloPlugin read only request.query, which an automatic persisted
 *    query hit (hash only; on by default in Apollo Server 4) leaves empty, so
 *    those operations were served but never billed. Apollo puts the resolved
 *    text in requestContext.source.
 *  - billing.middleware() read only req.body.query, so GET operations
 *    (?query=..., served by graphql-http and express-graphql) were never billed.
 */
import { AforoGraphQlBilling, aforoApolloPlugin, GraphQlUsageEvent } from '../index';
import { bodyJson } from '../../test-support/request-body';

let sent: GraphQlUsageEvent[];
beforeEach(() => {
  sent = [];
  global.fetch = jest.fn(async (_u: any, init: any) => {
    const events = bodyJson(init).events as GraphQlUsageEvent[];
    sent.push(...events);
    return new Response(JSON.stringify({ success: true, data: { accepted: events.length, failed: 0 } }), { status: 202 });
  }) as any;
});

function billing() {
  return new AforoGraphQlBilling({
    tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://api.aforo.ai', flushOnExit: false, flushIntervalMs: 60_000,
    customerResolver: (ctx: any) => ctx?.customer ?? ctx?.headers?.['x-cust'],
  });
}
const tick = () => new Promise((r) => setImmediate(r));

test('Apollo: an automatic persisted query hit (no request.query) is metered from requestContext.source', async () => {
  const b = billing();
  const hooks = await aforoApolloPlugin(b).requestDidStart();
  // The shape Apollo Server 4 hands willSendResponse for a hash-only APQ request.
  await hooks.willSendResponse({
    request: { extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } }, http: { headers: new Map() } },
    source: 'query GetUser { user { id name } }',
    operationName: 'GetUser',
    contextValue: { customer: 'cust_42' },
    response: { body: { kind: 'single', singleResult: { data: { user: { id: '1', name: 'x' } } } }, http: { status: 200 } },
  });
  await tick();
  await b.flush();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ customerId: 'cust_42', gqlOperationType: 'QUERY', gqlOperationName: 'GetUser', executionStatus: 'SUCCESS' });
  await b.shutdown();
});

test('middleware: a GET operation (?query=&operationName=) is metered', async () => {
  const b = billing();
  const mw = b.middleware();
  const query = 'query A { a } query B { b c }';
  const req: any = {
    method: 'GET',
    url: `/graphql?query=${encodeURIComponent(query)}&operationName=B`,
    headers: { 'x-cust': 'cust_42' },
    body: {}, // express.json() leaves {} on a GET
  };
  const res: any = { statusCode: 200, write: () => true, end: () => undefined };
  mw(req, res, () => {});
  res.end('{"data":{"b":1,"c":2}}');
  await tick();
  await b.flush();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ customerId: 'cust_42', gqlOperationName: 'B', executionStatus: 'SUCCESS' });
  await b.shutdown();
});

test('middleware: an Express-parsed req.query is used too, and a POST body still wins', async () => {
  const b = billing();
  const mw = b.middleware();
  const res: any = { statusCode: 200, end: () => undefined };
  mw({ method: 'GET', url: '/graphql', query: { query: '{ a }' }, headers: { 'x-cust': 'c1' } }, res, () => {});
  res.end('{"data":{"a":1}}');
  const res2: any = { statusCode: 200, end: () => undefined };
  mw({ method: 'POST', url: '/graphql?query=%7B%20ignored%20%7D', body: { query: 'mutation M { m }' }, headers: { 'x-cust': 'c2' } }, res2, () => {});
  res2.end('{"data":{"m":1}}');
  await tick();
  await b.flush();
  expect(sent.map((e) => [e.customerId, e.gqlOperationType])).toEqual([['c1', 'QUERY'], ['c2', 'MUTATION']]);
  await b.shutdown();
});
