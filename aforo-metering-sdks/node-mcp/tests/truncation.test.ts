/**
 * The tool name is the name the client asked for (read off the tools/call
 * request by wrapToolHandler, or passed to recordToolInvocation). An over-long
 * one is truncated to the ingestor's limit (64) and the event is still sent.
 * The identity fields still drop the event as invalid.
 */
import { createHash } from 'node:crypto';
import { AforoMcpBilling, truncateToLimit, type UsageEvent } from '../src/index';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const sent = (): UsageEvent[] => mockFetch.mock.calls.flatMap((c) => JSON.parse(c[1].body).events);

describe('request-derived toolName', () => {
  let warn: jest.SpyInstance;
  let billing: AforoMcpBilling;
  let drops: Array<{ events: UsageEvent[]; reason: string }>;
  const truncationWarnings = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('truncated to'));

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    drops = [];
    billing = new AforoMcpBilling({
      tenantId: 'tenant_test', productId: 'prod_test', apiKey: 'k', ingestorUrl: 'https://ingest.test.aforo.ai',
      flushCount: 100, heartbeatEnabled: false, onError: () => {},
      onDrop: (events, reason) => drops.push({ events, reason }),
    });
  });

  afterEach(async () => {
    await billing.shutdown();
    warn.mockRestore();
  });

  const call = (name: string, meta: Record<string, unknown> = { agent_id: 'agent_1' }) =>
    billing.wrapToolHandler(async () => ({ content: [] }))({ params: { name, _meta: meta } });

  test('over-long tool name: event is sent with the name cut to exactly 64; one WARN across two calls', async () => {
    const first = 'search_' + 'x'.repeat(300);
    await call(first);
    await call('other_' + 'y'.repeat(100));
    await billing.flush();

    const events = sent();
    expect(events).toHaveLength(2);
    expect(events[0].toolName).toBe(first.slice(0, 64));
    expect(events[1].toolName).toHaveLength(64);
    expect(events[0].executionStatus).toBe('SUCCESS');
    expect(billing.droppedCount).toBe(0);
    expect(truncationWarnings()).toHaveLength(1);
    expect(truncationWarnings()[0]).toMatch(/toolName .* truncated to 64 characters/);
  });

  test('the cut never splits a surrogate pair', async () => {
    await call('t'.repeat(63) + '\u{1F600}' + 'tail');
    await billing.flush();

    const [ev] = sent();
    expect(ev.toolName).toBe('t'.repeat(63));
    expect(truncateToLimit('t'.repeat(62) + '\u{1F600}' + 'tail', 64)).toBe('t'.repeat(62) + '\u{1F600}');
  });

  test('a name that fits keeps the plain key and is not warned about', async () => {
    await call('search');
    await billing.flush();

    const [ev] = sent();
    expect(ev.toolName).toBe('search');
    expect(ev.idempotencyKey).toMatch(/^mcp:sdk:agent_1:no-session:search:\d+:[0-9a-f]{8}$/);
    expect(truncationWarnings()).toHaveLength(0);
  });

  test('the key is built from the untruncated name: uncut, stable per name, different for names sharing the first 64 chars', async () => {
    const shared = 'tool_' + 'x'.repeat(300);
    const a = shared + '_alpha';
    const b = shared + '_beta';
    await call(a);
    await call(a);
    await call(b);
    await billing.flush();

    const [a1, a2, b1] = sent();
    expect(a1.toolName).toBe(b1.toolName); // same label after the cut
    const stable = (key: string) => key.replace(/:\d+:[0-9a-f]{8}$/, '');
    for (const ev of [a1, a2, b1]) {
      expect(ev.idempotencyKey.length).toBeLessThanOrEqual(255);
      expect(ev.idempotencyKey).toMatch(/:\d+:[0-9a-f]{8}$/); // unique tail survives
    }
    expect(stable(a1.idempotencyKey)).toBe(`mcp:sdk:agent_1:no-session:${sha256(a)}`);
    expect(stable(a2.idempotencyKey)).toBe(stable(a1.idempotencyKey));
    expect(stable(b1.idempotencyKey)).toBe(`mcp:sdk:agent_1:no-session:${sha256(b)}`);
    expect(stable(b1.idempotencyKey)).not.toBe(stable(a1.idempotencyKey));
    expect(a2.idempotencyKey).not.toBe(a1.idempotencyKey);
  });

  test('an over-long name that still fits the key limit is kept verbatim in the key', async () => {
    const name = 'n'.repeat(100);
    await call(name);
    await billing.flush();

    const [ev] = sent();
    expect(ev.toolName).toBe('n'.repeat(64));
    expect(ev.idempotencyKey).toMatch(new RegExp(`^mcp:sdk:agent_1:no-session:${name}:\\d+:[0-9a-f]{8}$`));
  });

  test('recordToolInvocation(toolName) over 64 is truncated and sent too; key from the full name', async () => {
    const name = 't'.repeat(300);
    billing.recordToolInvocation(name, 'agent_1', undefined, 'SUCCESS', 1);
    billing.recordToolInvocation(name, 'agent_1', undefined, 'SUCCESS', 1);
    await billing.flush();

    const events = sent();
    expect(events).toHaveLength(2);
    expect(drops).toHaveLength(0);
    expect(events[0].toolName).toBe('t'.repeat(64));
    expect(events[0].idempotencyKey.replace(/:\d+:[0-9a-f]{8}$/, '')).toBe(`mcp:sdk:agent_1:no-session:${sha256(name)}`);
    expect(truncationWarnings()).toHaveLength(1);
  });

  test('a blank tool name and an over-long explicit customerId still drop as invalid', async () => {
    billing.recordToolInvocation(' ', 'agent_1', undefined, 'SUCCESS', 1);
    billing.recordToolInvocation('x'.repeat(300), 'agent_1', undefined, 'SUCCESS', 1, { customerId: 'c'.repeat(65) });
    await billing.flush();

    expect(sent()).toHaveLength(0);
    expect(drops.map((d) => d.reason)).toEqual(['invalid', 'invalid']);
    expect(drops[1].events[0].customerId).toBe('c'.repeat(65));
  });

  test('over-long customerId / agentId / sessionId from _meta still drop the event as invalid', async () => {
    await call('search', { agent_id: 'agent_1', customer_id: 'c'.repeat(65) });
    await call('search', { agent_id: 'a'.repeat(37) });
    await call('x'.repeat(300), { agent_id: 'agent_1', customer_id: 'c'.repeat(65) });
    await billing.flush();

    expect(sent()).toHaveLength(0);
    expect(drops.map((d) => d.reason)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(drops[0].events[0].customerId).toBe('c'.repeat(65));
    expect(drops[1].events[0].agentId).toBe('a'.repeat(37));
  });
});
