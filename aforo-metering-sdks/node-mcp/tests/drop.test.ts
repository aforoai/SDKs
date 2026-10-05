import { AforoMcpBilling, UsageEvent, McpDropReason } from '../src/index';
import { drainFakeTimers, settleWithFakeTimers } from './support/timing';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// The retry backoff (1s + 2s between the 3 attempts) is a setTimeout. It runs
// on fake timers and settleWithFakeTimers drives it, so a retry-exhaustion
// test takes no real time instead of 3 real seconds of its 5-second budget.

describe('AforoMcpBilling — drop observability + onDrop hook', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let created: AforoMcpBilling[];

  beforeEach(() => {
    created = [];
    jest.useFakeTimers();
    mockFetch.mockReset();
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

  /** Resolves when flush() — including every retry — has finished. */
  function flushThroughRetries(billing: AforoMcpBilling): Promise<void> {
    return settleWithFakeTimers(billing.flush(), 'flush()');
  }

  function newBilling(overrides: Record<string, unknown> = {}) {
    const billing = new AforoMcpBilling({
      tenantId: 'tenant_test',
      productId: 'prod_test',
      apiKey: 'test-key',
      ingestorUrl: 'https://ingest.test.aforo.ai',
      flushIntervalMs: 3_600_000, // long — control flushing manually
      flushCount: 100,
      heartbeatEnabled: false,
      ...overrides,
    });
    created.push(billing);
    return billing;
  }

  it('retry exhaustion (network error) drops the batch, counts it, warns, and fires onDrop', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const drops: Array<{ events: UsageEvent[]; reason: McpDropReason }> = [];
    const billing = newBilling({
      onDrop: (events: UsageEvent[], reason: McpDropReason) => drops.push({ events, reason }),
    });

    billing.recordToolInvocation('search', 'agent_1', 'sess_1', 'SUCCESS', 12);
    await flushThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('retry_exhausted');
    expect(drops[0].events[0].toolName).toBe('search');
    expect(drops[0].events[0].idempotencyKey).toBeTruthy(); // key preserved for replay
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retry_exhausted'));
    expect(mockFetch).toHaveBeenCalledTimes(3); // retry count unchanged

    await settleWithFakeTimers(billing.shutdown(), 'shutdown()');
  });

  it('retry exhaustion on 5xx (previously fully silent) now drops observably', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    const reasons: McpDropReason[] = [];
    const billing = newBilling({
      onDrop: (_e: UsageEvent[], reason: McpDropReason) => reasons.push(reason),
    });

    billing.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 5);
    await flushThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(reasons).toEqual(['retry_exhausted']);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    await settleWithFakeTimers(billing.shutdown(), 'shutdown()');
  });

  it('non-retryable 4xx fires onDrop with reason "rejected" and does not retry', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });
    const reasons: McpDropReason[] = [];
    const billing = newBilling({
      onDrop: (_e: UsageEvent[], reason: McpDropReason) => reasons.push(reason),
    });

    billing.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 5);
    await flushThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(reasons).toEqual(['rejected']);
    expect(mockFetch).toHaveBeenCalledTimes(1); // 4xx: no retry, unchanged

    await settleWithFakeTimers(billing.shutdown(), 'shutdown()');
  });

  it('default (no onDrop): drops are counted + warned; onError behavior unchanged', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const errors: Error[] = [];
    const billing = newBilling({ onError: (e: Error) => errors.push(e) });

    billing.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 5);
    await flushThroughRetries(billing);

    expect(billing.droppedCount).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    expect(errors).toHaveLength(1); // existing onError still fires exactly once

    await settleWithFakeTimers(billing.shutdown(), 'shutdown()');
  });

  it('a throwing onDrop hook never breaks flushing', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const billing = newBilling({
      onDrop: () => {
        throw new Error('hook bug');
      },
    });

    billing.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 5);
    await expect(flushThroughRetries(billing)).resolves.toBeUndefined();
    expect(billing.droppedCount).toBe(1);

    await settleWithFakeTimers(billing.shutdown(), 'shutdown()');
  });

  it('happy path is unchanged: no drops, no warns', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });
    const onDrop = jest.fn();
    const billing = newBilling({ onDrop });

    billing.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 5);
    await flushThroughRetries(billing);

    expect(billing.droppedCount).toBe(0);
    expect(onDrop).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    await settleWithFakeTimers(billing.shutdown(), 'shutdown()');
  });
});
