/**
 * @file Regression for the 2026-11-09 end-to-end run: in front of a Streamable
 * HTTP server that issues no Mcp-Session-Id, every tool call became its own
 * session (a new sessionId on each event, the heartbeat tracking a session
 * that had ended). Header-less calls are now metered in one stable proxy
 * session per client token, while each request still matches only its own
 * responses, and traffic that carries an Mcp-Session-Id keeps that session.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHttpProxy } from '../src/proxy/StreamableHttpProxy.js';
import type { ProxyConfig } from '../src/types.js';
import { startMockIngestor, type MockIngestor } from './support/mock-ingestor.js';

const TOKEN_A = 'token-for-customer-a-0001';
const TOKEN_B = 'token-for-customer-b-0002';
const TOOL_METRIC = 'mcp_server.tool_invocations';
const HEARTBEAT_METRIC = 'system.session.heartbeat';

/**
 * A stateless Streamable HTTP MCP server: never sends Mcp-Session-Id. `slow`
 * answers after 150 ms, `fail` answers with a JSON-RPC error at once, anything
 * else succeeds at once.
 */
async function startStatelessUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      const msg = JSON.parse(text || '{}');
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const name = msg.params?.name;
      const reply = name === 'fail'
        ? { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'tool failed' } }
        : { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `ran ${name ?? msg.method}` }] } };
      const send = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply)); };
      if (name === 'slow') setTimeout(send, 150); else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

function config(mock: MockIngestor, upstream: string): ProxyConfig {
  return {
    transport: 'streamable-http',
    upstream,
    handleSignals: false,
    listen: { port: 0, host: '127.0.0.1', authTokens: { [TOKEN_A]: 'cust_a', [TOKEN_B]: 'cust_b' } },
    aforo: { tenantId: 't', productId: 'p', apiKey: 'sk_test', ingestorUrl: mock.url, flushIntervalMs: 30, heartbeatIntervalMs: 0 },
  } as unknown as ProxyConfig;
}

const toolCall = (id: number, name: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {}, _meta: { agent_id: 'agent_1' } } });

describe('Streamable HTTP without Mcp-Session-Id', () => {
  let mock: MockIngestor;
  let upstream: { url: string; close: () => Promise<void> };
  let proxy: StreamableHttpProxy;
  const post = (body: unknown, token: string, session?: string) => fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`, ...(session ? { 'Mcp-Session-Id': session } : {}),
    },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.text() }));

  before(async () => { mock = await startMockIngestor(); });
  after(async () => { await mock.close(); });

  it('meters every header-less call of a client in one stable session, one per client token', async () => {
    await mock.reset();
    upstream = await startStatelessUpstream();
    proxy = new StreamableHttpProxy(config(mock, upstream.url));
    await proxy.start();
    try {
      // Stateless clients restart their JSON-RPC ids: every call here is id 1.
      for (const name of ['a1', 'a2', 'a3']) assert.equal((await post(toolCall(1, name), TOKEN_A)).status, 200);
      for (const name of ['b1', 'b2']) assert.equal((await post(toolCall(1, name), TOKEN_B)).status, 200);
      const state = await mock.waitFor((s) => s.events.filter((e) => e.metricName === TOOL_METRIC).length === 5
        && s.events.some((e) => e.metricName === HEARTBEAT_METRIC));
      const tools = state.events.filter((e) => e.metricName === TOOL_METRIC);
      const sessionsOf = (customer: string) => new Set(tools.filter((e) => e.customerId === customer).map((e) => e.sessionId));
      const a = [...sessionsOf('cust_a')];
      const b = [...sessionsOf('cust_b')];
      assert.equal(a.length, 1, `cust_a calls in one session, got ${JSON.stringify(a)}`);
      assert.equal(b.length, 1, `cust_b calls in one session, got ${JSON.stringify(b)}`);
      assert.notEqual(a[0], b[0]);
      assert.match(a[0], /^proxy:streamable-http:/);
      assert.ok(a[0].length <= 64);
      assert.equal(new Set(tools.map((e) => e.idempotencyKey)).size, 5, 'each call keeps its own idempotency key');
      // The heartbeat follows the session the calls are metered in.
      const beats = state.events.filter((e) => e.metricName === HEARTBEAT_METRIC);
      assert.ok(beats.length >= 1);
      assert.ok(beats.every((e) => e.sessionId === a[0]), `heartbeat session ${beats.map((e) => e.sessionId)} vs ${a[0]}`);
    } finally {
      await proxy.stop();
      await upstream.close();
    }
  });

  it('still matches each request to its own response when header-less calls reuse an id concurrently', async () => {
    await mock.reset();
    upstream = await startStatelessUpstream();
    proxy = new StreamableHttpProxy(config(mock, upstream.url));
    await proxy.start();
    try {
      // Same token, same id, in flight together: the failing call answers first.
      const [slow, fail] = await Promise.all([post(toolCall(1, 'slow'), TOKEN_A), post(toolCall(1, 'fail'), TOKEN_A)]);
      assert.match(slow.body, /ran slow/);
      assert.match(fail.body, /tool failed/);
      const state = await mock.waitFor((s) => s.events.filter((e) => e.metricName === TOOL_METRIC).length === 2);
      const status = Object.fromEntries(state.events.filter((e) => e.metricName === TOOL_METRIC).map((e) => [e.toolName, e.executionStatus]));
      assert.deepEqual(status, { slow: 'SUCCESS', fail: 'ERROR' });
      const sessions = new Set(state.events.filter((e) => e.metricName === TOOL_METRIC).map((e) => e.sessionId));
      assert.equal(sessions.size, 1);
    } finally {
      await proxy.stop();
      await upstream.close();
    }
  });

  it('keeps the Mcp-Session-Id as the session when the client sends one', async () => {
    await mock.reset();
    upstream = await startStatelessUpstream();
    proxy = new StreamableHttpProxy(config(mock, upstream.url));
    await proxy.start();
    try {
      await post(toolCall(1, 'x'), TOKEN_A, 'up-sess-1');
      await post(toolCall(2, 'y'), TOKEN_A, 'up-sess-2');
      const state = await mock.waitFor((s) => s.events.filter((e) => e.metricName === TOOL_METRIC).length === 2);
      const byTool = Object.fromEntries(state.events.filter((e) => e.metricName === TOOL_METRIC).map((e) => [e.toolName, e.sessionId]));
      assert.deepEqual(byTool, { x: 'up-sess-1', y: 'up-sess-2' });
    } finally {
      await proxy.stop();
      await upstream.close();
    }
  });
});
