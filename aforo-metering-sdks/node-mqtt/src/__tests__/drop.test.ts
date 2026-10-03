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

import { AforoMqttBilling, type MqttUsageEvent, type DropReason } from '../index';
import { drainFakeTimers, settleWithFakeTimers } from '../../test-support/timing';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('AforoMqttBilling — drop observability + onDrop hook', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let created: AforoMqttBilling[];

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
    const billing = new AforoMqttBilling({
      tenantId: 'tenant-001',
      productId: 'prod-mqtt-001',
      apiKey: 'sk_test_abc',
      ingestorUrl: 'https://api.aforo.ai',
      ...overrides,
    });
    created.push(billing);
    return billing;
  }

  /** Record one PUBLISH event through the public wrapAedesBroker surface. */
  async function recordOne(billing: AforoMqttBilling, customerId = 'cust_1') {
    const handlers: Record<string, Function> = {};
    const broker = { on: (evt: string, fn: Function) => { handlers[evt] = fn; } } as any;
    billing.wrapAedesBroker(broker, { resolveCustomerId: () => customerId });
    await handlers['publish'](
      { topic: 'sensors/temp', payload: Buffer.from('22.5'), qos: 1, retain: false },
      { id: 'client-1' },
    );
  }

  /** Resolves when shutdown()'s flush — including every retry — has finished. */
  async function shutdownThroughRetries(billing: AforoMqttBilling) {
    await settleWithFakeTimers(billing.shutdown(), 'shutdown() flush');
  }

  it('retry exhaustion (network) drops the batch, counts it, warns, and fires onDrop with keys', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const drops: Array<{ events: MqttUsageEvent[]; reason: DropReason }> = [];
    const billing = newBilling({
      onDrop: (events: MqttUsageEvent[], reason: DropReason) => drops.push({ events, reason }),
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
      onDrop: (_e: MqttUsageEvent[], reason: DropReason) => reasons.push(reason),
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
      onDrop: (_e: MqttUsageEvent[], reason: DropReason) => reasons.push(reason),
    });

    await recordOne(billing);
    await shutdownThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(reasons).toEqual(['retry_exhausted']);
  });

  it('default (no onDrop): drop is counted + warned, onError still fires exactly once', async () => {
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
