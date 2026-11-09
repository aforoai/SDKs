/**
 * Regression tests for the SDK review of 2026-11-09 (node-agent findings 3 and 10, rules R1-R3).
 */
import AforoAgent, { type IngestEvent } from './index';
import { bodyJson } from '../test-support/request-body';

function capture() {
  const sent: IngestEvent[][] = [];
  const fetchImpl = (async (_url: unknown, init: any) => {
    const body = bodyJson(init);
    sent.push(body.events);
    return new Response(JSON.stringify({ success: true, data: { accepted: body.events.length, duplicates: 0, failed: 0 } }), { status: 202 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

function agentWith(fetchImpl: typeof fetch) {
  const warnings: string[] = [];
  const errors: Array<{ kind: string; message: string }> = [];
  const agent = new AforoAgent({
    apiKey: 'sk_test', customerId: 'cust_1', agentId: 'agent_1', fetchImpl, flushOnExit: false,
    logger: { warn: (m: string) => warnings.push(m) },
    onError: (e) => errors.push({ kind: e.kind, message: e.message }),
  });
  return { agent, warnings, errors };
}

describe('SDK review fixes (node-agent)', () => {
  test('#3/R3 an executionDurationMs over the Java int range is left off; the batch and the event survive', async () => {
    const { sent, fetchImpl } = capture();
    const { agent, warnings, errors } = agentWith(fetchImpl);
    const a = agent.startSession({ customerId: 'cust_A' });
    const b = agent.startSession({ customerId: 'cust_B' });
    await a.recordToolCall('web_search', { durationMs: 510 });
    await b.recordToolCall('db_query', { durationMs: 3_000_000_000 });
    await b.recordToolCall('db_query', { durationMs: Number.POSITIVE_INFINITY });
    await agent.flush();
    const events = sent.flat();
    expect(events).toHaveLength(6);
    expect(events.filter((e) => e.customerId === 'cust_A').every((e) => e.executionDurationMs === 510)).toBe(true);
    expect(events.filter((e) => e.customerId === 'cust_B').every((e) => !('executionDurationMs' in e))).toBe(true);
    expect(errors).toEqual([]);
    expect(warnings.filter((w) => w.includes('executionDurationMs'))).toHaveLength(1);
    await agent.shutdown();
  });

  test('#10 a quantity beyond 14 integer digits or 6 decimals is dropped as invalid when recorded', async () => {
    const { sent, fetchImpl } = capture();
    const { agent, errors } = agentWith(fetchImpl);
    const s = agent.startSession();
    await s.recordUsage('gpuHours', 1 / 3);           // 16 decimals
    await s.recordUsage('gpuHours', 1e-7);            // 7 decimals
    await s.recordUsage('executionMinutes', 1e14);    // 15 integer digits
    await s.recordUsage('gpuHours', 0.25);            // fine
    await s.recordUsage('executionMinutes', 99_999_999_999_999.5); // 14 digits, 1 decimal: fine
    await agent.flush();
    expect(errors.map((e) => e.kind)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(errors[0].message).toMatch(/6 decimal places/);
    expect(sent.flat().map((e) => e.quantity)).toEqual([0.25, 99_999_999_999_999.5]);
    expect(agent.droppedCount).toBe(3);
    await agent.shutdown();
  });

  test('R2 metadata that is not a plain object drops the event as invalid', async () => {
    const { sent, fetchImpl } = capture();
    const { agent, errors } = agentWith(fetchImpl);
    const s = agent.startSession();
    await s.recordUsage('knowledgeQueries', 1, { metadata: ['a', 'b'] as any });
    await s.recordUsage('knowledgeQueries', 1, { metadata: { ok: true } });
    const bad = agent.startSession({ metadata: 'oops' as any });
    await bad.recordUsage('knowledgeQueries', 1);
    await agent.flush();
    expect(errors.map((e) => e.kind)).toEqual(['invalid', 'invalid']);
    expect(errors[0].message).toMatch(/plain object/);
    expect(sent.flat()).toHaveLength(1);
    await agent.shutdown();
  });

  test('R1 events carry an occurredAt with seconds and a zone', async () => {
    const { sent, fetchImpl } = capture();
    const { agent } = agentWith(fetchImpl);
    await agent.startSession().recordStep();
    await agent.flush();
    expect(sent.flat()[0].occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await agent.shutdown();
  });
});
