/**
 * AforoAgent against the repo's fault-injecting mock ingestor (real HTTP):
 * an outage that recovers without losing events or changing keys, 429 with
 * Retry-After in both forms, a response slower than the request timeout,
 * shutdown while a request hangs, and overflow while the ingestor is down.
 */
import AforoAgent, { type AforoAgentError, type DropReason, type IngestEvent } from '../src/index';
import { startMockIngestor, waitFor, type MockIngestor } from './support/mock-ingestor';

jest.setTimeout(20_000);

describe('AforoAgent (mock ingestor)', () => {
  let mock: MockIngestor;
  const agents: AforoAgent[] = [];

  beforeAll(async () => { mock = await startMockIngestor(); });
  afterAll(async () => { await mock.stop(); });
  beforeEach(async () => { await mock.reset(); });
  afterEach(async () => {
    await mock.clearFaults();
    while (agents.length) await agents.pop()!.shutdown();
  });

  function make(extra: Record<string, unknown> = {}) {
    const errors: AforoAgentError[] = [];
    const drops: Array<{ events: IngestEvent[]; reason: DropReason }> = [];
    const agent = new AforoAgent({
      apiKey: 'sk_test', customerId: 'cust_1', agentId: 'agent_1', endpoint: mock.url,
      flushIntervalMs: 3_600_000, retryBaseDelayMs: 1, flushOnExit: false, logger: null,
      onError: (e) => errors.push(e),
      onDrop: (events, reason) => drops.push({ events, reason }),
      ...extra,
    });
    agents.push(agent);
    return { agent, errors, drops };
  }

  test('an outage that recovers loses nothing and keeps the keys', async () => {
    const { agent, errors, drops } = make({ maxRetries: 2 });
    await mock.faults([{ status: 503, times: 2 }]);
    const s = agent.startSession({ sessionId: 'out' });
    s.recordUsage('gpuHours', 1);
    s.recordUsage('gpuHours', 2);
    expect(await agent.flush()).toMatchObject({ accepted: 0, requeued: 2, pending: 2 });
    expect(errors.map((e) => e.kind)).toEqual(['retrying']);
    expect(await agent.flush()).toMatchObject({ accepted: 2, pending: 0 });
    const state = await mock.state();
    expect(state.events.map((e) => e.idempotencyKey)).toEqual(['out:1', 'out:2']);
    expect(drops).toEqual([]);
  });

  test('429 with Retry-After as seconds and as an HTTP-date is retried', async () => {
    const { agent } = make({ maxRetries: 3 });
    await mock.faults([
      { status: 429, retryAfter: '0', times: 1 },
      { status: 429, retryAfter: new Date(Date.now() - 1000).toUTCString(), times: 1 },
    ]);
    agent.startSession().recordUsage('gpuHours', 1);
    expect(await agent.flush()).toMatchObject({ accepted: 1 });
    expect((await mock.state()).requests.map((r) => r.status)).toEqual([429, 429, 202]);
  });

  test('a response slower than the request timeout is retried, not dropped', async () => {
    const { agent, drops } = make({ requestTimeoutMs: 100, maxRetries: 2 });
    await mock.faults([{ delayMs: 600, times: 1 }]);
    agent.startSession().recordUsage('gpuHours', 1);
    expect(await agent.flush()).toMatchObject({ accepted: 1 });
    await waitFor(async () => (await mock.state()).inFlight === 0, 'slow request finished');
    expect((await mock.state()).uniqueKeys).toBe(1);
    expect(drops).toEqual([]);
  });

  test('shutdown with a request hanging honours its deadline and reports leftovers', async () => {
    const { agent, drops } = make({ shutdownTimeoutMs: 300 });
    await mock.faults([{ hang: true, times: -1 }]);
    const s = agent.startSession();
    s.recordUsage('gpuHours', 1);
    s.recordUsage('gpuHours', 1);
    const started = Date.now();
    const result = await agent.shutdown();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result).toMatchObject({ accepted: 0, pending: 0 });
    expect(drops.map((d) => [d.reason, d.events.length])).toEqual([['shutdown', 2]]);
    s.recordUsage('gpuHours', 1);
    expect(drops[1].reason).toBe('closed');
  });

  test('overflow while the ingestor is down drops the oldest event', async () => {
    const { agent, drops } = make({ maxBatchSize: 2, maxBufferSize: 2, maxRetries: 1 });
    await mock.faults([{ status: 503, times: -1 }]);
    const s = agent.startSession({ sessionId: 'ov' });
    s.recordUsage('gpuHours', 1);
    s.recordUsage('gpuHours', 1);
    await agent.flush();
    s.recordUsage('gpuHours', 1);
    expect(drops).toEqual([{ events: [expect.objectContaining({ idempotencyKey: 'ov:1' })], reason: 'overflow' }]);
  });

  test('refuses a plain-http endpoint on a non-local host', () => {
    expect(() => new AforoAgent({ apiKey: 'k', endpoint: 'http://ingest.example.com', flushOnExit: false })).toThrow(/https/);
  });
});
