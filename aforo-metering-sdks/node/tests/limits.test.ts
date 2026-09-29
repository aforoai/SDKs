import { AforoClient } from '../src/client';
import { MAX_LENGTHS, describeLimitViolation } from '../src/limits';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

/** Customer ids of the events that actually reached the ingestor. */
async function flushedCustomerIds(client: AforoClient): Promise<string[]> {
  await client.flush();
  return mockFetch.mock.calls
    .flatMap((call) => JSON.parse(call[1].body).events)
    .map((event: { customerId: string }) => event.customerId);
}

/**
 * Every limit here mirrors a constraint the ingestor enforces
 * (IngestUsageEventRequest's @Size/@Digits, UsageEventValidator's timestamp
 * window and metadata cap). An event that breaks one is rejected server-side and
 * never billed — and since the SDK flushes in the background, that rejection
 * reaches nobody. These tests pin that the caller is told at track() instead,
 * and that the bad event never reaches the buffer.
 */
describe('ingestor field limits', () => {
  const baseOptions = { apiKey: 'sk_test_limits', flushCount: 1_000_000, flushInterval: 1_000_000 };

  const makeClient = () => new AforoClient(baseOptions);
  const validEvent = () => ({ customerId: 'cust_1', metricName: 'api_calls', quantity: 1 });

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });
  });

  describe('string lengths', () => {
    it.each([
      ['customerId', MAX_LENGTHS.customerId],
      ['metricName', MAX_LENGTHS.metricName],
      ['idempotencyKey', MAX_LENGTHS.idempotencyKey],
    ] as const)('%s accepts the limit and rejects one over', async (field, max) => {
      const atLimit = makeClient();
      await expect(atLimit.track({ ...validEvent(), [field]: 'x'.repeat(max) })).resolves.toBeUndefined();
      expect(await flushedCustomerIds(atLimit)).toHaveLength(1);

      mockFetch.mockClear();
      const overLimit = makeClient();
      await expect(overLimit.track({ ...validEvent(), [field]: 'x'.repeat(max + 1) }))
        .rejects.toThrow(new RegExp(`${field}.*${max}`));
      expect(await flushedCustomerIds(overLimit)).toHaveLength(0);
    });
  });

  describe('quantity', () => {
    it('rejects more than 6 decimal places rather than rounding', async () => {
      const client = makeClient();
      // Rounding would silently change what the customer is billed.
      await expect(client.track({ ...validEvent(), quantity: 1.1234567 }))
        .rejects.toThrow(/decimal places/);
      expect(await flushedCustomerIds(client)).toHaveLength(0);
    });

    it('accepts exactly 6 decimal places', async () => {
      const client = makeClient();
      await expect(client.track({ ...validEvent(), quantity: 1.123456 })).resolves.toBeUndefined();
      expect(await flushedCustomerIds(client)).toHaveLength(1);
    });

    it('rejects more than 14 integer digits', async () => {
      const client = makeClient();
      await expect(client.track({ ...validEvent(), quantity: 1e15 }))
        .rejects.toThrow(/integer digits/);
      expect(await flushedCustomerIds(client)).toHaveLength(0);
    });
  });



  it('rejects an occurredAt that is not a timestamp at all', async () => {
    const client = makeClient();
    await expect(client.track({ ...validEvent(), occurredAt: 'last tuesday' }))
      .rejects.toThrow(/ISO-8601/);
    expect(await flushedCustomerIds(client)).toHaveLength(0);
  });

  it('leaves server-configurable limits to the server', async () => {
    // max-age-days, future-tolerance-minutes and max-metadata-bytes are all
    // per-environment properties. Enforcing their defaults here would make the
    // SDK refuse usage a deployment configured differently would accept and bill.
    const client = makeClient();
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    await expect(client.track({ ...validEvent(), occurredAt: old })).resolves.toBeUndefined();
    await expect(client.track({ ...validEvent(), metadata: { blob: 'x'.repeat(20_000) } }))
      .resolves.toBeUndefined();
    expect(await flushedCustomerIds(client)).toHaveLength(2);
  });

  it('a rejected event does not disturb the good events already buffered', async () => {
    const client = makeClient();
    await client.track({ ...validEvent(), customerId: 'cust_1' });
    await expect(client.track({ ...validEvent(), customerId: 'c'.repeat(65) })).rejects.toThrow();
    await client.track({ ...validEvent(), customerId: 'cust_3' });

    expect(await flushedCustomerIds(client)).toEqual(['cust_1', 'cust_3']);
  });

  describe('describeLimitViolation', () => {
    it('returns null for an event the ingestor would accept', () => {
      expect(describeLimitViolation({
        customerId: 'cust_1',
        metricName: 'api_calls',
        quantity: 1,
        idempotencyKey: 'key-1',
        occurredAt: new Date().toISOString(),
      })).toBeNull();
    });

    it('names the field, the limit and the offending size', () => {
      const violation = describeLimitViolation({
        customerId: 'c'.repeat(65),
        metricName: 'api_calls',
        quantity: 1,
        occurredAt: new Date().toISOString(),
      });
      expect(violation).toMatch(/customerId/);
      expect(violation).toMatch(/65/);
      expect(violation).toMatch(/64/);
    });
  });
});
