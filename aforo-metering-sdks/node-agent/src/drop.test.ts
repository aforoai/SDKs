/**
 * Drop observability + onDrop hook (A+ delivery-guarantee prompt 6 —
 * transport-variant mirror of the core SDK's drop hardening).
 *
 * This SDK sends each event ONCE (no retries) as a single Apigee-format
 * POST to <ingestorUrl>/events, so the drop sites are the failed sends:
 * network error / 5xx → 'retry_exhausted', 4xx → 'rejected'. Events carry
 * idempotency keys stamped at creation → dedup-safe replay.
 */

import AforoAgent, { type UsageEvent, type DropReason } from './index';

describe('AforoAgent — drop observability + onDrop hook', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function newAgent(fetchImpl: any, overrides: Record<string, unknown> = {}) {
    return new AforoAgent({
      tenantId: 'tenant-001',
      productId: 'prod-agent-001',
      apiKey: 'sk_agent_abc',
      customerId: 'cust_drop',
      maxRetries: 1, // single attempt: these tests are about drop accounting, not retries
      fetchImpl,
      ...overrides,
    } as any);
  }

  async function emitOne(agent: AforoAgent, agentId = 'agent_1') {
    await agent.emitEvent({
      eventType: 'agent_step',
      metricKey: 'step_count',
      value: 1,
      agentId,
      sessionId: 'sess_1',
      properties: {},
    });
  }

  it('network failure drops the batch, counts it, warns, and fires onDrop', async () => {
    const failingFetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const drops: Array<{ events: UsageEvent[]; reason: DropReason }> = [];
    const agent = newAgent(failingFetch, {
      onDrop: (events: UsageEvent[], reason: DropReason) => drops.push({ events, reason }),
    });

    await emitOne(agent, 'agent_1');
    await emitOne(agent, 'agent_2');
    await agent.flush();

    expect(agent.droppedCount).toBe(2);
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('retry_exhausted');
    expect(drops[0].events).toHaveLength(2);
    expect(drops[0].events[0].agentId).toBe('agent_1');
    // Events keep their keys — dedup-safe replay is possible
    expect(drops[0].events[0].idempotencyKey).toMatch(/^agent:/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retry_exhausted'));
    expect(failingFetch).toHaveBeenCalledTimes(2); // one POST per event, still no retries
  });

  it('partial failure drops ONLY the failed events (per-event fan-out)', async () => {
    let call = 0;
    const flakyFetch = jest.fn(async () => {
      call++;
      return call === 1 ? { ok: true, status: 202 } : { ok: false, status: 503 };
    });
    const drops: Array<{ events: UsageEvent[]; reason: DropReason }> = [];
    const agent = newAgent(flakyFetch, {
      onDrop: (events: UsageEvent[], reason: DropReason) => drops.push({ events, reason }),
    });

    await emitOne(agent, 'agent_ok');
    await emitOne(agent, 'agent_lost');
    await agent.flush();

    expect(agent.droppedCount).toBe(1); // only the failed send is dropped
    expect(drops).toHaveLength(1);
    expect(drops[0].events).toHaveLength(1);
    expect(drops[0].events[0].agentId).toBe('agent_lost');
  });

  it('4xx response fires onDrop with reason "rejected"', async () => {
    const rejectingFetch = jest.fn(async () => ({ ok: false, status: 400 }));
    const reasons: DropReason[] = [];
    const agent = newAgent(rejectingFetch, {
      onDrop: (_e: UsageEvent[], reason: DropReason) => reasons.push(reason),
    });

    await emitOne(agent);
    await agent.flush();

    expect(agent.droppedCount).toBe(1);
    expect(reasons).toEqual(['rejected']);
  });

  it('5xx response fires onDrop with reason "retry_exhausted"', async () => {
    const errFetch = jest.fn(async () => ({ ok: false, status: 503 }));
    const reasons: DropReason[] = [];
    const agent = newAgent(errFetch, {
      onDrop: (_e: UsageEvent[], reason: DropReason) => reasons.push(reason),
    });

    await emitOne(agent);
    await agent.flush();

    expect(agent.droppedCount).toBe(1);
    expect(reasons).toEqual(['retry_exhausted']);
  });

  it('default (no onDrop): drop is counted + warned, flush resolves normally', async () => {
    const failingFetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const agent = newAgent(failingFetch);

    await emitOne(agent);
    await expect(agent.flush()).resolves.toBeUndefined();

    expect(agent.droppedCount).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('a throwing onDrop hook never breaks flushing', async () => {
    const failingFetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const agent = newAgent(failingFetch, {
      onDrop: () => {
        throw new Error('hook bug');
      },
    });

    await emitOne(agent);
    await expect(agent.flush()).resolves.toBeUndefined();
    expect(agent.droppedCount).toBe(1);
  });

  it('happy path is unchanged: no drops, no warns, droppedCount stays 0', async () => {
    const okFetch = jest.fn(async () => ({ ok: true, status: 200 }));
    const onDrop = jest.fn();
    const agent = newAgent(okFetch, { onDrop });

    await emitOne(agent);
    await agent.flush();

    expect(agent.droppedCount).toBe(0);
    expect(onDrop).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(okFetch).toHaveBeenCalledTimes(1); // one event → one POST
    const [url, init] = (okFetch.mock.calls as unknown as [string, { body: string }][])[0];
    const body = JSON.parse(init.body);
    expect(body.idempotencyKey).toMatch(/^agent:/);
    expect(body.properties.agentId).toBe('agent_1');
    expect(String(url)).toContain('/events');
  });
});
