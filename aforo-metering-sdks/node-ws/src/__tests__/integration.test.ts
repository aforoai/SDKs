/**
 * Real-broker integration test for @aforo/ws-metering.
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
}

async function setup(perFrameEvents = false): Promise<Fixture> {
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
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const wssPort = wss.address().port;

  const billing = new AforoWsBilling({
    tenantId: 'tenant-int-ws',
    productId: 'prod-int-ws',
    apiKey: 'sk_int_ws',
    // A final flush during teardown can race the just-closed ingestor server;
    // that late failure is expected here and must not log after the test ends.
    onError: () => {},
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

  return { wssPort, wss, ingestorServer, captured, billing };
}

async function teardown(f: Fixture): Promise<void> {
  await f.billing.shutdown();
  await new Promise<void>((r) => f.wss.close(() => r()));
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
  throw new Error(
    `waitForEvents timed out. captured=${JSON.stringify(captured, null, 2)}`,
  );
}

describe('Real-broker integration (ws.WebSocketServer + ws client)', () => {
  if (!havePeers) {
    test.skip('ws peer-dep not installed — integration test skipped', () => {});
    return;
  }

  itIfPeers(
    'CONNECTION_OPENED is emitted on real handshake; customer_id resolved from req URL',
    async () => {
      const fix = await setup();
      try {
        const client = new WSClient(`ws://127.0.0.1:${fix.wssPort}/?cid=cust_alpha`);
        await new Promise<void>((r, rj) => {
          client.once('open', () => r());
          client.once('error', rj);
        });

        const events = await waitForEvents(
          fix.captured,
          (evs) => evs.some((e: any) => e.metadata?.event === 'CONNECTION_OPENED'),
        );

        const opened = events.find((e: any) => e.metadata?.event === 'CONNECTION_OPENED');
        expect(opened).toBeDefined();
        expect(opened.customerId).toBe('cust_alpha');
        expect(opened.productType).toBe('WEBSOCKET_API');
        expect(opened.wsFrameType).toBe('PING');           // SDK uses PING as the lifecycle "open" marker
        expect(opened.wsDirection).toBe('SERVER_TO_CLIENT');
        expect(opened.metadata.event).toBe('CONNECTION_OPENED');

        client.close();
      } finally {
        await teardown(fix);
      }
    },
    10_000,
  );

  itIfPeers(
    'CONNECTION_CLOSED carries aggregated message count + bytes after real frames',
    async () => {
      const fix = await setup();
      try {
        const client = new WSClient(`ws://127.0.0.1:${fix.wssPort}/?cid=cust_beta`);
        await new Promise<void>((r, rj) => {
          client.once('open', () => r());
          client.once('error', rj);
        });

        // Send a few client→server frames
        client.send('hello-1');     // 7 bytes
        client.send('hello-22');    // 8 bytes
        client.send(Buffer.from([1, 2, 3, 4, 5])); // 5 bytes binary

        // Give the server time to receive them
        await new Promise((r) => setTimeout(r, 100));
        client.close(1000, 'normal');

        const events = await waitForEvents(
          fix.captured,
          (evs) => evs.some((e: any) => e.metadata?.event === 'CONNECTION_CLOSED'),
        );

        const closed = events.find((e: any) => e.metadata?.event === 'CONNECTION_CLOSED');
        expect(closed).toBeDefined();
        expect(closed.customerId).toBe('cust_beta');
        expect(closed.productType).toBe('WEBSOCKET_API');
        expect(closed.messageCount).toBe(3);     // 3 frames received
        expect(closed.dataBytes).toBe(7 + 8 + 5); // sum of payload bytes
        expect(closed.wsCloseReason).toBe('NORMAL_CLOSURE');
        expect(closed.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        await teardown(fix);
      }
    },
    10_000,
  );

  itIfPeers(
    'connections without resolved customerId are silently skipped (no metering)',
    async () => {
      const fix = await setup();
      try {
        // No ?cid=... query → extractCustomerId returns null → skip metering
        const client = new WSClient(`ws://127.0.0.1:${fix.wssPort}/`);
        await new Promise<void>((r, rj) => {
          client.once('open', () => r());
          client.once('error', rj);
        });
        client.close();

        // Give it 200ms — enough time that any spurious event would have flushed
        await new Promise((r) => setTimeout(r, 200));
        await fix.billing.shutdown();

        expect(flatEvents(fix.captured)).toHaveLength(0);
      } finally {
        // shutdown() already called above, but teardown is idempotent
        await new Promise<void>((r) => fix.wss.close(() => r()));
        await new Promise<void>((r) => fix.ingestorServer.close(() => r()));
      }
    },
    10_000,
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
      await new Promise<void>((r) => sniffServer.listen(0, '127.0.0.1', r));
      const port = (sniffServer.address() as AddressInfo).port;

      const billing2 = new AforoWsBilling({
        tenantId: 'tenant-headers',
        productId: 'prod-headers',
        apiKey: 'sk_header_check',
        onError: () => {}, // suppress the teardown-race flush failure (see setup())
        ingestorUrl: `http://127.0.0.1:${port}/ingest`,
        flushCount: 1,
      });
      billing2.wrapServer(fix.wss as any, {
        extractCustomerId: () => 'cust_header_test',
      });

      try {
        const client = new WSClient(`ws://127.0.0.1:${fix.wssPort}/`);
        await new Promise<void>((r, rj) => {
          client.once('open', () => r());
          client.once('error', rj);
        });

        const deadline = Date.now() + 2000;
        while (sniffed.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }

        expect(sniffed.length).toBeGreaterThan(0);
        const headers = sniffed[0];
        expect(headers['authorization']).toBe('Bearer sk_header_check');
        expect(headers['x-tenant-id']).toBe('tenant-headers');

        client.close();
      } finally {
        await billing2.shutdown();
        await new Promise<void>((r) => sniffServer.close(() => r()));
        await teardown(fix);
      }
    },
    10_000,
  );
});
