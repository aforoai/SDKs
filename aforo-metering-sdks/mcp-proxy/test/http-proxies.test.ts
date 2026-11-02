/**
 * @file SSE and Streamable HTTP proxies end to end, in process: a fake MCP
 * server behind the proxy and the repo's mock ingestor in front of Aforo.
 * Covers listener auth / Host / Origin (G302), JSON-RPC batches (G303), quota
 * against a real HTTP answer (G304), and one session per SSE connection (G305).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { SseProxy } from '../src/proxy/SseProxy.js';
import { StreamableHttpProxy } from '../src/proxy/StreamableHttpProxy.js';
import type { ProxyConfig } from '../src/types.js';
import { startMockIngestor, waitUntil, type MockIngestor } from './support/mock-ingestor.js';
import { startLegacySseUpstream, startStreamableUpstream, type FakeUpstream } from './support/upstream.js';

const TOKEN_A = 'token-for-customer-a-0001';
const TOKEN_B = 'token-for-customer-b-0002';

function config(mock: MockIngestor, transport: 'sse' | 'streamable-http', upstream: string, extra: Partial<ProxyConfig> = {}): ProxyConfig {
  const { listen, aforo: _aforo, ...rest } = extra;
  return {
    transport,
    upstream,
    handleSignals: false,
    ...rest,
    listen: listen ?? { port: 0, host: '127.0.0.1', authTokens: { [TOKEN_A]: 'cust_a', [TOKEN_B]: 'cust_b' } },
    aforo: {
      tenantId: 't', productId: 'p', apiKey: 'sk_test', ingestorUrl: mock.url,
      flushIntervalMs: 30, heartbeatIntervalMs: 0, ...(extra.aforo ?? {}),
    },
  } as ProxyConfig;
}

interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/** A request with full control of Host / Origin (fetch forbids setting Host). */
function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const toolCall = (id: number | string, name: string, meta: Record<string, unknown> = { agent_id: 'agent_1' }) =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {}, _meta: meta } });

/** Read SSE events from a streaming fetch body until `stop` says enough. */
async function readEvents(body: ReadableStream<Uint8Array>, stop: (events: Array<{ event?: string; data: string }>) => boolean, timeoutMs = 5000) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event?: string; data: string }> = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (!stop(events)) {
    if (Date.now() > deadline) throw new Error(`SSE events not seen in time: ${JSON.stringify(events)}`);
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      events.push({ ...(event ? { event } : {}), data });
    }
  }
  return { events, cancel: () => reader.cancel().catch(() => undefined) };
}

describe('HTTP proxies', () => {
  let mock: MockIngestor;
  before(async () => { mock = await startMockIngestor(); });
  after(async () => { await mock.close(); });
  beforeEach(async () => { await mock.reset(); });

  describe('listener auth, Host and Origin (G302)', () => {
    let upstream: FakeUpstream;
    let proxy: StreamableHttpProxy;
    let port: number;
    before(async () => {
      upstream = await startStreamableUpstream();
      proxy = new StreamableHttpProxy(config(mock, 'streamable-http', upstream.url, {
        listen: { port: 0, authTokens: { [TOKEN_A]: 'cust_a' }, allowedOrigins: ['https://app.example'] } as any,
      }));
      await proxy.start();
      port = proxy.port!;
    });
    after(async () => { await proxy.stop(); await upstream.close(); });

    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const host = () => `127.0.0.1:${port}`;

    it('refuses a request without a bearer token', async () => {
      const res = await raw(port, 'POST', '/mcp', { Host: host(), 'Content-Type': 'application/json' }, init);
      assert.equal(res.status, 401);
      assert.equal(res.headers['www-authenticate'], 'Bearer');
      assert.equal(upstream.seen.length, 0);
    });

    it('refuses an unknown token', async () => {
      const res = await raw(port, 'POST', '/mcp', { Host: host(), Authorization: 'Bearer not-a-real-token-xyz', 'Content-Type': 'application/json' }, init);
      assert.equal(res.status, 401);
    });

    it('refuses a foreign Host header even with a valid token (DNS rebinding)', async () => {
      const res = await raw(port, 'POST', '/mcp', { Host: `attacker.example:${port}`, Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' }, init);
      assert.equal(res.status, 421);
    });

    it('refuses an Origin that is not allowed, and never answers with a wildcard', async () => {
      const res = await raw(port, 'POST', '/mcp', { Host: host(), Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' }, init);
      assert.equal(res.status, 403);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });

    it('accepts a valid token from an allowed origin and names that origin in CORS', async () => {
      const res = await raw(port, 'POST', '/mcp', { Host: `localhost:${port}`, Origin: 'https://app.example', Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' }, init);
      assert.equal(res.status, 200);
      assert.equal(res.headers['access-control-allow-origin'], 'https://app.example');
      assert.equal(res.headers['mcp-session-id'], 'up-1');
      // The proxy's token is never sent to the MCP server.
      assert.equal(upstream.seen.at(-1)?.headers.authorization, undefined);
    });

    it('answers a CORS preflight for an allowed origin only', async () => {
      const ok = await raw(port, 'OPTIONS', '/mcp', { Host: host(), Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST' });
      assert.equal(ok.status, 204);
      assert.match(String(ok.headers['access-control-allow-headers']), /Authorization/);
      const bad = await raw(port, 'OPTIONS', '/mcp', { Host: host(), Origin: 'https://evil.example' });
      assert.equal(bad.status, 403);
    });

    it('refuses a body over the size limit', async () => {
      const big = 'x'.repeat(4 * 1024 * 1024 + 10);
      const res = await raw(port, 'POST', '/mcp', { Host: host(), Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' }, big);
      assert.equal(res.status, 413);
    });

    it('will not start without authentication, or unauthenticated on a non-loopback host', () => {
      assert.throws(() => new StreamableHttpProxy(config(mock, 'streamable-http', upstream.url, { listen: { port: 0 } as any })), /needs authentication/);
      assert.throws(() => new StreamableHttpProxy(config(mock, 'streamable-http', upstream.url, {
        listen: { port: 0, host: '0.0.0.0', allowUnauthenticated: true } as any,
      })), /only allowed on a loopback/);
      assert.throws(() => new StreamableHttpProxy(config(mock, 'streamable-http', upstream.url, {
        listen: { port: 0, authToken: 'short' } as any,
      })), /at least 16 characters/);
    });
  });

  describe('Streamable HTTP metering', () => {
    let upstream: FakeUpstream;
    let proxy: StreamableHttpProxy;
    const post = (body: unknown, token = TOKEN_A, session?: string) => fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`, ...(session ? { 'Mcp-Session-Id': session } : {}),
      },
      body: JSON.stringify(body),
    });

    after(async () => { await proxy?.stop(); await upstream?.close(); });

    it('bills each call to the customer its bearer token maps to, ignoring _meta.customer_id', async () => {
      upstream = await startStreamableUpstream();
      proxy = new StreamableHttpProxy(config(mock, 'streamable-http', upstream.url));
      await proxy.start();
      const resA = await post(toolCall(1, 'search', { agent_id: 'agent_1', customer_id: 'cust_spoofed' }), TOKEN_A, 'up-sess');
      assert.equal(resA.status, 200);
      const resB = await post(toolCall(1, 'search'), TOKEN_B, 'up-sess');
      assert.equal(resB.status, 200);
      const state = await mock.waitFor((s) => s.events.filter((e) => e.metricName === 'mcp_server.tool_invocations').length === 2);
      const customers = state.events.filter((e) => e.metricName === 'mcp_server.tool_invocations').map((e) => e.customerId).sort();
      assert.deepEqual(customers, ['cust_a', 'cust_b']);
      await proxy.stop();
      await upstream.close();
    });

    it('meters every tools/call in a JSON-RPC batch (G303)', async () => {
      upstream = await startStreamableUpstream();
      proxy = new StreamableHttpProxy(config(mock, 'streamable-http', upstream.url));
      await proxy.start();
      const res = await post([toolCall(1, 'a'), toolCall(2, 'b'), { jsonrpc: '2.0', method: 'notifications/progress' }], TOKEN_A, 'sess-b');
      const body = (await res.json()) as unknown[];
      assert.equal(Array.isArray(body) && body.length, 2);
      const state = await mock.waitFor((s) => s.events.filter((e) => e.metricName === 'mcp_server.tool_invocations').length === 2);
      assert.deepEqual(state.events.filter((e) => e.metricName === 'mcp_server.tool_invocations').map((e) => e.toolName).sort(), ['a', 'b']);
      await proxy.stop();
      await upstream.close();
    });

    it('meters responses that arrive as an SSE stream split across chunks', async () => {
      upstream = await startStreamableUpstream({ streamResponses: true });
      proxy = new StreamableHttpProxy(config(mock, 'streamable-http', upstream.url));
      await proxy.start();
      const res = await post(toolCall(7, 'streamed'), TOKEN_A, 'sess-s');
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.match(await res.text(), /ran streamed/);
      const state = await mock.waitFor((s) => s.events.some((e) => e.toolName === 'streamed'));
      assert.equal(state.events.find((e) => e.toolName === 'streamed')?.executionStatus, 'SUCCESS');
      await proxy.stop();
      await upstream.close();
    });

    it('quota-checks every call in a batch against a real HTTP answer that takes 200 ms (G303, G304)', async () => {
      upstream = await startStreamableUpstream();
      proxy = new StreamableHttpProxy(config(mock, 'streamable-http', upstream.url, { aforo: { quotaEnforcement: true } as any }));
      await proxy.start();
      await mock.quota({ decision: 'DENY', reason: 'Over quota', delayMs: 200 });
      const denied = await post([toolCall(1, 'a'), toolCall(2, 'b')], TOKEN_A, 'sess-q');
      const deniedBody = (await denied.json()) as any[];
      assert.deepEqual(deniedBody.map((r: any) => r.error?.code), [-32000, -32000]);
      assert.equal(upstream.seen.filter((r) => r.method === 'POST').length, 0, 'nothing forwarded when every call is refused');
      const state = await mock.state();
      assert.equal(state.quotaChecks.length, 2);
      assert.ok(state.quotaChecks.every((q) => q.customerId === 'cust_a'));
      await proxy.stop();
      await upstream.close();
    });
  });

  describe('SSE transport: one session per connection (G305)', () => {
    let upstream: FakeUpstream;
    let proxy: SseProxy;
    before(async () => {
      upstream = await startLegacySseUpstream();
      proxy = new SseProxy(config(mock, 'sse', upstream.url));
      await proxy.start();
    });
    after(async () => { await proxy.stop(); await upstream.close(); });

    async function connect(token: string) {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/sse`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      const reader = res.body!;
      const first = await readEvents(reader, (ev) => ev.some((e) => e.event === 'endpoint'));
      return { endpoint: first.events.find((e) => e.event === 'endpoint')!.data, body: reader, cancel: first.cancel };
    }

    it('meters two clients that both use JSON-RPC id 1 as two calls in two sessions', async () => {
      const a = await connect(TOKEN_A);
      const b = await connect(TOKEN_B);
      assert.notEqual(a.endpoint, b.endpoint);
      for (const [client, token, tool] of [[a, TOKEN_A, 'tool_a'], [b, TOKEN_B, 'tool_b']] as const) {
        const res = await fetch(`http://127.0.0.1:${proxy.port}${client.endpoint}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(toolCall(1, tool)),
        });
        assert.equal(res.status, 202);
      }
      const state = await mock.waitFor((s) => s.events.filter((e) => e.metricName === 'mcp_server.tool_invocations').length === 2);
      const events = state.events.filter((e) => e.metricName === 'mcp_server.tool_invocations');
      assert.deepEqual(events.map((e) => `${e.toolName}:${e.customerId}`).sort(), ['tool_a:cust_a', 'tool_b:cust_b']);
      assert.notEqual(events[0].sessionId, events[1].sessionId);
      assert.ok(events.every((e) => e.executionStatus === 'SUCCESS' && e.metadata.responseBytes > 0));
      a.cancel(); b.cancel();
      await waitUntil(() => proxy.connectionCount === 0, 5000, 'connections closed');
    });

    it('refuses a POST to an endpoint no open connection owns', async () => {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/messages?sessionId=nope`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
        body: JSON.stringify(toolCall(1, 't')),
      });
      assert.equal(res.status, 404);
    });

    it('requires a bearer token on the SSE stream', async () => {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/sse`);
      assert.equal(res.status, 401);
    });
  });
});
