/**
 * @file Unit tests for IngestorClient (single-event heartbeat sends) and config
 * productType / customerId handling.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IngestorClient } from '../src/telemetry/IngestorClient.js';
import { loadConfig } from '../src/config.js';
import type { ProxyUsageEvent } from '../src/types.js';

const realFetch = globalThis.fetch;

function event(): ProxyUsageEvent {
  return {
    customerId: 'c', metricName: 'mcp_server.tool_invocations', quantity: 1,
    occurredAt: new Date().toISOString(), idempotencyKey: 'k', productType: 'MCP_SERVER',
    toolName: 't', agentId: 'a', executionStatus: 'SUCCESS',
  };
}

function stubFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('no more stubbed responses');
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status, headers: next.headers,
    });
  }) as typeof fetch;
  return calls;
}

describe('IngestorClient', () => {
  afterEach(() => { globalThis.fetch = realFetch; });

  it('sendSingle posts one event once, with X-API-Key and no Bearer, and never retries', async () => {
    const calls = stubFetch([{ status: 503 }]);
    const client = new IngestorClient({ baseUrl: 'https://x.test/', apiKey: 'k', tenantId: 't' });
    assert.equal(await client.sendSingle(event()), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://x.test/v1/ingest/batch');
    assert.equal(calls[0].init.headers['X-API-Key'], 'k');
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(JSON.parse(calls[0].init.body).events.length, 1);

    stubFetch([new Error('network down')]);
    assert.equal(await client.sendSingle(event()), null); // swallowed
  });

  it('sendSingle returns the parsed response (e.g. killedSessionIds)', async () => {
    stubFetch([{ status: 202, body: { success: true, data: { accepted: 0, duplicates: 0, failed: 0, killedSessionIds: ['s1'] } } }]);
    const client = new IngestorClient({ baseUrl: 'https://x.test', apiKey: 'k', tenantId: 't' });
    const res = await client.sendSingle(event());
    assert.deepEqual(res?.killedSessionIds, ['s1']);
  });

  it('refuses a plain-http base URL on a non-loopback host', () => {
    assert.throws(() => new IngestorClient({ baseUrl: 'http://ingest.example.com', apiKey: 'k', tenantId: 't' }), /https/);
    new IngestorClient({ baseUrl: 'http://127.0.0.1:8084', apiKey: 'k', tenantId: 't' });
    new IngestorClient({ baseUrl: 'http://ingest.internal', apiKey: 'k', tenantId: 't', allowInsecureHttp: true });
  });

  it('never shows the API key in inspect() or JSON', () => {
    const client = new IngestorClient({ baseUrl: 'https://x.test', apiKey: 'sk_secret_value', tenantId: 't' });
    const util = require('node:util');
    assert.doesNotMatch(util.inspect(client, { depth: 5 }), /sk_secret_value/);
    assert.doesNotMatch(JSON.stringify(client), /sk_secret_value/);
  });
});

describe('loadConfig productType / customerId', () => {
  const base = {
    transport: 'stdio' as const, command: 'node',
    aforo: { tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://x.test', customerId: 'cust_0' },
  };

  it('defaults productType to MCP_SERVER and normalises configured values', () => {
    assert.equal(loadConfig(base).aforo.productType, 'MCP_SERVER');
    const cfg = loadConfig({ ...base, aforo: { ...base.aforo, productType: ' agentic_api ', customerId: 'cust_1' } });
    assert.equal(cfg.aforo.productType, 'AGENTIC_API');
    assert.equal(cfg.aforo.customerId, 'cust_1');
  });
});
