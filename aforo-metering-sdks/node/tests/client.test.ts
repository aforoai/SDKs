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

  it('rejects blank customerId / metricName and non-positive quantity', async () => {
    await expect(client.track({ customerId: ' ', metricName: 'api_calls' })).rejects.toThrow('customerId');
    await expect(client.track({ customerId: 'c', metricName: '' })).rejects.toThrow('metricName');
    await expect(client.track({ customerId: 'c', metricName: 'm', quantity: 0 })).rejects.toThrow('quantity');
    await expect(client.track({ customerId: 'c', metricName: 'm', quantity: -1 })).rejects.toThrow('quantity');
    expect(client.bufferedCount).toBe(0);
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

  it('should generate idempotency keys automatically', async () => {
    await client.track({ customerId: 'cust_1', metricName: 'api_calls', quantity: 1 });
    await client.flush();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.events[0].idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
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
