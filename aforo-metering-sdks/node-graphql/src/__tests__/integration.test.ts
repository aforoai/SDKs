/**
 * Real-server integration test for @aforoai/graphql-metering.
 *
 * Where the unit tests use a fake req/res object, this file:
 *   - builds a real GraphQL schema with the `graphql` peer dep
 *   - mounts billing.middleware() in front of a tiny HTTP handler that
 *     executes operations against the real schema
 *   - makes real HTTP POST requests with real GraphQL queries +
 *     X-Customer-Id headers
 *   - asserts the operation's name + type + complexity + customerId
 *     all reach the captured ingestor
 *
 * Catches what mock-based tests can't:
 *   - HTTP body-parse interplay between the runtime and the middleware
 *   - the middleware's res.end wrapping not breaking real responses
 *   - real graphql AST scoring with an actual document, not a stub
 *   - default customerIdExtractor reads the real X-Customer-Id header
 *
 * Self-contained: no external server. Skipped automatically when the
 * `graphql` peer dep isn't installed.
 */

import { AforoGraphQlBilling } from '../index';
import * as http from 'http';
import { AddressInfo } from 'net';
import {
  INTEGRATION_TEST_TIMEOUT_MS,
  runCleanups,
  trackFetch,
  waitFor,
  type FetchTracker,
} from '../../test-support/timing';

let graphqlPkg: any;
try {
  graphqlPkg = require('graphql');
} catch {
  // peer missing — guarded below
}

const havePeer = !!graphqlPkg && typeof graphqlPkg.buildSchema === 'function';
const itIfPeer = havePeer ? test : test.skip;

interface CapturedRequest {
  url: string;
  body: any;
  headers: http.IncomingHttpHeaders;
}

interface Fixture {
  serverPort: number;
  server: http.Server;
  ingestorServer: http.Server;
  captured: CapturedRequest[];
  billing: AforoGraphQlBilling;
  fetches: FetchTracker;
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Keep-alive sockets (the SDK's fetch, or a request a failed test left
    // open) would otherwise hold close() open.
    (server as any).closeAllConnections?.();
  });
}

async function setup(): Promise<Fixture> {
  const fetches = trackFetch();
  const captured: CapturedRequest[] = [];
  const ingestorServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
        captured.push({ url: String(req.url), body, headers: { ...req.headers } });
      } catch {
        captured.push({ url: String(req.url), body: null, headers: { ...req.headers } });
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((r) => ingestorServer.listen(0, '127.0.0.1', r));
  const ingestorPort = (ingestorServer.address() as AddressInfo).port;

  const billing = new AforoGraphQlBilling({
    tenantId: 'tenant-int-gql',
    productId: 'prod-int-gql',
    apiKey: 'sk_int_gql',
    ingestorUrl: `http://127.0.0.1:${ingestorPort}`,
    schemaVersion: 'v-test',
    flushCount: 1,
    flushIntervalMs: 60_000,
  });

  // Real GraphQL schema with a tiny query + mutation
  const { buildSchema, graphql: execGraphql } = graphqlPkg;
  const schema = buildSchema(`
    type User { id: ID!, name: String! }
    type Query { user(id: ID!): User, ping: String }
    type Mutation { rename(id: ID!, name: String!): User }
  `);
  const rootValue = {
    user: ({ id }: { id: string }) => ({ id, name: `user-${id}` }),
    ping: () => 'pong',
    rename: ({ id, name }: { id: string; name: string }) => ({ id, name }),
  };

  // Tiny http server: body-parse → middleware → graphql.execute → respond
  const middleware = billing.middleware();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        (req as any).body = body;        // middleware reads from req.body
        // Hand off to middleware which wraps res.end to capture metering
        middleware(req as any, res as any, async () => {
          const result = await execGraphql({
            schema,
            source: body.query,
            rootValue,
            operationName: body.operationName,
            variableValues: body.variables,
          });
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = result.errors ? 400 : 200;
          res.end(JSON.stringify(result));
        });
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const serverPort = (server.address() as AddressInfo).port;

  return { serverPort, server, ingestorServer, captured, billing, fetches };
}

/**
 * Quiesce, then close — in dependency order, and independent of how the test
 * ended: stop the GraphQL server (no new events), flush, wait for every
 * in-flight flush to land, and only then close the ingestor it flushes to.
 */
async function teardown(f: Fixture): Promise<void> {
  await runCleanups([
    ['graphql server.close', () => closeHttpServer(f.server)],
    ['billing.shutdown', () => f.billing.shutdown()],
    ['in-flight flushes', () =>
      waitFor(() => f.fetches.pending() === 0, () => `SDK fetches to settle (pending=${f.fetches.pending()})`)],
    ['ingestor.close', () => closeHttpServer(f.ingestorServer)],
    ['restore fetch', () => f.fetches.restore()],
  ]);
}

function flatEvents(captured: CapturedRequest[]): any[] {
  return captured.flatMap((r) => r.body?.events ?? []);
}

async function postGraphql(port: number, body: any, customerId?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (customerId) headers['X-Customer-Id'] = customerId;
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/graphql', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode || 0, json: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode || 0, json: raw });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** Wait until the captured events satisfy `predicate`; returns them. */
function waitForEvents(
  captured: CapturedRequest[],
  predicate: (events: any[]) => boolean,
  what: string,
): Promise<any[]> {
  return waitFor(
    () => {
      const events = flatEvents(captured);
      return predicate(events) ? events : undefined;
    },
    () => `${what}. captured=${JSON.stringify(captured, null, 2)}`,
  );
}

describe('Real-server integration (graphql + http middleware)', () => {
  if (!havePeer) {
    test.skip('graphql peer-dep not installed — integration test skipped', () => {});
    return;
  }

  let fix: Fixture;

  beforeEach(async () => {
    fix = await setup();
  });

  afterEach(async () => {
    await teardown(fix);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  itIfPeer(
    'QUERY operation against real schema → metering event with correct shape',
    async () => {
      const { status, json } = await postGraphql(
        fix.serverPort,
        {
          query: 'query GetUser($id: ID!) { user(id: $id) { id name } }',
          operationName: 'GetUser',
          variables: { id: 'u1' },
        },
        'cust_query_001',
      );
      expect(status).toBe(200);
      expect(json.data.user).toEqual({ id: 'u1', name: 'user-u1' });

      const events = await waitForEvents(fix.captured, (evs) => evs.length >= 1, 'the metering event');
      const ev = events[0];
      expect(ev.productType).toBe('GRAPHQL_API');
      expect(ev.gqlOperationType).toBe('QUERY');
      expect(ev.gqlOperationName).toBe('GetUser');
      expect(ev.gqlComplexity).toBeGreaterThan(0);     // real AST scoring fired
      expect(ev.gqlFieldCount).toBeGreaterThan(0);
      expect(ev.gqlHasErrors).toBe(false);
      expect(ev.customerId).toBe('cust_query_001');
      expect(ev.metadata?.schemaVersion).toBe('v-test');
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  itIfPeer(
    'MUTATION operation classified correctly + name extracted',
    async () => {
      const { status } = await postGraphql(
        fix.serverPort,
        {
          query: 'mutation Rename($id: ID!, $n: String!) { rename(id: $id, name: $n) { id name } }',
          operationName: 'Rename',
          variables: { id: 'u1', n: 'updated' },
        },
        'cust_mut_001',
      );
      expect(status).toBe(200);

      const events = await waitForEvents(fix.captured, (evs) => evs.length >= 1, 'the metering event');
      const ev = events[0];
      expect(ev.gqlOperationType).toBe('MUTATION');
      expect(ev.gqlOperationName).toBe('Rename');
      expect(ev.customerId).toBe('cust_mut_001');
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  itIfPeer(
    'request without X-Customer-Id is silently skipped (no metering)',
    async () => {
      const { status } = await postGraphql(fix.serverPort, {
        query: '{ ping }',
      });
      expect(status).toBe(200);

      // Proving "nothing was emitted" by sleeping is a guess. Instead send a
      // sentinel request AFTER it that must be metered: once the sentinel's
      // event has reached the ingestor, anything the anonymous request had
      // emitted would be there too.
      const sentinel = await postGraphql(fix.serverPort, { query: '{ ping }' }, 'cust_sentinel');
      expect(sentinel.status).toBe(200);
      const events = await waitForEvents(
        fix.captured,
        (evs) => evs.some((e: any) => e.customerId === 'cust_sentinel'),
        'the sentinel metering event',
      );

      expect(events.map((e: any) => e.customerId)).toEqual(['cust_sentinel']);
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  itIfPeer(
    'GraphQL execution errors are flagged via gqlHasErrors',
    async () => {
      // Schema-invalid query → real graphql.execute() returns errors
      // and our handler responds with 400 → middleware sets sawErrors
      const { status } = await postGraphql(
        fix.serverPort,
        { query: '{ thisFieldDoesNotExist }' },
        'cust_err_001',
      );
      expect(status).toBe(400);

      const events = await waitForEvents(fix.captured, (evs) => evs.length >= 1, 'the metering event');
      const ev = events[0];
      expect(ev.gqlHasErrors).toBe(true);
      expect(ev.customerId).toBe('cust_err_001');
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
