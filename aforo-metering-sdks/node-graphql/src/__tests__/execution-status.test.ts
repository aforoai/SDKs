/**
 * executionStatus on GraphQL usage events: derived from the GraphQL response
 * (or the HTTP status when no body is seen), overridable, trimmed +
 * upper-cased, omitted when unset.
 */

import {
  AforoGraphQlBilling,
  aforoApolloPlugin,
  outcomeFromGraphQlResponse,
  outcomeFromHttpStatus,
} from '../index';

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
  productId: 'prod-gql-001',
  apiKey: 'sk_test_abc',
  ingestorUrl: 'https://api.aforo.ai',
  flushCount: 100,
});

const events = () => bodies.flatMap((b) => b.events);
const base = { customerId: 'cust_001', query: '{ me { id } }', durationMs: 5, hasErrors: false };

describe('outcomeFromGraphQlResponse', () => {
  test('no errors → SUCCESS', () => {
    expect(outcomeFromGraphQlResponse({ data: { a: 1 } })).toBe('SUCCESS');
    expect(outcomeFromGraphQlResponse({ data: { a: 1 }, errors: [] })).toBe('SUCCESS');
    expect(outcomeFromGraphQlResponse({ data: { a: 1 }, errors: null })).toBe('SUCCESS');
  });
  test('errors with data → PARTIAL', () => {
    expect(outcomeFromGraphQlResponse({ data: { a: null }, errors: [{ message: 'x' }] })).toBe('PARTIAL');
  });
  test('errors with data present and null → ERROR', () => {
    expect(outcomeFromGraphQlResponse({ data: null, errors: [{ message: 'x' }] })).toBe('ERROR');
  });
  test('errors with data absent (failed before execution) → VALIDATION_FAILED', () => {
    expect(outcomeFromGraphQlResponse({ errors: [{ message: 'Cannot query field "x"' }] })).toBe('VALIDATION_FAILED');
  });
  test('a non-empty, non-array errors value counts as errors', () => {
    expect(outcomeFromGraphQlResponse({ data: null, errors: { message: 'x' } } as any)).toBe('ERROR');
    expect(outcomeFromGraphQlResponse({ data: { a: 1 }, errors: 'boom' } as any)).toBe('PARTIAL');
    expect(outcomeFromGraphQlResponse({ errors: { message: 'x' } } as any)).toBe('VALIDATION_FAILED');
    expect(outcomeFromGraphQlResponse({ data: { a: 1 }, errors: {} } as any)).toBe('PARTIAL');
  });
  test('neither data nor errors → undefined', () => {
    expect(outcomeFromGraphQlResponse({})).toBeUndefined();
  });
});

describe('outcomeFromHttpStatus', () => {
  test.each([
    [200, 'SUCCESS'], [204, 'SUCCESS'], [301, 'SUCCESS'],
    [408, 'TIMEOUT'], [504, 'TIMEOUT'],
    [499, 'CANCELLED'],
    [400, 'VALIDATION_FAILED'], [422, 'VALIDATION_FAILED'],
    [401, 'BLOCKED'], [403, 'BLOCKED'], [429, 'BLOCKED'],
    [404, 'ERROR'], [500, 'ERROR'], [503, 'ERROR'],
  ])('%i → %s', (status, expected) => {
    expect(outcomeFromHttpStatus(status)).toBe(expected);
  });
  test('anything else → undefined', () => {
    expect(outcomeFromHttpStatus(undefined)).toBeUndefined();
    expect(outcomeFromHttpStatus(101)).toBeUndefined();
    expect(outcomeFromHttpStatus(600)).toBeUndefined();
    expect(outcomeFromHttpStatus(0)).toBeUndefined();
  });
});

describe('record() wire body', () => {
  test('explicit value is trimmed + upper-cased and beats the derived value', async () => {
    const b = new AforoGraphQlBilling(config());
    b.record({ ...base, executionStatus: '  hitl_required ', response: { data: { a: 1 } } });
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('HITL_REQUIRED');
  });

  test('derived from response when no explicit value', async () => {
    const b = new AforoGraphQlBilling(config());
    b.record({ ...base, response: { data: { a: 1 } } });
    b.record({ ...base, response: { data: { a: null }, errors: [{ message: 'x' }] } });
    b.record({ ...base, response: { data: null, errors: [{ message: 'x' }] } });
    await b.shutdown();
    expect(events().map((e) => e.executionStatus)).toEqual(['SUCCESS', 'PARTIAL', 'ERROR']);
  });

  test('response beats httpStatus; httpStatus used when the response derives nothing', async () => {
    const b = new AforoGraphQlBilling(config());
    b.record({ ...base, response: { data: { a: 1 } }, httpStatus: 500 });
    b.record({ ...base, httpStatus: 429 });
    b.record({ ...base, response: {}, httpStatus: 503 });
    b.record({ ...base, response: { errors: [{ message: 'parse' }] }, httpStatus: 200 });
    await b.shutdown();
    expect(events().map((e) => e.executionStatus)).toEqual(['SUCCESS', 'BLOCKED', 'ERROR', 'VALIDATION_FAILED']);
  });

  test('blank explicit value falls back to the derived value', async () => {
    const b = new AforoGraphQlBilling(config());
    b.record({ ...base, executionStatus: '   ', httpStatus: 504 });
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('TIMEOUT');
  });

  test('nothing to derive from → key omitted', async () => {
    const b = new AforoGraphQlBilling(config());
    b.record({ ...base });
    b.record({ ...base, executionStatus: '  ' });
    await b.shutdown();
    expect(events()).toHaveLength(2);
    for (const ev of events()) expect('executionStatus' in ev).toBe(false);
  });
});

function fakeRes(statusCode: number) {
  const res: any = { statusCode, write: jest.fn(() => true), end: jest.fn() };
  return res;
}

describe('middleware()', () => {
  test('derives from the JSON GraphQL body written by the server', async () => {
    const b = new AforoGraphQlBilling(config());
    const mw = b.middleware();
    const req: any = { body: { query: '{ me { id } }' }, headers: { 'x-customer-id': 'cust_001' } };
    const res = fakeRes(200);
    mw(req, res, () => {});
    res.write('{"data":{"me":null},');
    res.end('"errors":[{"message":"boom"}]}');
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('PARTIAL');
  });

  test('errors-only body (no data key) → VALIDATION_FAILED', async () => {
    const b = new AforoGraphQlBilling(config());
    const mw = b.middleware();
    const req: any = { body: { query: '{ nope }' }, headers: { 'x-customer-id': 'cust_001' } };
    const res = fakeRes(200);
    mw(req, res, () => {});
    res.end(JSON.stringify({ errors: [{ message: 'Cannot query field "nope"' }] }));
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('VALIDATION_FAILED');
  });

  test('JSON body with neither data nor errors falls back to HTTP status', async () => {
    const b = new AforoGraphQlBilling(config());
    const mw = b.middleware();
    const req: any = { body: { query: '{ me { id } }' }, headers: { 'x-customer-id': 'cust_001' } };
    const res = fakeRes(500);
    mw(req, res, () => {});
    res.end(JSON.stringify({ message: 'oops' }));
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('ERROR');
  });

  test('falls back to HTTP status when the body is not a GraphQL result', async () => {
    const b = new AforoGraphQlBilling(config());
    const mw = b.middleware();
    const req: any = { body: { query: '{ me { id } }' }, headers: { 'x-customer-id': 'cust_001' } };
    const res = fakeRes(403);
    mw(req, res, () => {});
    res.end('Forbidden');
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('BLOCKED');
  });

  test('options.executionStatus overrides the derived value', async () => {
    const b = new AforoGraphQlBilling(config());
    const mw = b.middleware({ executionStatus: (req) => req.aforoStatus });
    const req: any = { body: { query: '{ me { id } }' }, headers: { 'x-customer-id': 'cust_001' }, aforoStatus: 'pending' };
    const res = fakeRes(200);
    mw(req, res, () => {});
    res.end(JSON.stringify({ data: { me: { id: 1 } } }));
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('PENDING');
  });
});

describe('invalid explicit executionStatus', () => {
  test('record(): unknown or over-long value is reported via onError; derived status used, else omitted', async () => {
    const onError = jest.fn();
    const b = new AforoGraphQlBilling({ ...config(), onError });
    b.record({ ...base, executionStatus: 'bogus', response: { data: null, errors: [{ message: 'x' }] } });
    b.record({ ...base, executionStatus: 'X'.repeat(21) });
    b.record({ ...base, executionStatus: 'nope', httpStatus: 429 });
    await b.shutdown();
    expect(events()).toHaveLength(3);
    // Response available → the derived status replaces the invalid one.
    expect(events()[0].executionStatus).toBe('ERROR');
    // Nothing to derive from → key omitted, event still sent.
    expect('executionStatus' in events()[1]).toBe(false);
    // Only an HTTP status → derived from it.
    expect(events()[2].executionStatus).toBe('BLOCKED');
    expect(events()[0].gqlOperationType).toBe('QUERY');
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[0][0].message).toContain('unknown executionStatus "BOGUS"');
  });

  test('middleware(): async resolver Promise is not sent, rejection swallowed, onError told, derived status used', async () => {
    const onError = jest.fn();
    const b = new AforoGraphQlBilling({ ...config(), onError });
    const mw = b.middleware({ executionStatus: (async () => { throw new Error('late'); }) as any });
    const req: any = { body: { query: '{ me { id } }' }, headers: { 'x-customer-id': 'cust_001' } };
    const res = fakeRes(200);
    mw(req, res, () => {});
    res.end(JSON.stringify({ data: { me: { id: 1 } } }));
    await b.shutdown();
    expect(events()).toHaveLength(1);
    expect(events()[0].executionStatus).toBe('SUCCESS');
    expect(JSON.stringify(bodies)).not.toContain('[object Promise]');
    expect(onError.mock.calls[0][0].message).toContain('Promise');
  });
});

describe('gqlHasErrors agrees with the derived status', () => {
  test('record(): a known GraphQL response sets the flag with the same errors rule', async () => {
    const b = new AforoGraphQlBilling(config());
    b.record({ ...base, hasErrors: false, response: { data: null, errors: { message: 'x' } } as any });
    b.record({ ...base, hasErrors: true, response: { data: { me: { id: 1 } }, errors: [] } });
    b.record({ ...base, hasErrors: true, httpStatus: 500 });
    await b.shutdown();
    const [objErrors, emptyErrors, noResponse] = events();
    expect(objErrors.executionStatus).toBe('ERROR');
    expect(objErrors.gqlHasErrors).toBe(true);
    expect(emptyErrors.executionStatus).toBe('SUCCESS');
    expect(emptyErrors.gqlHasErrors).toBe(false);
    // No response → the caller's flag is kept.
    expect(noResponse.gqlHasErrors).toBe(true);
  });

  test('middleware(): a 200 body with non-array errors sets the flag', async () => {
    const b = new AforoGraphQlBilling(config());
    const mw = b.middleware();
    const req: any = { body: { query: '{ me { id } }' }, headers: { 'x-customer-id': 'cust_001' } };
    const res = fakeRes(200);
    mw(req, res, () => {});
    res.end(JSON.stringify({ data: null, errors: { message: 'x' } }));
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('ERROR');
    expect(events()[0].gqlHasErrors).toBe(true);
  });

  test('Apollo: non-array errors set the flag', async () => {
    const b = new AforoGraphQlBilling(config());
    const hooks = await aforoApolloPlugin(b).requestDidStart();
    await hooks.willSendResponse({
      request: { query: '{ me { id } }' },
      contextValue: { customerId: 'cust_001' },
      response: { body: { kind: 'single', singleResult: { data: null, errors: { message: 'x' } } } },
    });
    await b.shutdown();
    expect(events()[0].executionStatus).toBe('ERROR');
    expect(events()[0].gqlHasErrors).toBe(true);
  });
});

describe('aforoApolloPlugin()', () => {
  async function run(rc: any, options?: Parameters<typeof aforoApolloPlugin>[1]) {
    const b = new AforoGraphQlBilling(config());
    const hooks = await aforoApolloPlugin(b, options).requestDidStart();
    await hooks.willSendResponse({
      request: { query: '{ me { id } }' },
      contextValue: { customerId: 'cust_001' },
      ...rc,
    });
    await b.shutdown();
    return events()[0];
  }

  test('derives from singleResult', async () => {
    expect((await run({ response: { body: { kind: 'single', singleResult: { data: { me: { id: 1 } } } } } })).executionStatus).toBe('SUCCESS');
  });

  test('errors with null data → ERROR; errors with data → PARTIAL', async () => {
    expect((await run({ response: { body: { kind: 'single', singleResult: { data: null, errors: [{ message: 'x' }] } } } })).executionStatus).toBe('ERROR');
    bodies = [];
    expect((await run({ response: { body: { kind: 'single', singleResult: { data: { me: null }, errors: [{ message: 'x' }] } } } })).executionStatus).toBe('PARTIAL');
  });

  test('errors without a data key (validation failure) → VALIDATION_FAILED', async () => {
    expect((await run({ response: { body: { kind: 'single', singleResult: { errors: [{ message: 'x' }] } } } })).executionStatus).toBe('VALIDATION_FAILED');
  });

  test('explicit resolver wins', async () => {
    const ev = await run(
      { response: { body: { kind: 'single', singleResult: { data: { me: { id: 1 } } } } } },
      { executionStatus: () => 'Cancelled' },
    );
    expect(ev.executionStatus).toBe('CANCELLED');
  });
});
