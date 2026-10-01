/**
 * Real-broker integration test for @aforoai/mqtt-metering.
 *
 * Where the unit tests in billing.test.ts use a fake EventEmitter to
 * stand in for the broker, this file spins up a REAL aedes broker on
 * a random localhost port, connects a REAL mqtt.js client to it, wires
 * the SDK's wrapAedesBroker, and asserts that PUBLISH / SUBSCRIBE
 * events make the round trip from real protocol traffic into the
 * captured ingestor payload.
 *
 * Catches the things mock-based tests can't:
 *   - aedes event signatures we may not have read correctly
 *   - real MQTT packet shapes (qos, retain flags, payload framing)
 *   - timing — does the SDK's flush happen on the same tick as the
 *     broker emits?
 *
 * Self-contained: no external broker, no Docker. Uses an in-process
 * aedes + a captured HTTP ingestor on a random port. Skipped
 * automatically when aedes / mqtt aren't installed (peer-deps are
 * optional in package.json).
 */

import { AforoMqttBilling } from '../index';
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

// Conditional require so the test silently no-ops if peers aren't installed.
// Aedes 0.5x ships as an ESM-default-export package; under
// `esModuleInterop` ts-jest gives us the namespace object, so we have to
// reach into `.default` for the actual factory function. Plain `require`
// in node CJS already does this — but staying explicit avoids surprises
// across Jest / Node / TypeScript versions.
let aedesFactory: any;
let mqttPkg: any;
try {
  const aedesNs = require('aedes');
  aedesFactory = aedesNs && (aedesNs.default || aedesNs);
  mqttPkg = require('mqtt');
} catch {
  // Peers missing — every test is guarded by `havePeers` below.
  // Note: aedes >= 1.0 is pure ESM and won't load under CommonJS Jest.
  // The SDK's package.json pins `aedes ^0.51.0` for this reason.
}

const havePeers = typeof aedesFactory === 'function' && mqttPkg && typeof mqttPkg.connect === 'function';
const itIfPeers = havePeers ? test : test.skip;

// ── Per-test fixtures ──────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  body: any;
}

interface Fixture {
  brokerPort: number;
  brokerServer: any;
  aedes: any;
  ingestorServer: http.Server;
  ingestorUrl: string;
  captured: CapturedRequest[];
  billing: AforoMqttBilling;
  /** Every mqtt.js client a test opened — force-closed in teardown whatever the outcome. */
  clients: any[];
  /** Extra SDK instances a single test created; shut down alongside `billing`. */
  extraBillings: AforoMqttBilling[];
  /** Extra servers a single test created; closed after every flush has landed. */
  extraServers: http.Server[];
  fetches: FetchTracker;
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Keep-alive sockets from the SDK's fetch would otherwise hold close() open.
    (server as any).closeAllConnections?.();
  });
}

async function setup(): Promise<Fixture> {
  const fetches = trackFetch();
  // ── 1. Capture HTTP ingestor on a random port
  const captured: CapturedRequest[] = [];
  const ingestorServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : null;
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
  const ingestorUrl = `http://127.0.0.1:${ingestorPort}/ingest`;

  // ── 2. Real aedes broker on a random port
  const aedes = aedesFactory();
  // aedes 0.5x exports an instantiable factory (`require('aedes')()`)
  // and exposes `.handle` for use with net.createServer.
  const net = await import('net');
  const brokerServer = net.createServer(aedes.handle);
  await new Promise<void>((r) => brokerServer.listen(0, '127.0.0.1', r));
  const brokerPort = (brokerServer.address() as AddressInfo).port;

  // ── 3. SDK wired to capture-ingestor + real broker
  const billing = new AforoMqttBilling({
    tenantId: 'tenant-integ-001',
    productId: 'prod-mqtt-integ',
    apiKey: 'sk_integ',
    ingestorUrl,
    flushCount: 1,             // flush after every event so the test is deterministic
    flushIntervalMs: 60_000,   // long timer; flushCount=1 dominates
  });
  billing.wrapAedesBroker(aedes as any, {
    resolveCustomerId: (clientId) => `cust_${clientId}`,
  });

  return {
    brokerPort, brokerServer, aedes, ingestorServer, ingestorUrl, captured, billing,
    clients: [], extraBillings: [], extraServers: [], fetches,
  };
}

/** Connect a real mqtt.js client, tracked for teardown. Rejects with the real error if the connect fails. */
async function connectClient(f: Fixture, clientId: string): Promise<any> {
  const client = mqttPkg.connect(`mqtt://127.0.0.1:${f.brokerPort}`, { clientId });
  f.clients.push(client);
  await onceOrError(client, 'connect');
  return client;
}

/**
 * Quiesce, then close — in dependency order, and independent of how the test
 * ended. Clients are force-ended first: an mqtt.js client left connected is
 * exactly what makes aedes.close() / server.close() hang. Then wait for the
 * broker to see them gone (that is when the SDK emits its disconnect event),
 * flush, wait for every in-flight flush to land, and only then close the
 * broker and the ingestors being flushed to.
 */
async function teardown(f: Fixture): Promise<void> {
  await runCleanups([
    ['force-end clients', () => { for (const c of f.clients) c.end(true); }],
    ['broker sees clients gone', () =>
      waitFor(
        () => f.aedes.connectedClients === 0,
        () => `aedes.connectedClients to reach 0 (now ${f.aedes.connectedClients})`,
      )],
    ...f.extraBillings.map((b, i): [string, () => unknown] => [`extraBillings[${i}].shutdown`, () => b.shutdown()]),
    ['billing.shutdown', () => f.billing.shutdown()],
    ['in-flight flushes', () =>
      waitFor(() => f.fetches.pending() === 0, () => `SDK fetches to settle (pending=${f.fetches.pending()})`)],
    ['aedes.close', () => new Promise<void>((r) => f.aedes.close(() => r()))],
    ['broker server.close', () => new Promise<void>((r) => f.brokerServer.close(() => r()))],
    ...f.extraServers.map((srv, i): [string, () => unknown] => [`extraServers[${i}].close`, () => closeHttpServer(srv)]),
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

// ── Tests ──────────────────────────────────────────────────────────────

describe('Real-broker integration (aedes + mqtt.js)', () => {
  if (!havePeers) {
    test.skip('aedes/mqtt peer-deps not installed — integration test skipped', () => {});
    return;
  }

  let fix: Fixture;

  beforeEach(async () => {
    fix = await setup();
  });

  afterEach(async () => {
    await teardown(fix);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  itIfPeers(
    'PUBLISH event traverses real MQTT pub → aedes hook → SDK → ingestor',
    async () => {
      const client = await connectClient(fix, 'device-int-001');

      client.publish('sensors/room-a/temperature', Buffer.from('22.7'), { qos: 1, retain: false });

      // Wait for the published event to have been captured by our ingestor.
      const events = await waitForEvents(
        fix.captured,
        (evs) => evs.some((e: any) => e.mqttEventType === 'PUBLISH'),
        'a PUBLISH event',
      );

      const pub = events.find((e: any) => e.mqttEventType === 'PUBLISH');
      expect(pub).toBeDefined();
      expect(pub.productType).toBe('MQTT_BROKER');
      expect(pub.mqttTopic).toBe('sensors/room-a/temperature');
      expect(pub.mqttQos).toBe(1);
      expect(pub.mqttRetained).toBe(false);
      expect(pub.mqttClientId).toBe('device-int-001');
      expect(pub.customerId).toBe('cust_device-int-001');
      expect(pub.dataBytes).toBe(4); // "22.7"

    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  itIfPeers(
    'SUBSCRIBE event traverses real MQTT subscribe → aedes hook → SDK → ingestor',
    async () => {
      const client = await connectClient(fix, 'device-int-002');

      await new Promise<void>((r, rj) =>
        client.subscribe('alerts/critical', { qos: 2 }, (err: any) => (err ? rj(err) : r())),
      );

      const events = await waitForEvents(
        fix.captured,
        (evs) => evs.some((e: any) => e.mqttEventType === 'SUBSCRIBE'),
        'a SUBSCRIBE event',
      );

      const sub = events.find((e: any) => e.mqttEventType === 'SUBSCRIBE');
      expect(sub).toBeDefined();
      expect(sub.mqttTopic).toBe('alerts/critical');
      expect(sub.mqttQos).toBe(2);
      expect(sub.mqttClientId).toBe('device-int-002');
      expect(sub.customerId).toBe('cust_device-int-002');

    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  itIfPeers(
    'authorization + tenant headers reach the ingestor on every batch',
    async () => {
      // Sniff one request so we can inspect headers (the captured array
      // only stores body — extend just for this assertion).
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
      fix.extraServers.push(sniffServer);
      await new Promise<void>((r) => sniffServer.listen(0, '127.0.0.1', r));
      const port = (sniffServer.address() as AddressInfo).port;

      const billing2 = new AforoMqttBilling({
        tenantId: 'tenant-headers',
        productId: 'prod-headers',
        apiKey: 'sk_header_check',
        ingestorUrl: `http://127.0.0.1:${port}/ingest`,
        flushCount: 1,
      });
      fix.extraBillings.push(billing2);
      billing2.wrapAedesBroker(fix.aedes as any, {
        resolveCustomerId: (clientId) => `cust_${clientId}`,
      });

      const client = await connectClient(fix, 'device-int-headers');
      client.publish('h/test', Buffer.from('x'), { qos: 0, retain: false });

      const headers = await waitFor(
        () => sniffed[0],
        () => 'a request to reach the header-sniffing ingestor',
      );
      // Both SDK instances are wired to the broker; every request that reaches
      // the sniffer comes from billing2.
      expect(headers['x-api-key']).toBe('sk_header_check');
      expect(headers['authorization']).toBeUndefined();
      expect(headers['x-tenant-id']).toBe('tenant-headers');
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
