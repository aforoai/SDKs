/**
 * Real-server integration test for @aforo/grpc-metering.
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

  return { serverPort: port, server, ingestorServer, captured, billing };
}

async function teardown(f: Fixture): Promise<void> {
  await f.billing.shutdown();
  await new Promise<void>((r) => f.server.tryShutdown(() => r()));
  await new Promise<void>((r) => f.ingestorServer.close(() => r()));
}

function flatEvents(captured: CapturedRequest[]): any[] {
  return captured.flatMap((r) => r.body?.events ?? []);
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

// Build a generic gRPC client around the service definition (no proto loader)
function makeClient(port: number): any {
  const def = greeterServiceDefinition();
  const ClientCtor = grpcPkg.makeGenericClientConstructor(def, 'Greeter', {});
  return new ClientCtor(`127.0.0.1:${port}`, grpcPkg.credentials.createInsecure());
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
  });

  itIfPeer(
    'unary success: real RPC through wire → metering event with OK status',
    async () => {
      const client = makeClient(fix.serverPort);
      const md = new grpcPkg.Metadata();
      md.add('x-customer-id', 'cust_grpc_001');

      const resp: any = await new Promise((resolve, reject) => {
        client.sayHello({ name: 'world' }, md, (err: any, value: any) => {
          if (err) return reject(err);
          resolve(value);
        });
      });
      expect(resp.message).toBe('hello world');

      const events = await waitForEvents(fix.captured, (evs) => evs.length >= 1);
      const ev = events[0];
      expect(ev.productType).toBe('GRPC_API');
      expect(ev.grpcService).toBe('aforo.test.Greeter');
      expect(ev.grpcMethod).toBe('SayHello');
      expect(ev.grpcStatusCode).toBe('OK');
      expect(ev.grpcCallType).toBe('UNARY');
      expect(ev.customerId).toBe('cust_grpc_001');
      expect(ev.executionDurationMs).toBeGreaterThanOrEqual(0);

      client.close();
    },
    15_000,
  );

  itIfPeer(
    'unary error: thrown handler error → metering event with mapped status code',
    async () => {
      const client = makeClient(fix.serverPort);
      const md = new grpcPkg.Metadata();
      md.add('x-customer-id', 'cust_grpc_002');

      await new Promise<void>((resolve) => {
        client.failHard({ name: 'whatever' }, md, (err: any) => {
          expect(err).toBeTruthy();
          expect(err.code).toBe(grpcPkg.status.INVALID_ARGUMENT);
          resolve();
        });
      });

      const events = await waitForEvents(fix.captured, (evs) => evs.length >= 1);
      const ev = events[0];
      expect(ev.grpcMethod).toBe('FailHard');
      expect(ev.grpcStatusCode).toBe('INVALID_ARGUMENT');
      expect(ev.customerId).toBe('cust_grpc_002');

      client.close();
    },
    15_000,
  );

  itIfPeer(
    'authorization + tenant headers reach the ingestor',
    async () => {
      const client = makeClient(fix.serverPort);
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

      // Re-bind a separate handler for header check (avoid stomping fix.billing)
      const sniffServer2Def = greeterServiceDefinition();
      const sniffSrv = new grpcPkg.Server();
      sniffSrv.addService(sniffServer2Def, {
        sayHello: billing2.wrapUnary('SayHello', async () => ({ message: 'sniff' })),
        failHard: billing2.wrapUnary('FailHard', async () => ({ message: 'unused' })),
      });
      const sniffPort: number = await new Promise((resolve, reject) => {
        sniffSrv.bindAsync('127.0.0.1:0', grpcPkg.ServerCredentials.createInsecure(), (err: any, p: number) => {
          if (err) return reject(err);
          resolve(p);
        });
      });
      const client2 = makeClient(sniffPort);

      try {
        await new Promise<void>((resolve) => {
          client2.sayHello({ name: 'sniff' }, md, () => resolve());
        });

        const deadline = Date.now() + 2000;
        while (sniffed.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }

        expect(sniffed.length).toBeGreaterThan(0);
        const headers = sniffed[0];
        expect(headers['authorization']).toBe('Bearer sk_header_check');
        expect(headers['x-tenant-id']).toBe('tenant-headers');
      } finally {
        client2.close();
        client.close();
        await billing2.shutdown();
        await new Promise<void>((r) => sniffSrv.tryShutdown(() => r()));
        await new Promise<void>((r) => sniffServer.close(() => r()));
      }
    },
    15_000,
  );
});
