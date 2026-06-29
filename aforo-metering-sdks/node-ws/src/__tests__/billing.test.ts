/**
 * Tests for AforoWsBilling. Unique bits vs. gRPC family canary:
 *   - Connection lifecycle: OPEN → N frames → CLOSE (aggregate counts on close)
 *   - perFrameEvents flag: false (default) vs true
 *   - Close-code → descriptor-enum mapping (1000 NORMAL_CLOSURE, 1006 ABNORMAL_CLOSURE, ...)
 *   - wrapServer: attaches to WebSocketServer 'connection' events
 */

import { AforoWsBilling, WS_CLOSE_REASONS } from '../index';
import { EventEmitter } from 'events';

// ── HTTP capture ────────────────────────────────────────────────────────

interface Captured { url: string; init: RequestInit; body: any }
let capturedRequests: Captured[];

beforeEach(() => {
  capturedRequests = [];
  global.fetch = jest.fn(async (input: any, init: any = {}) => {
    let body: any = init.body;
    try { body = JSON.parse(init.body); } catch { /* ignore */ }
    capturedRequests.push({ url: String(input), init, body });
    return { ok: true, status: 200, statusText: 'OK' } as unknown as Response;
  }) as any;
});

const config = () => ({
  tenantId: 'tenant-001',
  productId: 'prod-ws-001',
  apiKey: 'sk_ws_abc',
  ingestorUrl: 'https://ingestor.aforo.ai',
});

// A tiny WebSocket stub that matches the SDK's MinimalWs surface.
class FakeWs extends EventEmitter {
  readyState = 1;
  send(_data: any, _cb?: any) { /* stubbed; billing rewrites this at trackConnection time */ }
}

function eventsOfType(type: string) {
  return capturedRequests
    .flatMap(r => r.body?.events ?? [])
    .filter((e: any) => e.metadata?.event === type);
}

// ── Connection lifecycle: default (no per-frame) ────────────────────────

describe('trackConnection — default (OPEN + CLOSE only)', () => {
  test('emits CONNECTION_OPENED immediately', async () => {
    const billing = new AforoWsBilling({ ...config(), flushCount: 1 });
    const ws = new FakeWs();
    billing.trackConnection(ws as any, { customerId: 'cust_001' });
    await new Promise((r) => setTimeout(r, 20));

    expect(capturedRequests).toHaveLength(1);
    const opens = eventsOfType('CONNECTION_OPENED');
    expect(opens).toHaveLength(1);
    expect(opens[0].productType).toBe('WEBSOCKET_API');
    expect(opens[0].customerId).toBe('cust_001');
    expect(opens[0].wsFrameType).toBe('PING');   // lifecycle marker
    expect(opens[0].messageCount).toBe(0);
    await billing.shutdown();
  });

  test('messages during the connection are NOT emitted per-frame when perFrameEvents=false', async () => {
    const billing = new AforoWsBilling({ ...config(), flushCount: 100 });  // high to avoid flush
    const ws = new FakeWs();
    billing.trackConnection(ws as any, { customerId: 'cust_001' });

    ws.emit('message', 'msg-1', false);
    ws.emit('message', 'msg-2', false);
    ws.send('out-1');
    ws.send('out-2');
    await new Promise((r) => setTimeout(r, 20));

    // Only the OPEN event so far (close hasn't fired)
    const allEvents = capturedRequests.flatMap(r => r.body?.events ?? []);
    expect(allEvents).toHaveLength(0);   // nothing flushed (flushCount=100)
    await billing.shutdown();
    // After shutdown, the OPEN event is drained (4 send/recv each updated the state
    // but did NOT produce events — proves default mode aggregates on close only)
    const drained = capturedRequests.flatMap(r => r.body?.events ?? []);
    expect(drained.filter((e: any) => e.metadata?.event === 'CONNECTION_OPENED')).toHaveLength(1);
    // Neither per-frame events
    expect(drained.filter((e: any) => e.wsFrameType === 'TEXT' || e.wsFrameType === 'BINARY')).toHaveLength(0);
  });

  test('CLOSE emits aggregated messageCount + dataBytes from both directions', async () => {
    const billing = new AforoWsBilling({ ...config(), flushCount: 100 });
    const ws = new FakeWs();
    billing.trackConnection(ws as any, { customerId: 'cust_001', metadata: { region: 'us-east-1' } });

    ws.emit('message', 'aaa', false);     // 3 bytes inbound
    ws.emit('message', 'bbbb', false);    // 4 bytes inbound
    ws.send('xxxxx');                     // 5 bytes outbound
    ws.send('yy');                        // 2 bytes outbound
    ws.emit('close', 1000);
    await billing.shutdown();

    const closes = eventsOfType('CONNECTION_CLOSED');
    expect(closes).toHaveLength(1);
    const ev = closes[0];
    expect(ev.wsFrameType).toBe('CLOSE');
    expect(ev.wsCloseReason).toBe('NORMAL_CLOSURE');
    expect(ev.messageCount).toBe(4);             // 2 in + 2 out
    expect(ev.dataBytes).toBe(3 + 4 + 5 + 2);    // 14
    expect(ev.durationMs).toBeGreaterThanOrEqual(0);
    expect(ev.metadata.sentCount).toBe(2);
    expect(ev.metadata.recvCount).toBe(2);
    expect(ev.metadata.sentBytes).toBe(7);
    expect(ev.metadata.recvBytes).toBe(7);
    expect(ev.metadata.region).toBe('us-east-1');  // caller metadata merged through
  });

  test("error event synthesizes a CONNECTION_ERROR-style CLOSE with 'INTERNAL_ERROR' reason", async () => {
    const billing = new AforoWsBilling({ ...config(), flushCount: 100 });
    const ws = new FakeWs();
    billing.trackConnection(ws as any, { customerId: 'cust_001' });

    ws.emit('error', new Error('socket tearoff'));
    await billing.shutdown();

    const errEvents = capturedRequests
      .flatMap(r => r.body?.events ?? [])
      .filter((e: any) => e.metadata?.event === 'CONNECTION_ERROR');
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0].wsFrameType).toBe('CLOSE');
    expect(errEvents[0].wsCloseReason).toBe('INTERNAL_ERROR');
    expect(errEvents[0].metadata.error).toBe('socket tearoff');
  });
});

// ── perFrameEvents=true ─────────────────────────────────────────────────

describe('trackConnection — perFrameEvents=true', () => {
  test('emits one MESSAGE event per frame (in + out) plus OPEN + CLOSE', async () => {
    const billing = new AforoWsBilling({ ...config(), flushCount: 100, perFrameEvents: true });
    const ws = new FakeWs();
    billing.trackConnection(ws as any, { customerId: 'cust_001' });

    ws.emit('message', 'hello', false);
    ws.emit('message', Buffer.from([1, 2, 3, 4]), true);
    ws.send('world');
    ws.emit('close', 1000);
    await billing.shutdown();

    const all = capturedRequests.flatMap(r => r.body?.events ?? []);
    const opens = all.filter((e: any) => e.metadata?.event === 'CONNECTION_OPENED');
    const closes = all.filter((e: any) => e.metadata?.event === 'CONNECTION_CLOSED');
    const frames = all.filter((e: any) => !e.metadata?.event);   // plain per-frame

    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect(frames).toHaveLength(3);  // 2 in + 1 out

    // Direction + frame-type correctness
    const client = frames.filter((e: any) => e.wsDirection === 'CLIENT_TO_SERVER');
    const server = frames.filter((e: any) => e.wsDirection === 'SERVER_TO_CLIENT');
    expect(client).toHaveLength(2);
    expect(server).toHaveLength(1);
    expect(client.find((e: any) => e.wsFrameType === 'BINARY')?.dataBytes).toBe(4);
  });
});

// ── Close-code mapping ──────────────────────────────────────────────────

describe('close-code mapping', () => {
  test.each([
    [1000, 'NORMAL_CLOSURE'],
    [1001, 'GOING_AWAY'],
    [1002, 'PROTOCOL_ERROR'],
    [1003, 'UNSUPPORTED_DATA'],
    [1006, 'ABNORMAL_CLOSURE'],
    [1008, 'POLICY_VIOLATION'],
    [1009, 'MESSAGE_TOO_BIG'],
    [1011, 'INTERNAL_ERROR'],
    [4000, 'IDLE_TIMEOUT'],
  ])('close code %d → %s', async (code, expected) => {
    const billing = new AforoWsBilling({ ...config(), flushCount: 100 });
    const ws = new FakeWs();
    billing.trackConnection(ws as any, { customerId: 'cust_001' });
    ws.emit('close', code);
    await billing.shutdown();

    const closes = eventsOfType('CONNECTION_CLOSED');
    expect(closes).toHaveLength(1);
    expect(closes[0].wsCloseReason).toBe(expected);
  });

  test('WS_CLOSE_REASONS export contains all expected entries', () => {
    expect(WS_CLOSE_REASONS[1000]).toBe('NORMAL_CLOSURE');
    expect(WS_CLOSE_REASONS[1006]).toBe('ABNORMAL_CLOSURE');
    expect(WS_CLOSE_REASONS[4000]).toBe('IDLE_TIMEOUT');
  });
});

// ── wrapServer ──────────────────────────────────────────────────────────

describe('wrapServer', () => {
  test('attaches to connection event and tracks per-connection', async () => {
    const billing = new AforoWsBilling({ ...config(), flushCount: 100 });
    const wss = new EventEmitter();
    billing.wrapServer(wss as any, {
      extractCustomerId: (req: any) => req.headers['x-customer-id'],
    });

    const ws = new FakeWs();
    wss.emit('connection', ws, { headers: { 'x-customer-id': 'cust_via_server' } });
    ws.emit('close', 1000);
    await billing.shutdown();

    const opens = eventsOfType('CONNECTION_OPENED');
    expect(opens).toHaveLength(1);
    expect(opens[0].customerId).toBe('cust_via_server');
  });

  test('connection with no customerId is NOT tracked', async () => {
    const billing = new AforoWsBilling({ ...config(), flushCount: 100 });
    const wss = new EventEmitter();
    billing.wrapServer(wss as any, { extractCustomerId: () => undefined });

    const ws = new FakeWs();
    wss.emit('connection', ws, { headers: {} });
    ws.emit('close', 1000);
    await billing.shutdown();

    expect(capturedRequests).toHaveLength(0);
  });
});

// ── Event shape ─────────────────────────────────────────────────────────

describe('event shape', () => {
  test('idempotencyKey format: ws:{tenant}:{connectionId}:{frameType}:{millis}:{8-hex}', async () => {
    const billing = new AforoWsBilling({ ...config(), flushCount: 1 });
    const ws = new FakeWs();
    billing.trackConnection(ws as any, { customerId: 'cust_001' });
    await new Promise((r) => setTimeout(r, 20));

    const key = capturedRequests[0].body.events[0].idempotencyKey;
    expect(key).toMatch(/^ws:tenant-001:[0-9a-f-]+:PING:\d+:[a-z0-9]{8}$/);
    await billing.shutdown();
  });

  test('CLOSE emits metricName=websocket_api.connection_closed, others use .message', async () => {
    const billing = new AforoWsBilling({ ...config(), flushCount: 100, perFrameEvents: true });
    const ws = new FakeWs();
    billing.trackConnection(ws as any, { customerId: 'cust_001' });
    ws.emit('message', 'hi', false);
    ws.emit('close', 1000);
    await billing.shutdown();

    const all = capturedRequests.flatMap(r => r.body?.events ?? []);
    const closeEv = all.find((e: any) => e.wsFrameType === 'CLOSE');
    const msgEv = all.find((e: any) => e.wsFrameType === 'TEXT');
    expect(closeEv.metricName).toBe('websocket_api.connection_closed');
    expect(msgEv.metricName).toBe('websocket_api.message');
  });
});
