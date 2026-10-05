/**
 * Tests for AforoGrpcBilling — covers the buffer/flush/retry pattern
 * that's shared (with minor variations) across all 4 Node SDKs:
 * @aforoai/grpc-metering, @aforoai/graphql-metering, @aforoai/ws-metering,
 * @aforoai/mqtt-metering. If this test breaks, the same bug is likely
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
  ingestorUrl: 'https://api.aforo.ai/',  // trailing slash on purpose — SDK should strip it
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
  test('POST to ingestorUrl + /v1/ingest/batch with right headers', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 1 });
    const wrapped = b.wrapUnary('M', async () => ({}));
    const { cb } = makeCallback();
    wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));

    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0];
    expect(req.url).toBe('https://api.aforo.ai/v1/ingest/batch'); // trailing slash stripped
    expect(req.init.method).toBe('POST');
    const headers = req.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-API-Key']).toBe('sk_test_abc');
    expect(headers['Authorization']).toBeUndefined();
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
    // Every retry re-sends the exact same events, idempotencyKeys included.
    const keysPerAttempt = capturedRequests.map((r) => JSON.stringify(r.body.events.map((e: any) => e.idempotencyKey)));
    expect(new Set(keysPerAttempt).size).toBe(1);
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

function assertBatchContract(reqs: Array<{ url: string; init: RequestInit; body: any }>, apiKey: string, allowed: string[]) {
  const allowedSet = new Set(allowed);
  expect(reqs.length).toBeGreaterThan(0);
  for (const r of reqs) {
    expect(r.url).toBe('https://api.aforo.ai/v1/ingest/batch');
    expect((r.init.headers as Record<string, string>)['X-API-Key']).toBe(apiKey);
    expect(Object.keys(r.body)).toEqual(['events']);
    expect(r.body.events.length).toBeGreaterThan(0);
    expect(r.body.events.length).toBeLessThanOrEqual(1000);
    for (const e of r.body.events) {
      for (const k of Object.keys(e)) expect(allowedSet.has(k) ? k : `unexpected field ${k}`).toBe(k);
      expect(JSON.stringify(e)).not.toContain(apiKey);
      for (const k of ['customerId', 'metricName', 'occurredAt', 'idempotencyKey']) {
        expect(typeof e[k]).toBe('string');
        expect(e[k].trim()).not.toBe('');
      }
      expect(e.quantity).toBeGreaterThan(0);
    }
  }
}

describe('ingest batch contract', () => {
  const FIELDS = ['customerId', 'metricName', 'quantity', 'occurredAt', 'idempotencyKey', 'productType', 'metadata', 'grpcService', 'grpcMethod', 'grpcStatusCode',
    'grpcCallType', 'messageCount', 'dataBytes', 'executionDurationMs', 'executionStatus'];

  test('events carry only IngestUsageEventRequest fields', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 100 });
    const { cb } = makeCallback();
    b.wrapUnary('GetUser', async () => ({}))(makeCall(), cb);
    b.wrapUnary('Fail', async () => { throw Object.assign(new Error('x'), { code: 5 }); })(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 20));
    await b.shutdown();
    assertBatchContract(capturedRequests, 'sk_test_abc', FIELDS);
    const failed = capturedRequests[0].body.events.find((e: any) => e.grpcMethod === 'Fail');
    expect(failed.grpcStatusCode).toBe('NOT_FOUND');
  });

  test('>1000 buffered events are split into requests of <=1000', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 5000 });
    const wrapped = b.wrapUnary('M', async () => ({}));
    const { cb } = makeCallback();
    for (let i = 0; i < 2500; i++) wrapped(makeCall(), cb);
    await new Promise((r) => setTimeout(r, 50));
    await b.shutdown();
    expect(capturedRequests.map((r) => r.body.events.length)).toEqual([1000, 1000, 500]);
    assertBatchContract(capturedRequests, 'sk_test_abc', FIELDS);
  });

  test('blank customerId is not metered; an over-long one is dropped as invalid (never thrown, never sent)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const onError = jest.fn();
    const drops: Array<{ events: any[]; reason: string }> = [];
    const b = new AforoGrpcBilling({
      ...config(), flushCount: 100, onError,
      onDrop: (events, reason) => drops.push({ events, reason }),
    });
    const wrapped = b.wrapUnary('M', async () => ({}));
    const { cb, calls } = makeCallback();
    wrapped(makeCall({ 'x-customer-id': '   ' }), cb);
    wrapped(makeCall({ 'x-customer-id': 'c'.repeat(65) }), cb);
    await new Promise((r) => setTimeout(r, 20));
    await b.shutdown();
    expect(calls).toHaveLength(2); // both RPCs still answered
    expect(capturedRequests).toHaveLength(0);
    expect(b.droppedCount).toBe(1); // the blank one is non-billable, not a drop
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('invalid');
    expect(drops[0].events[0].customerId).toBe('c'.repeat(65));
    expect(drops[0].events[0].idempotencyKey).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/invalid: customerId is 65 chars, limit 64/);
    warn.mockRestore();
  });

  test('over-limit grpcService (configuration) is dropped as invalid, not truncated; WARN is throttled', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reasons: string[] = [];
    const b = new AforoGrpcBilling({ ...config(), serviceName: 's'.repeat(256), flushCount: 5000, onDrop: (_e, r) => reasons.push(r) });
    const wrapped = b.wrapUnary('Get', async () => ({}));
    for (let i = 0; i < 1001; i++) wrapped(makeCall(), makeCallback().cb);
    await new Promise((r) => setTimeout(r, 20));
    await b.shutdown();
    expect(capturedRequests).toHaveLength(0);
    expect(b.droppedCount).toBe(1001);
    expect(new Set(reasons)).toEqual(new Set(['invalid']));
    expect(warn).toHaveBeenCalledTimes(2); // 1st and 1000th
    expect(warn.mock.calls[0][0]).toMatch(/invalid: grpcService is 256 chars, limit 255/);
    warn.mockRestore();
  });

  test('over-limit grpcMethod is truncated to 128 and the event is sent; one WARN across events', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const drops: string[] = [];
    const b = new AforoGrpcBilling({ ...config(), flushCount: 5000, onDrop: (_e, r) => drops.push(r) });
    const shared = 'm'.repeat(300);
    const alpha = b.wrapUnary(shared + 'Alpha', async () => ({}));
    const beta = b.wrapUnary(shared + 'Beta', async () => ({}));
    const astral = b.wrapUnary('m'.repeat(127) + '\u{1F600}' + 'tail', async () => ({}));
    const short = b.wrapUnary('Get', async () => ({}));
    alpha(makeCall(), makeCallback().cb);
    alpha(makeCall(), makeCallback().cb);
    beta(makeCall(), makeCallback().cb);
    astral(makeCall(), makeCallback().cb);
    short(makeCall(), makeCallback().cb);
    await new Promise((r) => setTimeout(r, 20));
    await b.shutdown();

    const events = capturedRequests.flatMap((r) => r.body.events);
    expect(events).toHaveLength(5);
    expect(b.droppedCount).toBe(0);
    expect(drops).toHaveLength(0);
    const [a1, a2, b1, emoji, plain] = events;
    expect(a1.grpcMethod).toBe('m'.repeat(128));
    expect(b1.grpcMethod).toBe(a1.grpcMethod); // same label after the cut
    expect(emoji.grpcMethod).toBe('m'.repeat(127)); // never half a surrogate pair
    expect(plain.grpcMethod).toBe('Get');

    // Keys come from the untruncated method: digest when over-long, never cut.
    const sha = (text: string) => require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
    const stable = (key: string) => key.replace(/:\d+:[a-z0-9]+$/, '');
    for (const ev of events) expect(ev.idempotencyKey.length).toBeLessThanOrEqual(255);
    const head = stable(plain.idempotencyKey).replace(/Get$/, '');
    expect(stable(a1.idempotencyKey)).toBe(head + sha(shared + 'Alpha'));
    expect(stable(a2.idempotencyKey)).toBe(stable(a1.idempotencyKey));
    expect(stable(b1.idempotencyKey)).toBe(head + sha(shared + 'Beta'));
    expect(stable(b1.idempotencyKey)).not.toBe(stable(a1.idempotencyKey));
    expect(a2.idempotencyKey).not.toBe(a1.idempotencyKey);
    expect(plain.idempotencyKey).toMatch(/^grpc:[^:]+:[^:]+:Get:\d+:[a-z0-9]+$/);

    const truncation = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('truncated to'));
    expect(truncation).toHaveLength(1);
    expect(truncation[0]).toMatch(/grpcMethod .* truncated to 128 characters/);
    warn.mockRestore();
  });

  test('over-long customerId is still dropped as invalid even when the method is over-long', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const drops: Array<{ reason: string; customerId: string }> = [];
    const b = new AforoGrpcBilling({
      ...config(), flushCount: 100, customerIdExtractor: () => 'c'.repeat(65),
      onDrop: (e, r) => drops.push({ reason: r, customerId: e[0].customerId }),
    });
    b.wrapUnary('m'.repeat(300), async () => ({}))(makeCall(), makeCallback().cb);
    await new Promise((r) => setTimeout(r, 20));
    await b.shutdown();
    expect(capturedRequests).toHaveLength(0);
    expect(drops).toEqual([{ reason: 'invalid', customerId: 'c'.repeat(65) }]);
    warn.mockRestore();
  });
});

describe('productType', () => {
  test('defaults to GRPC_API; client option is trimmed + uppercased; per-handler option wins', async () => {
    const b = new AforoGrpcBilling({ ...config(), flushCount: 100 });
    b.wrapUnary('A', async () => ({}))(makeCall(), makeCallback().cb);
    await new Promise((r) => setTimeout(r, 20));
    await b.shutdown();
    expect(capturedRequests[0].body.events[0].productType).toBe('GRPC_API');

    capturedRequests = [];
    const c = new AforoGrpcBilling({ ...config(), flushCount: 100, productType: ' agentic_api ' });
    c.wrapUnary('A', async () => ({}))(makeCall(), makeCallback().cb);
    c.wrapUnary('B', async () => ({}), { productType: ' custom_type ' })(makeCall(), makeCallback().cb);
    c.wrapUnary('C', async () => ({}), { productType: '  ' })(makeCall(), makeCallback().cb);
    await new Promise((r) => setTimeout(r, 20));
    await c.shutdown();
    const byMethod = Object.fromEntries(capturedRequests[0].body.events.map((e: any) => [e.grpcMethod, e.productType]));
    expect(byMethod).toEqual({ A: 'AGENTIC_API', B: 'CUSTOM_TYPE', C: 'AGENTIC_API' });
  });

  test('blank grpcService or grpcMethod → event dropped as invalid', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const onError = jest.fn();
    const onDrop = jest.fn();
    const b = new AforoGrpcBilling({ ...config(), serviceName: '  ', flushCount: 100, onError, onDrop });
    b.wrapUnary('M', async () => ({}))(makeCall(), makeCallback().cb);
    const c = new AforoGrpcBilling({ ...config(), flushCount: 100, onError, onDrop });
    c.wrapUnary(' ', async () => ({}))(makeCall(), makeCallback().cb);
    await new Promise((r) => setTimeout(r, 20));
    await b.shutdown();
    await c.shutdown();
    expect(capturedRequests).toHaveLength(0);
    expect(b.droppedCount).toBe(1);
    expect(c.droppedCount).toBe(1);
    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(onDrop.mock.calls.map((call) => call[1])).toEqual(['invalid', 'invalid']);
    expect(onError).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => call[0]).join('\n')).toMatch(/grpcService is required[\s\S]*grpcMethod is required/);
    warn.mockRestore();
  });
});

describe('batch response handling', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  const resp = (status: number, body: any = {}, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300, status, statusText: String(status),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response);
  const meter = async (b: AforoGrpcBilling, calls = 1) => {
    for (let i = 0; i < calls; i++) b.wrapUnary(`M${i}`, async () => ({}))(makeCall(), makeCallback().cb);
    await new Promise((r) => setTimeout(r, 20));
    await b.shutdown();
  };

  test('4xx (not 408/429) is not retried, reports errors[].message, and drops the batch as rejected', async () => {
    const onError = jest.fn();
    const onDrop = jest.fn();
    nextFetchResponse = () => resp(400, { errors: [{ index: 0, message: 'grpcService is required' }] });
    const b = new AforoGrpcBilling({ ...config(), flushCount: 100, onError, onDrop });
    await meter(b);
    expect(capturedRequests).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toMatch(/HTTP 400.*grpcService is required.*not retried/);
    expect(b.droppedCount).toBe(1);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][1]).toBe('rejected');
  });

  test('429 honours Retry-After and 408 is retried; same idempotencyKeys re-sent', async () => {
    const onError = jest.fn();
    const seq = [resp(429, {}, { 'retry-after': '0' }), resp(408, {}, { 'retry-after': '0' }), resp(202, { accepted: 1, failed: 0 })];
    nextFetchResponse = () => seq.shift()!;
    const b = new AforoGrpcBilling({ ...config(), flushCount: 100, onError });
    await meter(b);
    expect(capturedRequests).toHaveLength(3);
    expect(new Set(capturedRequests.map((r) => r.body.events[0].idempotencyKey)).size).toBe(1);
    expect(onError).not.toHaveBeenCalled();
    expect(b.droppedCount).toBe(0);
  });

  test('202 with failed > 0 reports errors[].message and drops only the events named by index', async () => {
    const onError = jest.fn();
    const onDrop = jest.fn();
    nextFetchResponse = () => resp(202, { success: true, data: { accepted: 2, duplicates: 0, failed: 1, errors: [{ index: 1, message: 'bad event' }] } });
    const b = new AforoGrpcBilling({ ...config(), flushCount: 100, onError, onDrop });
    await meter(b, 3);
    expect(capturedRequests).toHaveLength(1);
    expect(onError.mock.calls[0][0].message).toMatch(/rejected 1 event\(s\).*#1: bad event/);
    expect(b.droppedCount).toBe(1);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][1]).toBe('rejected');
    expect(onDrop.mock.calls[0][0].map((e: any) => e.grpcMethod)).toEqual(['M1']);
  });

  test('202 with failed > 0 but no usable index counts the drops without naming events', async () => {
    const onDrop = jest.fn();
    nextFetchResponse = () => resp(202, { accepted: 1, failed: 2 });
    const b = new AforoGrpcBilling({ ...config(), flushCount: 100, onError: () => {}, onDrop });
    await meter(b, 3);
    expect(b.droppedCount).toBe(2);
    expect(onDrop).not.toHaveBeenCalled();
  });

  test('a throwing onError never turns a delivered batch into a retry', async () => {
    nextFetchResponse = () => resp(202, { accepted: 0, failed: 1, errors: [{ index: 0, message: 'bad' }] });
    const b = new AforoGrpcBilling({ ...config(), flushCount: 100, onError: () => { throw new Error('hook bug'); } });
    await meter(b);
    expect(capturedRequests).toHaveLength(1);
  });
});
