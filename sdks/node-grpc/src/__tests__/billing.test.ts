/**
 * Tests for AforoGrpcBilling — covers the buffer/flush/retry pattern
 * that's shared (with minor variations) across all 4 Node SDKs:
 * @aforo/grpc-metering, @aforo/graphql-metering, @aforo/ws-metering,
 * @aforo/mqtt-metering. If this test breaks, the same bug is likely
 * present in the sibling packages.
 */

import { AforoGrpcBilling, GRPC_STATUS } from '../index';

// ── Test setup ───────────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: any;
}

let capturedRequests: CapturedRequest[];
let nextFetchResponse: Response | (() => Response | Promise<Response>);

const okResponse = () =>
  ({ ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({}) } as unknown as Response);

const failResponse = (status: number) =>
  ({ ok: false, status, statusText: 'fail', text: async () => '', json: async () => ({}) } as unknown as Response);

beforeEach(() => {
  capturedRequests = [];
  nextFetchResponse = okResponse();

  global.fetch = jest.fn(async (input: any, init: any = {}) => {
    let body: any = init.body;
    try { body = JSON.parse(init.body); } catch { /* leave as-is */ }
    capturedRequests.push({ url: String(input), init, body });
    if (typeof nextFetchResponse === 'function') return nextFetchResponse();
    return nextFetchResponse;
  }) as any;
});

afterEach(() => {
  jest.useRealTimers();
});

// Tiny helper that mimics the gRPC server-call surface our SDK touches.
function makeCall(metadataMap: Record<string, string | string[]> = { 'x-customer-id': 'cust_001' }) {
  return {
    metadata: { getMap: () => metadataMap },
  } as any;
}
function makeCallback() {
  const calls: Array<{ err: any; res: any }> = [];
  const cb = (err: any, res: any) => calls.push({ err, res });
  return { cb, calls };
}

const config = () => ({
  tenantId: 'tenant-001',
  productId: 'prod-001',
  apiKey: 'sk_test_abc',
  ingestorUrl: 'https://ingestor.aforo.ai/',  // trailing slash on purpose — SDK should strip it
  serviceName: 'acme.v1.UserService',
});

// ── Construction & validation ────────────────────────────────────────────

describe('constructor', () => {
  test('builds with valid config — no fetch call until shutdown/flush', async () => {
    const b = new AforoGrpcBilling(config());
    expect(global.fetch).not.toHaveBeenCalled();
    await b.shutdown();
  });

  test('GRPC_STATUS exports the standard 17 codes', () => {
    expect(GRPC_STATUS.OK).toBe(0);
    expect(GRPC_STATUS.UNAUTHENTICATED).toBe(16);
    expect(Object.keys(GRPC_STATUS)).toHaveLength(17);
  });
});

// ── Unary handler wrapping ───────────────────────────────────────────────

describe('wrapUnary', () => {
  test('OK status — single billing event, status="OK", callType="UNARY"', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 1 });
    const handler = jest.fn(async () => ({ id: 'u1', name: 'Jane' }));
    const wrapped = b.wrapUnary('GetUser', handler);

    const { cb, calls } = makeCallback();
    wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));  // allow microtasks + flush

    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ err: null, res: { id: 'u1', name: 'Jane' } }]);
    expect(capturedRequests).toHaveLength(1);
    const event = capturedRequests[0].body.events[0];
    expect(event).toMatchObject({
      productType: 'GRPC_API',
      grpcService: 'acme.v1.UserService',
      grpcMethod: 'GetUser',
      grpcStatusCode: 'OK',
      grpcCallType: 'UNARY',
      messageCount: 1,
      customerId: 'cust_001',
    });
    expect(event.executionDurationMs).toBeGreaterThanOrEqual(0);
    await b.shutdown();
  });

  test('handler rejects with grpc.code → status mapped to descriptor enum', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 1 });
    const err: any = new Error('boom');
    err.code = 5; // NOT_FOUND
    const handler = jest.fn(async () => { throw err; });
    const wrapped = b.wrapUnary('GetUser', handler);

    const { cb, calls } = makeCallback();
    wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toEqual([{ err, res: null }]);
    const event = capturedRequests[0].body.events[0];
    expect(event.grpcStatusCode).toBe('NOT_FOUND');
    expect(event.customerId).toBe('cust_001');
    await b.shutdown();
  });

  test('handler rejects without grpc.code → mapped to UNKNOWN', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 1 });
    const wrapped = b.wrapUnary('GetUser', async () => { throw new Error('plain'); });

    const { cb } = makeCallback();
    wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));

    expect(capturedRequests[0].body.events[0].grpcStatusCode).toBe('UNKNOWN');
    await b.shutdown();
  });

  test('no x-customer-id metadata → call NOT metered (skips billing)', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 1 });
    const wrapped = b.wrapUnary('Health', async () => ({ ok: true }));
    const { cb } = makeCallback();
    wrapped(makeCall({}), cb);
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedRequests).toHaveLength(0);
    await b.shutdown();
  });

  test('custom customerIdExtractor is honoured', async () => {
    const b = new AforoGrpcBilling({
      ...config(),
      flushCount: 1,
      customerIdExtractor: () => 'cust_from_extractor',
    });
    const wrapped = b.wrapUnary('M', async () => ({}));
    const { cb } = makeCallback();
    wrapped(makeCall({}), cb);
    await new Promise((r) => setTimeout(r, 20));

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].body.events[0].customerId).toBe('cust_from_extractor');
    await b.shutdown();
  });
});

// ── Buffer batching ──────────────────────────────────────────────────────

describe('buffering', () => {
  test('flushes when flushCount is reached', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 3 });
    const wrapped = b.wrapUnary('M', async () => ({}));
    const { cb } = makeCallback();

    // 2 calls — should NOT flush yet
    wrapped(makeCall(), cb);
    wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedRequests).toHaveLength(0);

    // 3rd call → flush triggers
    wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].body.events).toHaveLength(3);
    await b.shutdown();
  });

  test('shutdown() flushes remaining buffered events', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 100 });
    const wrapped = b.wrapUnary('M', async () => ({}));
    const { cb } = makeCallback();

    wrapped(makeCall(), cb);
    wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedRequests).toHaveLength(0);

    await b.shutdown();
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].body.events).toHaveLength(2);
  });

  test('idempotencyKey is unique across rapid calls (no collision)', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 5 });
    const wrapped = b.wrapUnary('M', async () => ({}));
    const { cb } = makeCallback();

    for (let i = 0; i < 5; i++) wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));

    const keys = capturedRequests[0].body.events.map((e: any) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(5);  // all distinct
    keys.forEach((k: string) => expect(k).toMatch(/^grpc:tenant-001:acme\.v1\.UserService:M:\d+:[a-z0-9]{8}$/));
    await b.shutdown();
  });
});

// ── HTTP request shape ───────────────────────────────────────────────────

describe('flush request shape', () => {
  test('POST to ingestorUrl + /v1/ingest/events with right headers', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 1 });
    const wrapped = b.wrapUnary('M', async () => ({}));
    const { cb } = makeCallback();
    wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));

    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0];
    expect(req.url).toBe('https://ingestor.aforo.ai/v1/ingest/events'); // trailing slash stripped
    expect(req.init.method).toBe('POST');
    const headers = req.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer sk_test_abc');
    expect(headers['X-Tenant-Id']).toBe('tenant-001');
    await b.shutdown();
  });

  test('event body includes sdkVersion + productId in metadata', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 1 });
    const wrapped = b.wrapUnary('M', async () => ({}));
    const { cb } = makeCallback();
    wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));

    const event = capturedRequests[0].body.events[0];
    expect(event.metadata.productId).toBe('prod-001');
    expect(typeof event.metadata.sdkVersion).toBe('string');
    expect(event.metricName).toBe('grpc_api.rpc_calls');
    expect(event.quantity).toBe(1);
    await b.shutdown();
  });
});

// ── Retry behaviour ──────────────────────────────────────────────────────

describe('retry on flush failure', () => {
  test('retries 3× on non-2xx response, then drops batch and invokes onError', async () => {
    jest.useFakeTimers();
    const onError = jest.fn();
    const b = new AforoGrpcBilling({ ...config(), flushCount: 1, onError });
    nextFetchResponse = () => failResponse(500);

    const wrapped = b.wrapUnary('M', async () => ({}));
    const { cb } = makeCallback();
    wrapped(makeCall(), cb);

    // Microtasks advance the first send; then we tick through the retry sleeps.
    await Promise.resolve();
    await Promise.resolve();
    for (const ms of [1000, 2000, 4000]) {
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(capturedRequests.length).toBe(3);   // 3 attempts
    expect(onError).toHaveBeenCalledTimes(1);  // dropped
    expect(onError.mock.calls[0][0].message).toMatch(/3 attempts/);
    jest.useRealTimers();
    await b.shutdown();
  });

  test('successful 1st attempt → no retry, no onError', async () => {
    const onError = jest.fn();
    const b = new AforoGrpcBilling({ ...config(), flushCount: 1, onError });
    const wrapped = b.wrapUnary('M', async () => ({}));
    const { cb } = makeCallback();
    wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));

    expect(capturedRequests).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    await b.shutdown();
  });
});

// ── Streaming wrappers (smoke — exact frame counts harder to test without grpc) ──

describe('streaming wrappers — smoke', () => {
  test('wrapServerStream returns a function callable with a writable stream', () => {
    const b = new AforoGrpcBilling(config());
    const wrapped = b.wrapServerStream('Stream', async () => {});
    expect(typeof wrapped).toBe('function');
  });

  test('wrapClientStream returns a function callable with a readable stream + callback', () => {
    const b = new AforoGrpcBilling(config());
    const wrapped = b.wrapClientStream('Upload', async () => ({ accepted: 0 }));
    expect(typeof wrapped).toBe('function');
  });

  test('wrapBidiStream returns a function callable with a duplex stream', () => {
    const b = new AforoGrpcBilling(config());
    const wrapped = b.wrapBidiStream('Chat', async () => {});
    expect(typeof wrapped).toBe('function');
  });
});
