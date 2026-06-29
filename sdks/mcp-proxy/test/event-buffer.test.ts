/**
 * @file Unit tests for EventBuffer — flush triggers, batching.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBuffer } from '../src/telemetry/EventBuffer.js';
import type { ProxyUsageEvent } from '../src/types.js';

function makeEvent(toolName: string): ProxyUsageEvent {
  return {
    customerId: 'agent_1',
    metricName: 'mcp_server.tool_invocations',
    quantity: 1,
    occurredAt: new Date().toISOString(),
    idempotencyKey: `key_${toolName}_${Date.now()}`,
    productType: 'MCP_SERVER',
    toolName,
    agentId: 'agent_1',
    sessionId: 'session_1',
    executionStatus: 'SUCCESS',
    executionDurationMs: 100,
    metadata: { proxy: true, proxyVersion: '1.0.0', transport: 'stdio', productId: 'prod_1' },
  };
}

// Stub IngestorClient
class StubClient {
  batches: ProxyUsageEvent[][] = [];
  async sendBatch(events: ProxyUsageEvent[]) {
    this.batches.push([...events]);
    return { accepted: events.length, duplicates: 0, failed: 0 };
  }
}

describe('EventBuffer', () => {
  let buffer: EventBuffer;
  let client: StubClient;

  afterEach(async () => {
    if (buffer) await buffer.shutdown();
  });

  it('flushes when count threshold is reached', async () => {
    client = new StubClient();
    buffer = new EventBuffer({
      flushCount: 3,
      flushIntervalMs: 60_000, // Very long — won't trigger during test
      client: client as any,
    });

    buffer.push(makeEvent('a'));
    buffer.push(makeEvent('b'));
    assert.equal(client.batches.length, 0);

    buffer.push(makeEvent('c')); // Triggers flush

    // Wait for async flush
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(client.batches.length, 1);
    assert.equal(client.batches[0].length, 3);
  });

  it('reports correct size', () => {
    client = new StubClient();
    buffer = new EventBuffer({
      flushCount: 100,
      flushIntervalMs: 60_000,
      client: client as any,
    });

    assert.equal(buffer.size, 0);
    buffer.push(makeEvent('a'));
    assert.equal(buffer.size, 1);
    buffer.push(makeEvent('b'));
    assert.equal(buffer.size, 2);
  });

  it('manual flush drains all events', async () => {
    client = new StubClient();
    buffer = new EventBuffer({
      flushCount: 100,
      flushIntervalMs: 60_000,
      client: client as any,
    });

    buffer.push(makeEvent('a'));
    buffer.push(makeEvent('b'));

    await buffer.flush();

    assert.equal(client.batches.length, 1);
    assert.equal(client.batches[0].length, 2);
    assert.equal(buffer.size, 0);
  });

  it('flush is a no-op when buffer is empty', async () => {
    client = new StubClient();
    buffer = new EventBuffer({
      flushCount: 100,
      flushIntervalMs: 60_000,
      client: client as any,
    });

    await buffer.flush();
    assert.equal(client.batches.length, 0);
  });

  it('shutdown stops timer and flushes remaining', async () => {
    client = new StubClient();
    buffer = new EventBuffer({
      flushCount: 100,
      flushIntervalMs: 60_000,
      client: client as any,
    });

    buffer.push(makeEvent('a'));
    buffer.push(makeEvent('b'));

    await buffer.shutdown();

    assert.equal(client.batches.length, 1);
    assert.equal(client.batches[0].length, 2);
  });
});
