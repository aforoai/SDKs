import { AforoClient } from '../src/client';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Suppress unhandled rejections from fire-and-forget flushes
process.removeAllListeners('SIGTERM');
process.removeAllListeners('SIGINT');

describe('AforoClient', () => {
  let client: AforoClient;

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });

    client = new AforoClient({
      apiKey: 'test-key',
      baseUrl: 'https://ingest.test.aforo.ai',
      flushCount: 5,
      flushInterval: 60_000, // Long interval so we control flushing manually
      maxRetries: 0,
      timeout: 5000,
    });
  });

  afterEach(async () => {
    await client.shutdown();
  });

  it('sends each session heartbeat in its own request, never in the usage batch', async () => {
    client.startSession('sess_1', 'mcp_server');
    await client.track({ customerId: 'cust_1', metricName: 'api_calls', quantity: 1 });
    await client.endSession();

    const bodies = mockFetch.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    for (const [url] of mockFetch.mock.calls) {
      expect(url).toBe('https://ingest.test.aforo.ai/v1/ingest/batch');
    }

    const usage = bodies.filter((b) => b.events.some((e: any) => e.metricName === 'api_calls'));
    expect(usage).toHaveLength(1);
    expect(usage[0].events).toHaveLength(1);
    expect(usage[0].events[0].productType).toBe('API');

    const hbs = bodies.filter((b) => b.events[0].metricName === 'system.session.heartbeat');
    expect(hbs).toHaveLength(2);
    for (const b of hbs) {
      expect(b.events).toHaveLength(1);
      const hb = b.events[0];
      expect(hb.quantity).toBe(1);
      expect(hb.customerId).toBe('system');
      expect(hb.sessionId).toBe('sess_1');
      expect(hb.productType).toBe('MCP_SERVER');
      expect(hb.metadata.sessionId).toBe('sess_1');
      expect(hb.metadata.productType).toBe('MCP_SERVER');
      expect(new Date(hb.occurredAt).toISOString()).toBe(hb.occurredAt);
    }
    expect(hbs.map((b) => b.events[0].sessionBoundary).sort()).toEqual(['HEARTBEAT', 'SESSION_END']);
    expect(hbs[0].events[0].idempotencyKey).not.toBe(hbs[1].events[0].idempotencyKey);
  });

  it('emits periodic heartbeats every 30s and stops on endSession/shutdown', async () => {
    jest.useFakeTimers();
    try {
      const c = new AforoClient({ apiKey: 'k', baseUrl: 'https://x.test', flushInterval: 600_000, maxRetries: 0 });
      c.startSession('sess_p');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(30_000);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const periodic = JSON.parse(mockFetch.mock.calls[1][1].body).events[0];
      expect(periodic.sessionBoundary).toBe('HEARTBEAT');
      expect(periodic.productType).toBe('AI_AGENT');

      await c.shutdown();
      const calls = mockFetch.mock.calls.length;
      jest.advanceTimersByTime(120_000);
      expect(mockFetch).toHaveBeenCalledTimes(calls);
    } finally {
      jest.useRealTimers();
    }
  });

  it('swallows heartbeat failures without affecting usage delivery', async () => {
    mockFetch.mockReset();
    mockFetch
      .mockRejectedValueOnce(new Error('network down')) // first heartbeat
      .mockResolvedValue({ ok: true, status: 202, headers: new Map() });
    client.startSession('sess_2');
    await client.track({ customerId: 'cust_1', metricName: 'api_calls' });
    const result = await client.flush();
    expect(result).toEqual({ sent: 1, failed: 0 });
  });

  it('stamps productType: client default API, client option, per-event override', async () => {
    await client.track({ customerId: 'c', metricName: 'api_calls' });
    await client.track({ customerId: 'c', metricName: 'api_calls', productType: ' graphql_api ' });
    await client.track({ customerId: 'c', metricName: 'api_calls', productType: 'SOMETHING_NEW' });
    await client.flush();
    const events = JSON.parse(mockFetch.mock.calls[0][1].body).events;
    expect(events.map((e: any) => e.productType)).toEqual(['API', 'GRAPHQL_API', 'SOMETHING_NEW']);

    const c2 = new AforoClient({ apiKey: 'k', baseUrl: 'https://x.test', productType: 'agentic_api', flushInterval: 60_000 });
    await c2.track({ customerId: 'c', metricName: 'api_calls' });
    await c2.flush();
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).events[0].productType).toBe('AGENTIC_API');
    await c2.shutdown();
  });

  it('drops blank customerId / metricName and non-positive quantity as invalid, without throwing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const drops: Array<{ events: any[]; reason: string }> = [];
    const c = new AforoClient({
      apiKey: 'k', baseUrl: 'https://x.test', flushInterval: 600_000,
      onDrop: (events, reason) => drops.push({ events, reason }),
    });
    try {
      await expect(c.track({ customerId: ' ', metricName: 'api_calls' })).resolves.toBeUndefined();
      await expect(c.track({ customerId: 'c', metricName: '' })).resolves.toBeUndefined();
      await expect(c.track({ customerId: 'c', metricName: 'm', quantity: 0 })).resolves.toBeUndefined();
      await expect(c.track({ customerId: 'c', metricName: 'm', quantity: -1, idempotencyKey: 'neg-1' })).resolves.toBeUndefined();
      await expect(c.track(undefined as any)).resolves.toBeUndefined();

      expect(c.bufferedCount).toBe(0);
      expect(c.droppedCount).toBe(5);
      expect(drops.map((d) => d.reason)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
      expect(drops[3].events[0].idempotencyKey).toBe('neg-1');
      expect(drops[0].events[0].idempotencyKey).toBeTruthy();
      // Throttled: the first invalid event is logged, the next four are not.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('customerId is required'));

      await c.flush();
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await c.shutdown();
    }
  });

  it('caps flushCount at the 1000-event batch limit', async () => {
    const c = new AforoClient({ apiKey: 'k', baseUrl: 'https://x.test', flushCount: 5000, flushInterval: 600_000 });
    for (let i = 0; i < 2500; i++) {
      await c.track({ customerId: 'c', metricName: 'api_calls' });
    }
    await c.flush();
    const sizes = mockFetch.mock.calls.map((call) => JSON.parse(call[1].body).events.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(2500);
    await c.shutdown();
  });

  it('should require apiKey', () => {
    expect(() => new AforoClient({ apiKey: '' })).toThrow('apiKey is required');
  });

  it('should track events and buffer them', async () => {
    await client.track({
      customerId: 'cust_1',
      metricName: 'api_calls',
      quantity: 1,
    });

    expect(client.bufferedCount).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled(); // Below flushCount threshold
  });

  it('should auto-flush when buffer reaches flushCount', async () => {
    for (let i = 0; i < 5; i++) {
      await client.track({
        customerId: 'cust_1',
        metricName: 'api_calls',
        quantity: 1,
      });
    }

    // Give the fire-and-forget flush a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events).toHaveLength(5);
  });

  it('should flush on explicit flush()', async () => {
    await client.track({ customerId: 'cust_1', metricName: 'api_calls' });
    await client.track({ customerId: 'cust_2', metricName: 'ai_tokens', quantity: 500 });

    const result = await client.flush();

    expect(result.sent).toBe(2);
    expect(client.bufferedCount).toBe(0);
  });

  it('should generate idempotency keys automatically (unique random UUID per track call)', async () => {
    // No caller key = dedup opt-out. Two same-instant identical events must
    // get DISTINCT keys (the old content-hash fallback collapsed them - the
    // H4 bug Aforo ingest fixed server-side in April 2026).
    await client.track({ customerId: 'cust_1', metricName: 'api_calls', quantity: 1 });
    await client.track({ customerId: 'cust_1', metricName: 'api_calls', quantity: 1 });
    await client.flush();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(body.events[0].idempotencyKey).toMatch(uuidRe);
    expect(body.events[1].idempotencyKey).toMatch(uuidRe);
    expect(body.events[0].idempotencyKey).not.toBe(body.events[1].idempotencyKey);
  });

  // Regression: the default key used to be SHA256(customerId:metric:quantity:occurredAt).
  // occurredAt has millisecond precision, so two distinct events inside one
  // millisecond hashed to the same key and the ingestor answered DUPLICATE and
  // dropped the second one — real usage silently lost.
  it('should give two identical events in the same millisecond different keys', async () => {
    // Freeze only the clock — timers and promises stay real so flush() still works.
    jest.useFakeTimers({
      now: 1_764_000_000_000,
      doNotFake: [
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
        'performance', 'hrtime',
      ],
    });

    try {
      await client.track({ customerId: 'cust_1', metricName: 'api_calls', quantity: 1 });
      await client.track({ customerId: 'cust_1', metricName: 'api_calls', quantity: 1 });
      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.events).toHaveLength(2);
      // Identical customer, metric, quantity AND occurredAt — the frozen clock
      // guarantees the exact input the old SHA-256 default hashed.
      expect(body.events[0].occurredAt).toBe(body.events[1].occurredAt);
      expect(body.events[0].idempotencyKey).not.toBe(body.events[1].idempotencyKey);
    } finally {
      jest.useRealTimers();
    }
  });

  it('should preserve an explicit key verbatim even for colliding events', async () => {
    await client.track({
      customerId: 'cust_1',
      metricName: 'api_calls',
      quantity: 1,
      occurredAt: '2026-03-21T00:00:00.000Z',
      idempotencyKey: 'caller-owned-key',
    });
    await client.track({
      customerId: 'cust_1',
      metricName: 'api_calls',
      quantity: 1,
      occurredAt: '2026-03-21T00:00:00.000Z',
      idempotencyKey: 'caller-owned-key',
    });
    await client.flush();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events.map((e: { idempotencyKey: string }) => e.idempotencyKey)).toEqual([
      'caller-owned-key',
      'caller-owned-key',
    ]);
  });

  it('should use caller-provided idempotency key', async () => {
    await client.track({
      customerId: 'cust_1',
      metricName: 'api_calls',
      idempotencyKey: 'my-custom-key',
    });
    await client.flush();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].idempotencyKey).toBe('my-custom-key');
  });

  it('should include metadata when provided', async () => {
    await client.track({
      customerId: 'cust_1',
      metricName: 'ai_tokens',
      quantity: 1500,
      metadata: { model: 'gpt-4o', feature: 'chat' },
    });
    await client.flush();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].metadata).toEqual({ model: 'gpt-4o', feature: 'chat' });
  });

  it('should send executionStatus normalized to upper case when provided', async () => {
    await client.track({
      customerId: 'cust_1',
      metricName: 'api_calls',
      executionStatus: '  timeout ',
    });
    await client.flush();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].executionStatus).toBe('TIMEOUT');
  });

  it('should omit an unknown or over-long executionStatus, warn, and still send the event', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await client.track({ customerId: 'cust_1', metricName: 'api_calls', quantity: 3, executionStatus: 'bogus' });
      await client.track({ customerId: 'cust_1', metricName: 'api_calls', executionStatus: 'X'.repeat(21) });
      await client.track({ customerId: 'cust_1', metricName: 'api_calls', executionStatus: 'hitl_required' });
      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.events).toHaveLength(3);
      expect('executionStatus' in body.events[0]).toBe(false);
      expect(body.events[0].quantity).toBe(3);
      expect(body.events[0].customerId).toBe('cust_1');
      expect('executionStatus' in body.events[1]).toBe(false);
      expect(body.events[2].executionStatus).toBe('HITL_REQUIRED');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown executionStatus "BOGUS"'));
    } finally {
      warn.mockRestore();
    }
  });

  it('should omit executionStatus when not provided or blank', async () => {
    await client.track({ customerId: 'cust_1', metricName: 'api_calls' });
    await client.track({ customerId: 'cust_1', metricName: 'api_calls', executionStatus: '   ' });
    await client.flush();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events).toHaveLength(2);
    expect('executionStatus' in body.events[0]).toBe(false);
    expect('executionStatus' in body.events[1]).toBe(false);
  });

  it('should default quantity to 1', async () => {
    await client.track({ customerId: 'cust_1', metricName: 'api_calls' });
    await client.flush();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].quantity).toBe(1);
  });

  it('should handle occurredAt as epoch ms', async () => {
    const epoch = 1711036800000;
    await client.track({
      customerId: 'cust_1',
      metricName: 'api_calls',
      occurredAt: epoch,
    });
    await client.flush();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].occurredAt).toBe(new Date(epoch).toISOString());
  });

  it('should throw after shutdown', async () => {
    await client.shutdown();

    await expect(
      client.track({ customerId: 'cust_1', metricName: 'api_calls' })
    ).rejects.toThrow('shut down');

    expect(client.isShutdown).toBe(true);
  });

  it('should flush remaining events on shutdown', async () => {
    await client.track({ customerId: 'cust_1', metricName: 'api_calls' });
    await client.track({ customerId: 'cust_2', metricName: 'api_calls' });

    await client.shutdown();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events).toHaveLength(2);
  });

  it('should be safe to call shutdown multiple times', async () => {
    await client.shutdown();
    await client.shutdown(); // No error
  });
});
