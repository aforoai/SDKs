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
