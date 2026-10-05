import { AforoClient } from '../src/client';
import { ResolvedEvent, DropReason } from '../src/types';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

process.removeAllListeners('SIGTERM');
process.removeAllListeners('SIGINT');

describe('AforoClient — drop observability + onDrop hook', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function newClient(overrides: Record<string, unknown> = {}) {
    return new AforoClient({
      apiKey: 'test-key',
      baseUrl: 'https://ingest.test.aforo.ai',
      flushCount: 100,
      flushInterval: 60_000,
      maxRetries: 0,
      timeout: 5000,
      ...overrides,
    });
  }

  it('buffer overflow evicts the OLDEST event, counts it, warns, and fires onDrop', async () => {
    const drops: Array<{ events: ResolvedEvent[]; reason: DropReason }> = [];
    const client = newClient({
      maxQueueSize: 2,
      onDrop: (events: ResolvedEvent[], reason: DropReason) => drops.push({ events, reason }),
    });

    await client.track({ customerId: 'cust_1', metricName: 'api_calls', idempotencyKey: 'k1' });
    await client.track({ customerId: 'cust_2', metricName: 'api_calls', idempotencyKey: 'k2' });
    await client.track({ customerId: 'cust_3', metricName: 'api_calls', idempotencyKey: 'k3' });

    expect(client.droppedCount).toBe(1);
    expect(client.bufferedCount).toBe(2);
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('overflow');
    expect(drops[0].events).toHaveLength(1);
    expect(drops[0].events[0].idempotencyKey).toBe('k1'); // oldest evicted
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Buffer overflow'));

    await client.shutdown();
  });

  it('retry exhaustion drops the drained batch, counts it, warns, and fires onDrop', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const drops: Array<{ events: ResolvedEvent[]; reason: DropReason }> = [];
    const client = newClient({
      onDrop: (events: ResolvedEvent[], reason: DropReason) => drops.push({ events, reason }),
    });

    await client.track({ customerId: 'cust_1', metricName: 'api_calls', idempotencyKey: 'k1' });
    await client.track({ customerId: 'cust_2', metricName: 'api_calls', idempotencyKey: 'k2' });
    const result = await client.flush();

    expect(result.failed).toBe(2);
    expect(client.droppedCount).toBe(2);
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('retry_exhausted');
    expect(drops[0].events.map((e) => e.idempotencyKey)).toEqual(['k1', 'k2']);
    // Events keep their keys — dedup-safe replay via track() is possible
    expect(drops[0].events[0].customerId).toBe('cust_1');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retry_exhausted'));

    await client.shutdown();
  });

  it('non-retryable 4xx rejection fires onDrop with reason "rejected"', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, headers: new Map() });
    const reasons: DropReason[] = [];
    const client = newClient({
      onDrop: (_events: ResolvedEvent[], reason: DropReason) => reasons.push(reason),
    });

    await client.track({ customerId: 'cust_1', metricName: 'api_calls' });
    await client.flush();

    expect(client.droppedCount).toBe(1);
    expect(reasons).toEqual(['rejected']);

    await client.shutdown();
  });

  it('default (no onDrop): drops are counted + warned but flush result is unchanged', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const client = newClient();

    await client.track({ customerId: 'cust_1', metricName: 'api_calls' });
    const result = await client.flush();

    // Same result shape/values as before the hardening
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(client.droppedCount).toBe(1);
    expect(warnSpy).toHaveBeenCalled();

    await client.shutdown();
  });

  it('a throwing onDrop hook never breaks flushing', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const client = newClient({
      onDrop: () => {
        throw new Error('hook bug');
      },
    });

    await client.track({ customerId: 'cust_1', metricName: 'api_calls' });
    const result = await client.flush();

    expect(result.failed).toBe(1);
    expect(client.droppedCount).toBe(1);

    await client.shutdown();
  });

  it('shutdown deregisters SIGTERM/SIGINT handlers (no listener leak)', async () => {
    const before = process.listenerCount('SIGTERM');
    const client = newClient();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    await client.shutdown();

    expect(process.listenerCount('SIGTERM')).toBe(before);
    expect(process.listenerCount('SIGINT')).toBeLessThanOrEqual(before + 1);
  });

  it('a 2xx with per-event errors[] drops only the events the server named (reason rejected)', async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 202, headers: new Map(),
      json: async () => ({ success: true, data: { accepted: 2, duplicates: 0, failed: 1, errors: [{ index: 1, message: 'Metric not found: nope' }] } }),
    });
    const drops: Array<{ events: ResolvedEvent[]; reason: DropReason }> = [];
    const client = newClient({
      onDrop: (events: ResolvedEvent[], reason: DropReason) => drops.push({ events, reason }),
    });

    await client.track({ customerId: 'cust_1', metricName: 'api_calls', idempotencyKey: 'k1' });
    await client.track({ customerId: 'cust_2', metricName: 'nope', idempotencyKey: 'k2' });
    await client.track({ customerId: 'cust_3', metricName: 'api_calls', idempotencyKey: 'k3' });
    const result = await client.flush();

    expect(result).toEqual({ sent: 2, failed: 1 });
    expect(client.droppedCount).toBe(1);
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('rejected');
    expect(drops[0].events.map((e) => e.idempotencyKey)).toEqual(['k2']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Metric not found: nope'));

    await client.shutdown();
  });

  it('a 2xx reporting failures without indexes counts them but does not guess which events', async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 202, headers: new Map(),
      json: async () => ({ accepted: 1, duplicates: 0, failed: 1, errors: [] }),
    });
    const onDrop = jest.fn();
    const client = newClient({ onDrop });

    await client.track({ customerId: 'cust_1', metricName: 'api_calls' });
    await client.track({ customerId: 'cust_2', metricName: 'api_calls' });
    const result = await client.flush();

    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(client.droppedCount).toBe(1);
    expect(onDrop).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rejected 1 of 2'));

    await client.shutdown();
  });

  it('a non-retryable 4xx surfaces the server message in the WARN', async () => {
    mockFetch.mockResolvedValue({
      ok: false, status: 400, headers: new Map(),
      json: async () => ({ errors: [{ index: 0, message: 'productType is required' }] }),
    });
    const client = newClient();
    await client.track({ customerId: 'cust_1', metricName: 'api_calls' });
    await client.flush();

    expect(client.droppedCount).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 400: productType is required'));

    await client.shutdown();
  });

  it('happy path is unchanged: no drops, no warns, droppedCount stays 0', async () => {
    const onDrop = jest.fn();
    const client = newClient({ onDrop });

    await client.track({ customerId: 'cust_1', metricName: 'api_calls' });
    const result = await client.flush();

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(client.droppedCount).toBe(0);
    expect(onDrop).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    await client.shutdown();
  });
});
