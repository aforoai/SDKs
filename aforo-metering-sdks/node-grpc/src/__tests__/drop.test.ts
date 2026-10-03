/**
 * Drop observability + onDrop hook (A+ delivery-guarantee prompt 6 —
 * transport-variant mirror of the core SDK's drop hardening).
 *
 * The buffer is unbounded and drained at flush start, so there is no
 * 'overflow': drops come from retry exhaustion, a rejection by the ingestor,
 * or a failed client-side check ('invalid', covered in billing.test.ts).
 * Retry sleeps are setTimeouts; they run on fake timers and are driven to
 * completion by settleWithFakeTimers, so no real time passes.
 *
 * Also locks the fix for the double-onError bug: the thrown-error terminal
 * path used to fire onError, fall out of the loop, and fire onError AGAIN
 * with the generic "flush failed" error for the same batch.
 */

import { AforoGrpcBilling, type GrpcUsageEvent, type DropReason } from '../index';
import { drainFakeTimers, settleWithFakeTimers } from '../../test-support/timing';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('AforoGrpcBilling — drop observability + onDrop hook', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let created: AforoGrpcBilling[];

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
    const billing = new AforoGrpcBilling({
      tenantId: 'tenant-001',
      productId: 'prod-grpc-001',
      apiKey: 'sk_test_abc',
      ingestorUrl: 'https://api.aforo.ai',
      serviceName: 'acme.v1.UserService',
      ...overrides,
    });
    created.push(billing);
    return billing;
  }

  function makeCall(customerId = 'cust_1') {
    return {
      metadata: { getMap: () => ({ 'x-customer-id': customerId }) },
    } as any;
  }

  /** Record one event through the public wrapUnary surface. */
  async function recordOne(billing: AforoGrpcBilling, customerId = 'cust_1') {
    const wrapped = billing.wrapUnary('GetUser', async () => ({ ok: true }));
    // The wrapper buffers the event and THEN invokes the gRPC callback, so the
    // callback firing is the exact "event recorded" signal.
    await new Promise<void>((resolve) => wrapped(makeCall(customerId), () => resolve()));
  }

  /** Resolves when shutdown()'s flush — including every retry — has finished. */
  async function shutdownThroughRetries(billing: AforoGrpcBilling) {
    await settleWithFakeTimers(billing.shutdown(), 'shutdown() flush');
  }

  it('retry exhaustion (network) drops the batch, counts it, warns, and fires onDrop with keys', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const drops: Array<{ events: GrpcUsageEvent[]; reason: DropReason }> = [];
    const billing = newBilling({
      onDrop: (events: GrpcUsageEvent[], reason: DropReason) => drops.push({ events, reason }),
    });

    await recordOne(billing, 'cust_1');
    await recordOne(billing, 'cust_2');
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(2);
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('retry_exhausted');
    expect(drops[0].events).toHaveLength(2);
    // Events keep their keys — dedup-safe replay is possible
    expect(drops[0].events[0].idempotencyKey).toBeTruthy();
    expect(drops[0].events[0].customerId).toBe('cust_1');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retry_exhausted'));
    expect(mockFetch).toHaveBeenCalledTimes(3); // retry count unchanged
  });

  it('terminal 4xx rejection fires onDrop with reason "rejected"', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });
    const reasons: DropReason[] = [];
    const billing = newBilling({
      onDrop: (_e: GrpcUsageEvent[], reason: DropReason) => reasons.push(reason),
    });

    await recordOne(billing);
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(reasons).toEqual(['rejected']);
    expect(mockFetch).toHaveBeenCalledTimes(1); // a non-retryable 4xx is not re-sent
  });

  it('terminal 5xx exhaustion fires onDrop with reason "retry_exhausted"', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    const reasons: DropReason[] = [];
    const billing = newBilling({
      onDrop: (_e: GrpcUsageEvent[], reason: DropReason) => reasons.push(reason),
    });

    await recordOne(billing);
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(reasons).toEqual(['retry_exhausted']);
  });

  it('network exhaustion fires onError exactly ONCE (double-onError bug fixed)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const onError = jest.fn();
    const billing = newBilling({ onError });

    await recordOne(billing);
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

    await recordOne(billing);
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('happy path is unchanged: no drops, no warns, droppedCount stays 0', async () => {
    const onDrop = jest.fn();
    const billing = newBilling({ onDrop });

    await recordOne(billing);
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(0);
    expect(onDrop).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
