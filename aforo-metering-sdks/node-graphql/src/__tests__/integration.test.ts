/**
 * Real-server integration test for @aforo/graphql-metering.
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
}

async function setup(): Promise<Fixture> {
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

  return { serverPort, server, ingestorServer, captured, billing };
}

async function teardown(f: Fixture): Promise<void> {
  await f.billing.shutdown();
  await new Promise<void>((r) => f.server.close(() => r()));
  await new Promise<void>((r) => f.ingestorServer.close(() => r()));
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

async function waitForEvents(
  captured: CapturedRequest[],
  predicate: (events: any[]) => boolean,
  timeoutMs = 2000,
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = flatEvents(captured);
    if (predicate(events)) return events;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitForEvents timed out. captured=${JSON.stringify(captured, null, 2)}`);
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
  });

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

      const events = await waitForEvents(fix.captured, (evs) => evs.length >= 1);
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
    10_000,
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

      const events = await waitForEvents(fix.captured, (evs) => evs.length >= 1);
      const ev = events[0];
      expect(ev.gqlOperationType).toBe('MUTATION');
      expect(ev.gqlOperationName).toBe('Rename');
      expect(ev.customerId).toBe('cust_mut_001');
    },
    10_000,
  );

  itIfPeer(
    'request without X-Customer-Id is silently skipped (no metering)',
    async () => {
      const { status } = await postGraphql(fix.serverPort, {
        query: '{ ping }',
      });
      expect(status).toBe(200);

      // Give it a beat — any spurious event would have flushed by now
      await new Promise((r) => setTimeout(r, 200));
      await fix.billing.shutdown();

      expect(flatEvents(fix.captured)).toHaveLength(0);
    },
    10_000,
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

      const events = await waitForEvents(fix.captured, (evs) => evs.length >= 1);
      const ev = events[0];
      expect(ev.gqlHasErrors).toBe(true);
      expect(ev.customerId).toBe('cust_err_001');
    },
    10_000,
  );
});
