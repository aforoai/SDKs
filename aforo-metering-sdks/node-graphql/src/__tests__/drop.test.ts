/**
 * Drop observability + onDrop hook (A+ delivery-guarantee prompt 6 —
 * transport-variant mirror of the core SDK's drop hardening).
 *
 * The buffer is unbounded and drained at flush start, so there is no
 * 'overflow': drops come from retry exhaustion, a rejection by the ingestor,
 * or a failed client-side check ('invalid', covered in billing.test.ts).
 * Retry sleeps are setTimeouts; they run on fake timers and are driven to
 * completion by settleWithFakeTimers, so no real time passes.
 */

import { AforoGraphQlBilling, type GraphQlUsageEvent, type DropReason } from '../index';
import { drainFakeTimers, settleWithFakeTimers } from '../../test-support/timing';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('AforoGraphQlBilling — drop observability + onDrop hook', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let created: AforoGraphQlBilling[];

  beforeEach(() => {
    created = [];
    jest.useFakeTimers();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    // Finish anything a failed test left in flight BEFORE real timers come
    // back, so a half-done retry can never leak into the next test.
    try {
      for (const billing of created) {
        await settleWithFakeTimers(billing.shutdown(), 'afterEach shutdown()');
      }
      await drainFakeTimers('afterEach');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  function newBilling(overrides: Record<string, unknown> = {}) {
    const billing = new AforoGraphQlBilling({
      tenantId: 'tenant-001',
      productId: 'prod-gql-001',
      apiKey: 'sk_gql_abc',
      ingestorUrl: 'https://api.aforo.ai',
      ...overrides,
    });
    created.push(billing);
    return billing;
  }

  function recordOne(billing: AforoGraphQlBilling, customerId = 'cust_1') {
    billing.record({ customerId, query: '{ a }', durationMs: 5, hasErrors: false });
  }

  /** Resolves when shutdown()'s flush — including every retry — has finished. */
  async function shutdownThroughRetries(billing: AforoGraphQlBilling) {
    await settleWithFakeTimers(billing.shutdown(), 'shutdown() flush');
  }

  it('retry exhaustion (network) drops the batch, counts it, warns, and fires onDrop with keys', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const drops: Array<{ events: GraphQlUsageEvent[]; reason: DropReason }> = [];
    const billing = newBilling({
      onDrop: (events: GraphQlUsageEvent[], reason: DropReason) => drops.push({ events, reason }),
    });

    recordOne(billing, 'cust_1');
    recordOne(billing, 'cust_2');
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(2);
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('retry_exhausted');
    expect(drops[0].events).toHaveLength(2);
    // Events keep their keys — dedup-safe replay is possible
    expect(drops[0].events[0].idempotencyKey).toMatch(/^gql:/);
    expect(drops[0].events[0].customerId).toBe('cust_1');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retry_exhausted'));
    expect(mockFetch).toHaveBeenCalledTimes(3); // retry count unchanged
  });

  it('terminal 4xx rejection fires onDrop with reason "rejected"', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });
    const reasons: DropReason[] = [];
    const billing = newBilling({
      onDrop: (_e: GraphQlUsageEvent[], reason: DropReason) => reasons.push(reason),
    });

    recordOne(billing);
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(reasons).toEqual(['rejected']);
    expect(mockFetch).toHaveBeenCalledTimes(1); // a non-retryable 4xx is not re-sent
  });

  it('terminal 5xx exhaustion fires onDrop with reason "retry_exhausted"', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    const reasons: DropReason[] = [];
    const billing = newBilling({
      onDrop: (_e: GraphQlUsageEvent[], reason: DropReason) => reasons.push(reason),
    });

    recordOne(billing);
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(reasons).toEqual(['retry_exhausted']);
  });

  it('default (no onDrop): drop is counted + warned, onError still fires exactly once', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const onError = jest.fn();
    const billing = newBilling({ onError });

    recordOne(billing);
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a throwing onDrop hook never breaks flushing', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const onError = jest.fn();
    const billing = newBilling({
      onError,
      onDrop: () => {
        throw new Error('hook bug');
      },
    });

    recordOne(billing);
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1); // flush completed its normal error path
  });

  it('happy path is unchanged: no drops, no warns, droppedCount stays 0', async () => {
    const onDrop = jest.fn();
    const billing = newBilling({ onDrop });

    recordOne(billing);
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(0);
    expect(onDrop).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
