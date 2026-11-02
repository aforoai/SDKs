/**
 * @file The SSE proxy's forward of a client POST to the upstream MCP server
 * has a deadline and a size cap: an upstream that never answers the POST, or
 * answers with an endless body, must not hold the client's request (and the
 * proxy's memory) forever.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SseProxy } from '../src/proxy/SseProxy.js';
import { StreamableHttpProxy } from '../src/proxy/StreamableHttpProxy.js';
import { UPSTREAM_MAX_RESPONSE_BYTES } from '../src/util/upstream.js';
import type { ProxyConfig } from '../src/types.js';
import { startMockIngestor, type MockIngestor } from './support/mock-ingestor.js';

const TOKEN = 'token-for-customer-a-0001';

/** Legacy SSE upstream whose POST /messages misbehaves on request. */
async function misbehavingUpstream(mode: { kind: 'hang' } | { kind: 'huge' }) {
  const open = new Set<ServerResponse>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://u');
    if (req.method === 'GET' && url.pathname === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages?sessionId=s1\n\n');
      open.add(res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      req.resume();
      open.add(res);
      if (mode.kind === 'hang') return; // never answers
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (sent <= UPSTREAM_MAX_RESPONSE_BYTES + chunk.length) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        res.end();
      };
      pump();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/sse`,
    close: () => new Promise<void>((r) => { for (const s of open) s.destroy(); server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

function config(mock: MockIngestor, upstream: string, responseTimeoutMs: number): ProxyConfig {
  return {
    transport: 'sse',
    upstream,
    handleSignals: false,
    listen: { port: 0, host: '127.0.0.1', authTokens: { [TOKEN]: 'cust_a' } },
    aforo: {
      tenantId: 't', productId: 'p', apiKey: 'sk_test', ingestorUrl: mock.url,
      flushIntervalMs: 30, heartbeatIntervalMs: 0, responseTimeoutMs,
    },
  } as ProxyConfig;
}

async function openEndpoint(port: number): Promise<{ endpoint: string; cancel: () => void }> {
  const res = await fetch(`http://127.0.0.1:${port}/sse`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' } });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  let text = '';
  while (!/event: endpoint\ndata: (.*)\n\n/.test(text)) {
    const { done, value } = await reader.read();
    if (done) throw new Error('stream ended before the endpoint event');
    text += new TextDecoder().decode(value);
  }
  return { endpoint: /event: endpoint\ndata: (.*)\n\n/.exec(text)![1], cancel: () => void reader.cancel().catch(() => undefined) };
}

const toolCall = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: {}, _meta: { agent_id: 'a1' } } });

describe('SSE proxy upstream POST', () => {
  let mock: MockIngestor;
  before(async () => { mock = await startMockIngestor(); });
  after(async () => { await mock.close(); });

  it('answers 504 when the upstream never answers the POST, within the response timeout', async () => {
    const upstream = await misbehavingUpstream({ kind: 'hang' });
    const proxy = new SseProxy(config(mock, upstream.url, 300));
    await proxy.start();
    try {
      const conn = await openEndpoint(proxy.port!);
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${proxy.port}${conn.endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: toolCall,
        signal: AbortSignal.timeout(10_000), // hang guard for the test itself
      });
      assert.equal(res.status, 504);
      assert.ok(Date.now() - started < 5_000, 'answered at the response timeout, not later');
      conn.cancel();
    } finally {
      await proxy.stop();
      await upstream.close();
    }
  });

  it('answers 502 when the upstream answer is larger than the cap, without buffering all of it', async () => {
    const upstream = await misbehavingUpstream({ kind: 'huge' });
    const proxy = new SseProxy(config(mock, upstream.url, 30_000));
    await proxy.start();
    try {
      const conn = await openEndpoint(proxy.port!);
      const res = await fetch(`http://127.0.0.1:${proxy.port}${conn.endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: toolCall,
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(res.status, 502);
      assert.match(await res.text(), /too large/);
      conn.cancel();
    } finally {
      await proxy.stop();
      await upstream.close();
    }
  });

  it('Streamable HTTP: answers 504 when the upstream never answers the POST (same deadline)', async () => {
    const open = new Set<ServerResponse>();
    const server = createServer((req, res) => { req.resume(); open.add(res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const upstreamUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const proxy = new StreamableHttpProxy({ ...config(mock, upstreamUrl, 300), transport: 'streamable-http' } as ProxyConfig);
    await proxy.start();
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: toolCall,
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(res.status, 504);
      // A session DELETE forwarded to the same silent upstream is bounded the same way.
      const del = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': 'sess-1', Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(del.status, 504);
    } finally {
      await proxy.stop();
      for (const s of open) s.destroy();
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    }
  });
});
