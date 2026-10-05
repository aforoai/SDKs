/**
 * executionStatus on gRPC usage events: derived from the gRPC status code,
 * overridable per method, trimmed + upper-cased, omitted when unset.
 */

import { AforoGrpcBilling, outcomeFromGrpcStatus } from '../index';

let bodies: any[];

beforeEach(() => {
  bodies = [];
  global.fetch = jest.fn(async (_input: any, init: any = {}) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 202 } as unknown as Response;
  }) as any;
});

const config = () => ({
  tenantId: 'tenant-001',
  productId: 'prod-001',
  apiKey: 'sk_test_abc',
  ingestorUrl: 'https://api.aforo.ai',
  serviceName: 'acme.v1.UserService',
  flushCount: 100,
});

const makeCall = () => ({ metadata: { getMap: () => ({ 'x-customer-id': 'cust_001' }) } } as any);
const settle = () => new Promise((r) => setTimeout(r, 0));
const events = () => bodies.flatMap((b) => b.events);

async function runUnary(
  billing: AforoGrpcBilling,
  handler: () => Promise<unknown>,
  options?: Parameters<AforoGrpcBilling['wrapUnary']>[2],
) {
  billing.wrapUnary('GetUser', handler as any, options as any)(makeCall(), () => {});
  await settle();
}

describe('outcomeFromGrpcStatus', () => {
  test.each([
    [0, 'SUCCESS'],
    [1, 'CANCELLED'],
    [2, 'ERROR'],
    [3, 'VALIDATION_FAILED'],
    [4, 'TIMEOUT'],
    [5, 'ERROR'],
    [6, 'ERROR'],
    [7, 'BLOCKED'],
    [8, 'BLOCKED'],
    [9, 'VALIDATION_FAILED'],
    [10, 'ERROR'],
    [11, 'VALIDATION_FAILED'],
    [12, 'ERROR'],
    [13, 'ERROR'],
    [14, 'ERROR'],
    [15, 'ERROR'],
    [16, 'BLOCKED'],
    [99, 'ERROR'],
  ])('code %i → %s', (code, expected) => {
    expect(outcomeFromGrpcStatus(code)).toBe(expected);
  });
});

describe('executionStatus on the wire', () => {
  test('successful call → SUCCESS, grpcStatusCode label unchanged', async () => {
    const b = new AforoGrpcBilling(config());
    await runUnary(b, async () => ({ ok: true }));
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('SUCCESS');
    expect(events()[0].grpcStatusCode).toBe('OK');
  });

  test('thrown error with a gRPC code is derived from that code', async () => {
    const b = new AforoGrpcBilling(config());
    await runUnary(b, async () => { throw Object.assign(new Error('deadline'), { code: 4 }); });
    await runUnary(b, async () => { throw Object.assign(new Error('bad arg'), { code: 3 }); });
    await runUnary(b, async () => { throw Object.assign(new Error('denied'), { code: 7 }); });
    await runUnary(b, async () => { throw new Error('no code'); });
    await b.shutdown();
    expect(events().map((e) => e.executionStatus)).toEqual(['TIMEOUT', 'VALIDATION_FAILED', 'BLOCKED', 'ERROR']);
    expect(events().map((e) => e.grpcStatusCode)).toEqual(['DEADLINE_EXCEEDED', 'INVALID_ARGUMENT', 'PERMISSION_DENIED', 'UNKNOWN']);
  });

  test('explicit string beats the derived value and is trimmed + upper-cased', async () => {
    const b = new AforoGrpcBilling(config());
    await runUnary(b, async () => ({ ok: true }), { executionStatus: '  partial ' });
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('PARTIAL');
  });

  test('explicit resolver receives the outcome and beats the derived value', async () => {
    const b = new AforoGrpcBilling(config());
    const resolver = jest.fn((o: any) => (o.code === 13 ? 'hitl_required' : undefined));
    await runUnary(b, async () => { throw Object.assign(new Error('x'), { code: 13 }); }, { executionStatus: resolver });
    await runUnary(b, async () => ({ ok: true }), { executionStatus: resolver });
    await b.shutdown();
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver.mock.calls[0][0].error).toBeInstanceOf(Error);
    // First call overridden; second call resolver returned undefined → derived.
    expect(events().map((e) => e.executionStatus)).toEqual(['HITL_REQUIRED', 'SUCCESS']);
  });

  test('blank explicit value falls back to the derived value', async () => {
    const b = new AforoGrpcBilling(config());
    await runUnary(b, async () => { throw Object.assign(new Error('x'), { code: 1 }); }, { executionStatus: '   ' });
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('CANCELLED');
  });

  test('a throwing resolver does not break metering — derived value is used', async () => {
    const b = new AforoGrpcBilling(config());
    await runUnary(b, async () => ({ ok: true }), { executionStatus: () => { throw new Error('bug'); } });
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('SUCCESS');
  });

  test('streaming wrappers carry executionStatus too', async () => {
    const b = new AforoGrpcBilling(config());
    const stream: any = { metadata: { getMap: () => ({ 'x-customer-id': 'c' }) }, write: () => true, end: () => {}, destroy: () => {}, on: () => {} };
    b.wrapServerStream('List', async () => { throw Object.assign(new Error('x'), { code: 16 }); })(stream);
    b.wrapBidiStream('Chat', async () => {}, { executionStatus: 'failed' })(stream);
    b.wrapClientStream('Upload', async () => ({}) as any)(stream, () => {});
    await settle();
    await b.shutdown();
    const byMethod = Object.fromEntries(events().map((e) => [e.grpcMethod, e.executionStatus]));
    expect(byMethod).toEqual({ List: 'BLOCKED', Chat: 'FAILED', Upload: 'SUCCESS' });
  });
});

describe('invalid explicit executionStatus', () => {
  test('unknown or over-long value is reported via onError and the derived status is used', async () => {
    const onError = jest.fn();
    const b = new AforoGrpcBilling({ ...config(), onError });
    await runUnary(b, async () => ({ ok: true }), { executionStatus: 'bogus' });
    await runUnary(b, async () => { throw Object.assign(new Error('deadline'), { code: 4 }); }, { executionStatus: 'X'.repeat(21) });
    await b.shutdown();
    expect(events()).toHaveLength(2);
    expect(events()[0].executionStatus).toBe('SUCCESS');
    expect(events()[1].executionStatus).toBe('TIMEOUT');
    expect(events()[0].customerId).toBe('cust_001');
    expect(events()[0].grpcMethod).toBe('GetUser');
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0][0].message).toContain('unknown executionStatus "BOGUS"');
  });

  test('async resolver: Promise is not sent, rejection is swallowed, onError is told, derived status used', async () => {
    const onError = jest.fn();
    const b = new AforoGrpcBilling({ ...config(), onError });
    await runUnary(b, async () => { throw Object.assign(new Error('denied'), { code: 7 }); }, {
      executionStatus: (async () => { throw new Error('late'); }) as any,
    });
    await b.shutdown();
    expect(events()).toHaveLength(1);
    expect(events()[0].executionStatus).toBe('BLOCKED');
    expect(JSON.stringify(bodies)).not.toContain('[object Promise]');
    expect(onError.mock.calls[0][0].message).toContain('Promise');
  });

  test('a throwing onError does not break the handler callback', async () => {
    const b = new AforoGrpcBilling({ ...config(), onError: () => { throw new Error('hook bug'); } });
    const callback = jest.fn();
    b.wrapUnary('GetUser', (async () => ({ ok: true })) as any, { executionStatus: 'nope' } as any)(makeCall(), callback);
    await settle();
    await b.shutdown();
    expect(callback).toHaveBeenCalledWith(null, { ok: true });
    expect(events()).toHaveLength(1);
  });
});
