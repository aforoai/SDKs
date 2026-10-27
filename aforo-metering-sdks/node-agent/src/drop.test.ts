/**
 * Drop accounting and the deprecated `onDrop` hook. 2.0.0 (mirror PR #58)
 * replaced the per-event sender these tests used to cover and deleted the
 * file; this restores the same guarantees for the batch sender:
 * every permanently lost event is counted, reported once with its reason,
 * keeps its idempotency key, and a throwing hook never breaks delivery.
 * Events kept for a retry are not drops.
 */
import AforoAgent, { type AforoAgentConfig, type DropReason, type IngestEvent } from './index';

type Reply = { status: number; body?: unknown } | Error;

function scripted(script: Reply[]) {
  const calls: Array<{ events: IngestEvent[] }> = [];
  const fetchImpl = jest.fn(async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const next = script.shift();
    if (next instanceof Error) throw next;
    const reply = next ?? { status: 202, body: { success: true, data: { accepted: body.events.length, duplicates: 0, failed: 0 } } };
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function agentWith(fetchImpl: typeof fetch, extra: Partial<AforoAgentConfig> = {}) {
  const drops: Array<{ events: IngestEvent[]; reason: DropReason }> = [];
  const agent = new AforoAgent({
    apiKey: 'sk_test', customerId: 'cust_1', agentId: 'agent_1', fetchImpl,
    flushIntervalMs: 60_000, retryBaseDelayMs: 1, maxRetries: 1, logger: null,
    onDrop: (events, reason) => drops.push({ events, reason }),
    ...extra,
  });
  return { agent, drops };
}

describe('onDrop and droppedCount', () => {
  test('a non-retryable rejection drops the batch with reason "rejected", keys intact', async () => {
    const { fetchImpl } = scripted([{ status: 400, body: { message: 'bad metric' } }]);
    const { agent, drops } = agentWith(fetchImpl);
    const s = agent.startSession({ sessionId: 'r' });
    await s.recordStep({});
    await s.recordStep({});
    await agent.flush();
    expect(agent.droppedCount).toBe(2);
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('rejected');
    expect(drops[0].events.map((e) => e.idempotencyKey)).toEqual(['r:1', 'r:2']);
  });

  test('an outage is not a drop: events stay buffered and onDrop is not called', async () => {
    const { fetchImpl } = scripted([new TypeError('fetch failed')]);
    const { agent, drops } = agentWith(fetchImpl);
    await agent.startSession().recordStep({});
    const result = await agent.flush();
    expect(result.pending).toBe(1);
    expect(agent.droppedCount).toBe(0);
    expect(drops).toEqual([]);
  });

  test('per-event rejections in a 2xx drop only the named events', async () => {
    const { fetchImpl } = scripted([{
      status: 202,
      body: { success: true, data: { accepted: 1, duplicates: 0, failed: 1, errors: [{ index: 0, message: 'unknown metric' }] } },
    }]);
    const { agent, drops } = agentWith(fetchImpl);
    const s = agent.startSession({ sessionId: 'p' });
    await s.recordStep({});
    await s.recordStep({});
    await agent.flush();
    expect(agent.droppedCount).toBe(1);
    expect(drops).toEqual([{ events: [expect.objectContaining({ idempotencyKey: 'p:1' })], reason: 'rejected' }]);
  });

  test('failures the response does not name are counted, but no event is handed out as dropped', async () => {
    const { fetchImpl } = scripted([{ status: 202, body: { success: true, data: { accepted: 1, duplicates: 0, failed: 1 } } }]);
    const errors: any[] = [];
    const { agent, drops } = agentWith(fetchImpl, { onError: (e) => errors.push(e) });
    const s = agent.startSession();
    await s.recordStep({});
    await s.recordStep({});
    await agent.flush();
    expect(agent.droppedCount).toBe(1);
    expect(drops).toEqual([]);
    // The core counts unnamed failures but reports no events for them, so onError sees nothing to replay.
    expect(errors.filter((e) => e.events.length > 0)).toEqual([]);
  });

  test('overflow drops the oldest events with reason "overflow"', async () => {
    const { fetchImpl } = scripted([new Error('down'), new Error('down')]);
    const { agent, drops } = agentWith(fetchImpl, { maxBatchSize: 2, maxBufferSize: 2 });
    const s = agent.startSession({ sessionId: 'o' });
    s.recordUsage('gpuHours', 1);
    s.recordUsage('gpuHours', 1);
    await agent.flush();
    s.recordUsage('gpuHours', 1);
    expect(drops).toEqual([{ events: [expect.objectContaining({ idempotencyKey: 'o:1' })], reason: 'overflow' }]);
    expect(agent.droppedCount).toBe(1);
  });

  test('an invalid event is dropped with reason "invalid" and never sent', async () => {
    const { calls, fetchImpl } = scripted([]);
    const { agent, drops } = agentWith(fetchImpl, { customerId: undefined });
    await agent.startSession().recordStep({});
    await agent.flush();
    expect(calls).toHaveLength(0);
    expect(drops.map((d) => d.reason)).toEqual(['invalid']);
  });

  test('a throwing onDrop or onError never breaks flushing', async () => {
    const { fetchImpl } = scripted([{ status: 400 }]);
    const warn = jest.fn();
    const agent = new AforoAgent({
      apiKey: 'sk_test', customerId: 'cust_1', agentId: 'agent_1', fetchImpl, flushIntervalMs: 60_000, logger: { warn },
      onDrop: () => { throw new Error('hook bug'); },
      onError: () => { throw new Error('handler bug'); },
    });
    await agent.startSession().recordStep({});
    await expect(agent.flush()).resolves.toMatchObject({ failed: 1 });
    expect(agent.droppedCount).toBe(1);
    // The hook failures are logged, not swallowed silently.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hook bug'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('handler bug'));
  });

  test('happy path: nothing dropped, onDrop never called', async () => {
    const { fetchImpl } = scripted([]);
    const { agent, drops } = agentWith(fetchImpl);
    await agent.startSession().recordStep({});
    await agent.flush();
    expect(agent.droppedCount).toBe(0);
    expect(drops).toEqual([]);
  });
});

describe('record calls never wait on the network (G298)', () => {
  test('recordStep / recordTokens / recordUsage resolve while a full-batch flush is stuck', async () => {
    let started = 0;
    const fetchImpl = jest.fn(() => { started += 1; return new Promise<Response>(() => { /* never answers */ }); });
    const agent = new AforoAgent({
      apiKey: 'sk_test', customerId: 'cust_1', agentId: 'agent_1', fetchImpl: fetchImpl as unknown as typeof fetch,
      maxBatchSize: 1, flushIntervalMs: 60_000, requestTimeoutMs: 50, logger: null,
    });
    const s = agent.startSession();
    const settled = await Promise.race([
      (async () => {
        await s.recordStep({ inputTokens: 5 });
        await s.recordTokens('m', 1, 1);
        await s.recordUsage('gpuHours', 1);
        return 'returned';
      })(),
      new Promise((r) => setTimeout(() => r('blocked'), 1000)),
    ]);
    expect(settled).toBe('returned');
    expect(started).toBe(1); // one background flush, not one per record call
  });
});
