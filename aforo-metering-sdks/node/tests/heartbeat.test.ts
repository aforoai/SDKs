/**
 * Session heartbeat lifecycle (startSession / periodic emit / endSession)
 * + shutdown escape-timer regression lock.
 *
 * Heartbeats are load-bearing for session billing (fast crash detection on
 * the server: 90-180s instead of the 1hr idle timeout) but had zero test
 * coverage until the 2026-07-05 A+ prompt-7 self-review. The same review
 * found shutdown()'s Promise.race escape timer was never cleared — a clean
 * shutdown left the event loop pinned for up to shutdownTimeoutMs, delaying
 * process exit in short-lived producers. The last test here locks the fix
 * by asserting zero live timers after shutdown.
 */

import { AforoClient } from '../src/client';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function newClient() {
  return new AforoClient({
    apiKey: 'test-key',
    baseUrl: 'https://ingest.test.aforo.ai',
    flushCount: 100,
    flushInterval: 600_000, // out of the way — heartbeat cadence (30s) is what's under test
    maxRetries: 0,
    timeout: 5000,
  });
}

describe('AforoClient — session heartbeats', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 202, headers: new Map() });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const heartbeatBodies = () => mockFetch.mock.calls
    .map((c) => JSON.parse(c[1].body))
    .filter((b) => b.events[0].metricName === 'system.session.heartbeat');

  it('startSession sends an immediate heartbeat, then one every 30s — each alone, never buffered', () => {
    const client = newClient();
    client.startSession('sess_hb_1', 'MCP_SERVER');

    expect(client.bufferedCount).toBe(0); // heartbeats bypass the usage buffer
    expect(heartbeatBodies()).toHaveLength(1); // immediate first heartbeat

    jest.advanceTimersByTime(30_000);
    expect(heartbeatBodies()).toHaveLength(2);

    jest.advanceTimersByTime(30_000);
    expect(heartbeatBodies()).toHaveLength(3);
    expect(client.bufferedCount).toBe(0);

    for (const body of heartbeatBodies()) {
      expect(body.events).toHaveLength(1);
      expect(body.events[0].quantity).toBe(1);
      expect(body.events[0].sessionId).toBe('sess_hb_1');
      expect(body.events[0].productType).toBe('MCP_SERVER');
      expect(body.events[0].sessionBoundary).toBe('HEARTBEAT');
    }
  });

  it('endSession sends SESSION_END in its own request', async () => {
    const client = newClient();
    client.startSession('sess_hb_2');
    await client.endSession();

    const boundaries = heartbeatBodies().map((b) => b.events[0].sessionBoundary);
    expect(boundaries).toEqual(['HEARTBEAT', 'SESSION_END']);
    // Heartbeat events must carry the session id for server-side liveness tracking
    for (const body of heartbeatBodies()) {
      expect(body.events).toHaveLength(1);
      expect(body.events[0].sessionId).toBe('sess_hb_2');
      expect(body.events[0].metadata?.sessionId).toBe('sess_hb_2');
    }
  });

  it('a failed heartbeat is not a usage drop', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const onDrop = jest.fn();
    const client = new AforoClient({
      apiKey: 'test-key', baseUrl: 'https://ingest.test.aforo.ai',
      flushInterval: 600_000, maxRetries: 0, onDrop,
    });
    client.startSession('sess_hb_fail');
    await client.endSession();

    expect(mockFetch).toHaveBeenCalledTimes(2); // single attempt each, no retry
    expect(client.droppedCount).toBe(0);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('heartbeats stop after endSession', async () => {
    const client = newClient();
    client.startSession('sess_hb_3');
    await client.endSession();
    const callsAfterEnd = mockFetch.mock.calls.length;

    jest.advanceTimersByTime(120_000); // 4 heartbeat intervals
    expect(client.bufferedCount).toBe(0);
    expect(mockFetch.mock.calls.length).toBe(callsAfterEnd);
  });

  it('endSession without an active session just flushes (no SESSION_END fabricated)', async () => {
    const client = newClient();
    await client.endSession();
    expect(client.bufferedCount).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled(); // empty buffer → no wire call
  });

  it('startSession after shutdown is a no-op', async () => {
    const client = newClient();
    await client.shutdown();
    client.startSession('sess_hb_4');
    expect(client.bufferedCount).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shutdown clears ALL timers — flush interval, heartbeat, and the escape timer', async () => {
    const client = newClient();
    client.startSession('sess_hb_5');
    await client.track({ customerId: 'cust_1', metricName: 'api_calls', quantity: 1 });

    await client.shutdown();

    // Regression lock (2026-07-05): the Promise.race escape timer used to be
    // left dangling, pinning the event loop for shutdownTimeoutMs after a
    // clean shutdown. Zero live timers proves flushTimer + heartbeatTimer +
    // escapeTimer are all cleared.
    expect(jest.getTimerCount()).toBe(0);
    expect(client.isShutdown).toBe(true);
  });
});
