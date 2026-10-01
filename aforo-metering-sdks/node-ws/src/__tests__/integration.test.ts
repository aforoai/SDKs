/**
 * Real-broker integration test for @aforoai/ws-metering.
 *
 * Where the unit tests use a fake EventEmitter to stand in for the
 * WebSocket, this file:
 *   - spins up a REAL ws.WebSocketServer on a random localhost port
 *   - connects a REAL ws.WebSocket client
 *   - wraps the server with billing.wrapServer(...)
 *   - asserts CONNECTION_OPENED + CONNECTION_CLOSED events make the
 *     round trip from real protocol traffic into the captured ingestor
 *
 * Catches the things mock-based tests can't:
 *   - real ws library event signatures and payload framing
 *   - send()-wrapping interplay with the underlying ws send() (binary vs text)
 *   - close-event aggregation timing (counters/duration captured at close)
 *
 * Self-contained: no external broker. Skipped automatically when ws
 * isn't installed (peer dep is optional in package.json).
 */

import { AforoWsBilling } from '../index';
import * as http from 'http';
import { AddressInfo } from 'net';
import {
  INTEGRATION_TEST_TIMEOUT_MS,
  onceOrError,
  runCleanups,
  trackFetch,
  waitFor,
  type FetchTracker,
} from '../../test-support/timing';

let WSServer: any;
let WSClient: any;
try {
  const w = require('ws');
  WSServer = w.WebSocketServer || w.Server;
  WSClient = w.WebSocket || w;
} catch {
  // ws not installed — guarded below.
}

const havePeers = typeof WSServer === 'function' && typeof WSClient === 'function';
const itIfPeers = havePeers ? test : test.skip;

interface CapturedRequest {
  url: string;
  body: any;
}

interface Fixture {
  wssPort: number;
  wss: any;
  ingestorServer: http.Server;
  captured: CapturedRequest[];
  billing: AforoWsBilling;
  /** Frames the real server has received, per connection, in arrival order. */
  serverSockets: Array<{ received: number; closed: boolean }>;
  /** Every client a test opened — force-closed in teardown whatever the outcome. */
  clients: any[];
  /** Extra resources a single test created (second billing, sniff server). */
  extraCleanups: Array<[name: string, run: () => unknown]>;
  fetches: FetchTracker;
}

/** The fixture of the test currently running; torn down in afterEach. */
let current: Fixture | undefined;

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Keep-alive sockets from the SDK's fetch would otherwise hold close() open.
    (server as any).closeAllConnections?.();
  });
}

async function setup(perFrameEvents = false): Promise<Fixture> {
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

  const wss = new WSServer({ port: 0, host: '127.0.0.1' });
  await onceOrError(wss, 'listening');
  const wssPort = wss.address().port;

  const billing = new AforoWsBilling({
    tenantId: 'tenant-int-ws',
    productId: 'prod-int-ws',
    apiKey: 'sk_int_ws',
    ingestorUrl: `http://127.0.0.1:${ingestorPort}/ingest`,
    flushCount: 1,
    flushIntervalMs: 60_000,
    perFrameEvents,
  });
  billing.wrapServer(wss as any, {
    extractCustomerId: (req: any) => {
      // Use the request's URL query string as the cust source: ?cid=cust_xyz
      const url = new URL(req.url, `http://${req.headers.host}`);
      return url.searchParams.get('cid') ?? undefined;
    },
  });

  // Server-side view of each connection. Registered AFTER wrapServer, so by
  // the time these counters move the SDK's own listeners have already run.
  const serverSockets: Fixture['serverSockets'] = [];
  wss.on('connection', (ws: any) => {
    const state = { received: 0, closed: false };
    serverSockets.push(state);
    ws.on('message', () => { state.received++; });
    ws.on('close', () => { state.closed = true; });
  });

  current = { wssPort, wss, ingestorServer, captured, billing, serverSockets, clients: [], extraCleanups: [], fetches };
  return current;
}

/** Open a real client, tracked for teardown. Rejects with the real error if the connect fails. */
async function connect(f: Fixture, pathAndQuery: string): Promise<any> {
  const client = new WSClient(`ws://127.0.0.1:${f.wssPort}${pathAndQuery}`);
  f.clients.push(client);
  await onceOrError(client, 'open');
  return client;
}

/**
 * Quiesce, then close — in dependency order, and independent of how the test
 * ended: drop every client, wait for the server to see them gone (that is when
 * the SDK emits CONNECTION_CLOSED), flush, wait for every in-flight flush to
 * land, and only then close the ingestor it is flushing to.
 */
async function teardown(f: Fixture): Promise<void> {
  await runCleanups([
    ['terminate clients', () => { for (const c of f.clients) c.terminate(); }],
    ['terminate server-side sockets', () => { for (const ws of f.wss.clients) ws.terminate(); }],
    ['server sockets closed', () =>
      waitFor(() => f.wss.clients.size === 0, () => `wss.clients to empty (size=${f.wss.clients.size})`)],
    ...f.extraCleanups.filter(([name]) => name.startsWith('billing')),
    ['billing.shutdown', () => f.billing.shutdown()],
    ['in-flight flushes', () =>
      waitFor(() => f.fetches.pending() === 0, () => `SDK fetches to settle (pending=${f.fetches.pending()})`)],
    ['wss.close', () => new Promise<void>((r) => f.wss.close(() => r()))],
    ...f.extraCleanups.filter(([name]) => !name.startsWith('billing')),
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

describe('Real-broker integration (ws.WebSocketServer + ws client)', () => {
  if (!havePeers) {
    test.skip('ws peer-dep not installed — integration test skipped', () => {});
    return;
  }

  afterEach(async () => {
    const f = current;
    current = undefined;
    if (f) await teardown(f);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  itIfPeers(
    'CONNECTION_OPENED is emitted on real handshake; customer_id resolved from req URL',
    async () => {
      const fix = await setup();
      await connect(fix, '/?cid=cust_alpha');

      const events = await waitForEvents(
        fix.captured,
        (evs) => evs.some((e: any) => e.metadata?.event === 'CONNECTION_OPENED'),
        'a CONNECTION_OPENED event',
      );

      const opened = events.find((e: any) => e.metadata?.event === 'CONNECTION_OPENED');
      expect(opened).toBeDefined();
      expect(opened.customerId).toBe('cust_alpha');
      expect(opened.productType).toBe('WEBSOCKET_API');
      expect(opened.wsFrameType).toBe('PING');           // SDK uses PING as the lifecycle "open" marker
      expect(opened.wsDirection).toBe('SERVER_TO_CLIENT');
      expect(opened.metadata.event).toBe('CONNECTION_OPENED');
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  itIfPeers(
    'CONNECTION_CLOSED carries aggregated message count + bytes after real frames',
    async () => {
      const fix = await setup();
      const client = await connect(fix, '/?cid=cust_beta');

      // Send a few client→server frames
      client.send('hello-1');     // 7 bytes
      client.send('hello-22');    // 8 bytes
      client.send(Buffer.from([1, 2, 3, 4, 5])); // 5 bytes binary

      // Close only once the server has actually received all three frames.
      await waitFor(
        () => fix.serverSockets[0]?.received === 3,
        () => `server to receive 3 frames (received=${fix.serverSockets[0]?.received})`,
      );
      client.close(1000, 'normal');

      const events = await waitForEvents(
        fix.captured,
        (evs) => evs.some((e: any) => e.metadata?.event === 'CONNECTION_CLOSED'),
        'a CONNECTION_CLOSED event',
      );

      const closed = events.find((e: any) => e.metadata?.event === 'CONNECTION_CLOSED');
      expect(closed).toBeDefined();
      expect(closed.customerId).toBe('cust_beta');
      expect(closed.productType).toBe('WEBSOCKET_API');
      expect(closed.messageCount).toBe(3);     // 3 frames received
      expect(closed.dataBytes).toBe(7 + 8 + 5); // sum of payload bytes
      expect(closed.wsCloseReason).toBe('NORMAL_CLOSURE');
      expect(closed.executionDurationMs).toBeGreaterThanOrEqual(0);
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  itIfPeers(
    'connections without resolved customerId are silently skipped (no metering)',
    async () => {
      const fix = await setup();

      // No ?cid=... query → extractCustomerId returns null → skip metering
      const anonymous = await connect(fix, '/');
      anonymous.close();
      await waitFor(
        () => fix.serverSockets[0]?.closed,
        () => 'server to see the anonymous connection close',
      );

      // Proving "nothing was emitted" by sleeping is a guess. Instead send a
      // sentinel connection AFTER it that must be metered: once the sentinel's
      // full lifecycle has reached the ingestor, anything the anonymous
      // connection had emitted would be there too.
      const sentinel = await connect(fix, '/?cid=cust_sentinel');
      sentinel.close();
      const events = await waitForEvents(
        fix.captured,
        (evs) => evs.some((e: any) => e.customerId === 'cust_sentinel' && e.metadata?.event === 'CONNECTION_CLOSED'),
        'the sentinel CONNECTION_CLOSED event',
      );

      expect(events.filter((e: any) => e.customerId !== 'cust_sentinel')).toEqual([]);
      // The two events are separate fire-and-forget POSTs — arrival order is not guaranteed.
      expect(events.map((e: any) => e.metadata?.event).sort()).toEqual(['CONNECTION_CLOSED', 'CONNECTION_OPENED']);
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  itIfPeers(
    'authorization + tenant headers reach the ingestor',
    async () => {
      const fix = await setup();
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

      const billing2 = new AforoWsBilling({
        tenantId: 'tenant-headers',
        productId: 'prod-headers',
        apiKey: 'sk_header_check',
        ingestorUrl: `http://127.0.0.1:${port}/ingest`,
        flushCount: 1,
      });
      fix.extraCleanups.push(['billing2.shutdown', () => billing2.shutdown()]);
      billing2.wrapServer(fix.wss as any, {
        extractCustomerId: () => 'cust_header_test',
      });

      await connect(fix, '/');

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
