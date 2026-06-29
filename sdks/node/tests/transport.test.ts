import { Transport } from '../src/transport';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('Transport', () => {
  let transport: Transport;

  beforeEach(() => {
    mockFetch.mockReset();
    transport = new Transport({
      baseUrl: 'https://ingest.aforo.ai',
      apiKey: 'test-key',
      timeout: 5000,
      maxRetries: 2,
      retryBaseMs: 10, // Short for tests
    });
  });

  const events = [
    {
      customerId: 'cust_1',
      metricName: 'api_calls',
      quantity: 1,
      idempotencyKey: 'key_1',
      occurredAt: '2026-03-21T00:00:00Z',
    },
  ];

  it('should send events successfully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
    });

    const result = await transport.send(events);

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://ingest.aforo.ai/v1/ingest/batch');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toBe('Bearer test-key');
  });

  it('should return empty result for empty events', async () => {
    const result = await transport.send([]);
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should retry on 5xx errors', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, headers: new Map() })
      .mockResolvedValueOnce({ ok: false, status: 503, headers: new Map() })
      .mockResolvedValueOnce({ ok: true, status: 202, headers: new Map() });

    const result = await transport.send(events);

    expect(result.sent).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should not retry on 4xx errors (except 408/429)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Map(),
    });

    const result = await transport.send(events);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
  });

  it('should retry on 429 and respect Retry-After', async () => {
    const headersMap = new Map([['Retry-After', '1']]);
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (key: string) => key === 'Retry-After' ? '1' : null },
      })
      .mockResolvedValueOnce({ ok: true, status: 202, headers: new Map() });

    const result = await transport.send(events);

    expect(result.sent).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should fail after exhausting retries', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Map(),
    });

    const result = await transport.send(events);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('should handle network errors with retry', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('TIMEOUT'))
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Map() });

    const result = await transport.send(events);

    expect(result.sent).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should strip trailing slashes from baseUrl', () => {
    const t = new Transport({
      baseUrl: 'https://example.com/',
      apiKey: 'key',
      timeout: 5000,
      maxRetries: 0,
      retryBaseMs: 10,
    });

    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Map() });
    t.send(events);

    expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/v1/ingest/batch');
  });
});
