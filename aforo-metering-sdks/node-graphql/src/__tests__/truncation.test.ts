/**
 * The operation name is read off the incoming query. An over-long one is
 * truncated to the ingestor's limit (255) and the event is still sent; a
 * customerId the caller set still drops the event as invalid.
 */
import { createHash } from 'node:crypto';
import { AforoGraphQlBilling, truncateToLimit, type GraphQlUsageEvent } from '../index';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const sent = (): GraphQlUsageEvent[] => mockFetch.mock.calls.flatMap((c) => JSON.parse(c[1].body).events);

describe('request-derived gqlOperationName', () => {
  let warn: jest.SpyInstance;
  let billing: AforoGraphQlBilling;
  let drops: Array<{ events: GraphQlUsageEvent[]; reason: string }>;
  const truncationWarnings = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('truncated to'));

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    drops = [];
    billing = new AforoGraphQlBilling({
      tenantId: 'tenant-001', productId: 'prod-gql-001', apiKey: 'k', ingestorUrl: 'https://api.aforo.ai',
      flushCount: 100, onDrop: (events, reason) => drops.push({ events, reason }),
    });
  });

  afterEach(async () => {
    await billing.shutdown();
    warn.mockRestore();
  });

  const record = (name: string, customerId = 'cust_001') =>
    billing.record({ customerId, query: `query ${name} { a }`, operationName: name, durationMs: 1, hasErrors: false });

  test('over-long name: event is sent with the name cut to exactly 255; one WARN across two events', async () => {
    const first = 'Op' + 'x'.repeat(400);
    const second = 'Other' + 'y'.repeat(600);
    record(first);
    record(second);
    await billing.shutdown();

    const events = sent();
    expect(events).toHaveLength(2);
    expect(events[0].gqlOperationName).toBe(first.slice(0, 255));
    expect(events[1].gqlOperationName).toHaveLength(255);
    expect(events[0].metricName).toBe('graphql_api.operations');
    expect(billing.droppedCount).toBe(0);
    expect(drops).toHaveLength(0);
    expect(truncationWarnings()).toHaveLength(1);
    expect(truncationWarnings()[0]).toMatch(/gqlOperationName .* truncated to 255 characters/);
  });

  test('a name that fits is sent unchanged, with the name verbatim in the key and no warning', async () => {
    record('GetUser');
    await billing.shutdown();

    const [ev] = sent();
    expect(ev.gqlOperationName).toBe('GetUser');
    expect(ev.idempotencyKey).toMatch(/^gql:tenant-001:prod-gql-001:GetUser:\d+:[a-z0-9]+$/);
    expect(truncationWarnings()).toHaveLength(0);
  });

  test('the key is built from the untruncated name: its digest, never a cut key; shared 255-char prefixes differ', async () => {
    const shared = 'Op' + 'x'.repeat(300);
    const a = shared + 'Alpha';
    const b = shared + 'Beta';
    record(a);
    record(a);
    record(b);
    await billing.shutdown();

    const [a1, a2, b1] = sent();
    expect(a1.gqlOperationName).toBe(b1.gqlOperationName); // same label after the cut
    for (const ev of [a1, a2, b1]) expect(ev.idempotencyKey.length).toBeLessThanOrEqual(255);
    const stable = (key: string) => key.replace(/:\d+:[a-z0-9]+$/, '');
    // Derived from the full name, the same on every evaluation of that name...
    expect(stable(a1.idempotencyKey)).toBe(`gql:tenant-001:prod-gql-001:${sha256(a)}`);
    expect(stable(a2.idempotencyKey)).toBe(stable(a1.idempotencyKey));
    // ...and different for a different name with the same first 255 characters.
    expect(stable(b1.idempotencyKey)).toBe(`gql:tenant-001:prod-gql-001:${sha256(b)}`);
    expect(stable(b1.idempotencyKey)).not.toBe(stable(a1.idempotencyKey));
    // Each event still has its own key (unique millis:random tail kept).
    expect(a1.idempotencyKey).toMatch(/:\d+:[a-z0-9]+$/);
    expect(a2.idempotencyKey).not.toBe(a1.idempotencyKey);
  });

  test('an explicit over-long customerId is still dropped as invalid, even with an over-long name', async () => {
    record('Op' + 'x'.repeat(400), 'c'.repeat(65));
    await billing.shutdown();

    expect(sent()).toHaveLength(0);
    expect(drops.map((d) => d.reason)).toEqual(['invalid']);
    expect(drops[0].events[0].customerId).toBe('c'.repeat(65));
  });

  test('truncateToLimit never leaves half a surrogate pair', () => {
    const value = 'a'.repeat(254) + '\u{1F600}' + 'tail';
    const cut = truncateToLimit(value, 255);
    expect(cut).toBe('a'.repeat(254));
    const last = cut.charCodeAt(cut.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(truncateToLimit('a'.repeat(253) + '\u{1F600}' + 'tail', 255)).toBe('a'.repeat(253) + '\u{1F600}');
    expect(truncateToLimit('short', 255)).toBe('short');
  });
});
