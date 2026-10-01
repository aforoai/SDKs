/**
 * Real-server integration test for @aforoai/grpc-metering.
 *
 * Where the unit tests use mock ServerUnaryCall objects, this file:
 *   - spins up a REAL @grpc/grpc-js Server on a random localhost port
 *   - registers a UNARY service handler wrapped with billing.wrapUnary()
 *   - connects a REAL grpc.Client and invokes the service
 *   - asserts the wire-level call ends up with the expected metering
 *     event in the captured ingestor
 *
 * Avoids .proto files entirely — gRPC is transport-agnostic over the
 * service definition object, so we use a JSON-serialized service to
 * keep the test self-contained (no protoc, no proto-loader).
 *
 * Catches what mock-based tests can't:
 *   - real call.metadata.getMap() shape (vs the mocked plain object)
 *   - error code propagation from the wrapped handler back to the wire
 *   - latency measurement spans real network round-trip, not Date.now() locally
 *
 * Self-contained: no external broker. Skipped automatically when the
 * `@grpc/grpc-js` peer dep isn't installed.
 */

import { AforoGrpcBilling } from '../index';
import * as http from 'http';
import { AddressInfo } from 'net';
import {
  INTEGRATION_TEST_TIMEOUT_MS,
  runCleanups,
  trackFetch,
  waitFor,
  type FetchTracker,
} from '../../test-support/timing';

let grpcPkg: any;
try {
  grpcPkg = require('@grpc/grpc-js');
} catch {
  // peer missing
}

const havePeer = !!grpcPkg && typeof grpcPkg.Server === 'function';
const itIfPeer = havePeer ? test : test.skip;

interface CapturedRequest {
  url: string;
  body: any;
}

interface Fixture {
  serverPort: number;
  server: any;
  ingestorServer: http.Server;
  captured: CapturedRequest[];
  billing: AforoGrpcBilling;
  /** Every gRPC client a test opened — closed in teardown whatever the outcome. */
  clients: any[];
  /** Extra resources a single test created; run in order, before the fixture's own. */
  extraCleanups: Array<[name: string, run: () => unknown]>;
  fetches: FetchTracker;
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Keep-alive sockets from the SDK's fetch would otherwise hold close() open.
    (server as any).closeAllConnections?.();
  });
}

// Minimal "Greeter" service definition — same shape protoc would generate
// but built by hand using JSON serialization so we don't need a .proto file
// or protoc on the test machine.
function greeterServiceDefinition() {
  const serialize = (v: any) => Buffer.from(JSON.stringify(v));
  const deserialize = (b: Buffer) => JSON.parse(b.toString('utf8'));

  return {
    sayHello: {
      path: '/aforo.test.Greeter/SayHello',
      requestStream: false,
      responseStream: false,
      requestSerialize: serialize,
      requestDeserialize: deserialize,
      responseSerialize: serialize,
      responseDeserialize: deserialize,
      originalName: 'sayHello',
    },
    failHard: {
      path: '/aforo.test.Greeter/FailHard',
      requestStream: false,
      responseStream: false,
      requestSerialize: serialize,
      requestDeserialize: deserialize,
      responseSerialize: serialize,
      responseDeserialize: deserialize,
      originalName: 'failHard',
    },
  };
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
        captured.push({ url: String(req.url), body });
      } catch {
        captured.push({ url: String(req.url), body: null });
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((r) => ingestorServer.listen(0, '127.0.0.1', r));
  const ingestorPort = (ingestorServer.address() as AddressInfo).port;

  const billing = new AforoGrpcBilling({
    tenantId: 'tenant-int-grpc',
    productId: 'prod-int-grpc',
    apiKey: 'sk_int_grpc',
    ingestorUrl: `http://127.0.0.1:${ingestorPort}`,
    serviceName: 'aforo.test.Greeter',
    flushCount: 1,
    flushIntervalMs: 60_000,
    customerIdExtractor: (md: any) => {
      // metadata.getMap() returns lowercased keys
      return md && md['x-customer-id'];
    },
  });

  const def = greeterServiceDefinition();
  const server = new grpcPkg.Server();
  server.addService(def, {
    sayHello: billing.wrapUnary('SayHello', async (call: any) => ({
      message: `hello ${call.request.name}`,
    })),
    failHard: billing.wrapUnary('FailHard', async () => {
      const err: any = new Error('boom');
      err.code = grpcPkg.status.INVALID_ARGUMENT; // 3
      throw err;
    }),
  });

  const port: number = await new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpcPkg.ServerCredentials.createInsecure(), (err: any, p: number) => {
      if (err) return reject(err);
      resolve(p);
    });
  });

  return { serverPort: port, server, ingestorServer, captured, billing, clients: [], extraCleanups: [], fetches };
}

/**
 * Quiesce, then close — in dependency order, and independent of how the test
 * ended: close every client, flush, wait for every in-flight flush to land,
 * and only then stop the servers. forceShutdown (not tryShutdown) so a call a
 * failed test left open cannot hold teardown hostage.
 */
async function teardown(f: Fixture): Promise<void> {
  await runCleanups([
    ['close clients', () => { for (const c of f.clients) c.close(); }],
    ...f.extraCleanups,
    ['billing.shutdown', () => f.billing.shutdown()],
    ['in-flight flushes', () =>
      waitFor(() => f.fetches.pending() === 0, () => `SDK fetches to settle (pending=${f.fetches.pending()})`)],
    ['grpc server.forceShutdown', () => f.server.forceShutdown()],
    ['ingestor.close', () => closeHttpServer(f.ingestorServer)],
    ['restore fetch', () => f.fetches.restore()],
  ]);
}

function flatEvents(captured: CapturedRequest[]): any[] {
  return captured.flatMap((r) => r.body?.events ?? []);
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

// Build a generic gRPC client around the service definition (no proto loader)
// and track it on the fixture so teardown closes it.
function makeClient(f: Fixture, port: number = f.serverPort): any {
  const def = greeterServiceDefinition();
  const ClientCtor = grpcPkg.makeGenericClientConstructor(def, 'Greeter', {});
  const client = new ClientCtor(`127.0.0.1:${port}`, grpcPkg.credentials.createInsecure());
  f.clients.push(client);
  return client;
}

describe('Real-server integration (@grpc/grpc-js Server + Client)', () => {
  if (!havePeer) {
    test.skip('@grpc/grpc-js peer-dep not installed — integration test skipped', () => {});
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
    'unary success: real RPC through wire → metering event with OK status',
    async () => {
      const client = makeClient(fix);
      const md = new grpcPkg.Metadata();
      md.add('x-customer-id', 'cust_grpc_001');

      const resp: any = await new Promise((resolve, reject) => {
        client.sayHello({ name: 'world' }, md, (err: any, value: any) => {
          if (err) return reject(err);
          resolve(value);
        });
      });
      expect(resp.message).toBe('hello world');

      const events = await waitForEvents(fix.captured, (evs) => evs.length >= 1, 'the metering event');
      const ev = events[0];
      expect(ev.productType).toBe('GRPC_API');
      expect(ev.grpcService).toBe('aforo.test.Greeter');
      expect(ev.grpcMethod).toBe('SayHello');
      expect(ev.grpcStatusCode).toBe('OK');
      expect(ev.grpcCallType).toBe('UNARY');
      expect(ev.customerId).toBe('cust_grpc_001');
      expect(ev.executionDurationMs).toBeGreaterThanOrEqual(0);

    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  itIfPeer(
    'unary error: thrown handler error → metering event with mapped status code',
    async () => {
      const client = makeClient(fix);
      const md = new grpcPkg.Metadata();
      md.add('x-customer-id', 'cust_grpc_002');

      // Assert outside the callback: an expect() that throws inside it would
      // be an uncaught exception and leave this promise pending forever.
      const err: any = await new Promise((resolve) => {
        client.failHard({ name: 'whatever' }, md, (e: any) => resolve(e));
      });
      expect(err).toBeTruthy();
      expect(err.code).toBe(grpcPkg.status.INVALID_ARGUMENT);

      const events = await waitForEvents(fix.captured, (evs) => evs.length >= 1, 'the metering event');
      const ev = events[0];
      expect(ev.grpcMethod).toBe('FailHard');
      expect(ev.grpcStatusCode).toBe('INVALID_ARGUMENT');
      expect(ev.customerId).toBe('cust_grpc_002');

    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  itIfPeer(
    'X-API-Key + tenant headers reach the ingestor (no Authorization)',
    async () => {
      const md = new grpcPkg.Metadata();
      md.add('x-customer-id', 'cust_grpc_headers');

      // Sniff the next ingestor request for headers
      const sniffed: http.IncomingHttpHeaders[] = [];
      const sniffServer = http.createServer((req, res) => {
        sniffed.push({ ...req.headers });
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(204);
          res.end();
        });
      });
      fix.extraCleanups.push(['sniffServer.close', () => closeHttpServer(sniffServer)]);
      await new Promise<void>((r) => sniffServer.listen(0, '127.0.0.1', r));
      const port = (sniffServer.address() as AddressInfo).port;

      const billing2 = new AforoGrpcBilling({
        tenantId: 'tenant-headers',
        productId: 'prod-headers',
        apiKey: 'sk_header_check',
        ingestorUrl: `http://127.0.0.1:${port}`,
        serviceName: 'aforo.test.Greeter',
        flushCount: 1,
        customerIdExtractor: (m: any) => m && m['x-customer-id'],
      });
      // unshift: must run (and its flush land) before the sniff server closes.
      fix.extraCleanups.unshift(['billing2.shutdown', () => billing2.shutdown()]);

      // Re-bind a separate handler for header check (avoid stomping fix.billing)
      const sniffServer2Def = greeterServiceDefinition();
      const sniffSrv = new grpcPkg.Server();
      sniffSrv.addService(sniffServer2Def, {
        sayHello: billing2.wrapUnary('SayHello', async () => ({ message: 'sniff' })),
        failHard: billing2.wrapUnary('FailHard', async () => ({ message: 'unused' })),
      });
      fix.extraCleanups.push(['sniff grpc server.forceShutdown', () => sniffSrv.forceShutdown()]);
      const sniffPort: number = await new Promise((resolve, reject) => {
        sniffSrv.bindAsync('127.0.0.1:0', grpcPkg.ServerCredentials.createInsecure(), (err: any, p: number) => {
          if (err) return reject(err);
          resolve(p);
        });
      });
      const client2 = makeClient(fix, sniffPort);

      await new Promise<void>((resolve, reject) => {
        client2.sayHello({ name: 'sniff' }, md, (err: any) => (err ? reject(err) : resolve()));
      });

      const headers = await waitFor(
        () => sniffed[0],
        () => 'a request to reach the header-sniffing ingestor',
      );
      expect(headers['x-api-key']).toBe('sk_header_check');
      expect(headers['authorization']).toBeUndefined();
      expect(headers['x-tenant-id']).toBe('tenant-headers');
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
