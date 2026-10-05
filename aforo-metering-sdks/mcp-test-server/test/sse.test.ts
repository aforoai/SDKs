import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { McpTestServer } from '../src/server.js';
import { startSse } from '../src/transport/sse.js';
import { closeServer, waitFor } from './support/wait.js';

async function postWithSession(
  port: number,
  body: unknown,
  sessionId?: string,
): Promise<{ status: number; body: string; sessionId: string | undefined }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const req = http.request(
      { method: 'POST', host: '127.0.0.1', port, path: '/mcp', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          sessionId: (res.headers['mcp-session-id'] as string | undefined),
        }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('SSE POST /mcp mints a Mcp-Session-Id when the client omits one', async () => {
  const server = new McpTestServer();
  const httpServer = await startSse({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const res = await postWithSession(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    assert.equal(res.status, 200);
    assert.ok(res.sessionId, 'server must echo Mcp-Session-Id header');
    assert.match(res.sessionId ?? '', /^[0-9a-f-]{36}$/); // UUID shape
  } finally {
    await closeServer(httpServer);
  }
});

test('SSE POST /mcp echoes the client-provided Mcp-Session-Id header', async () => {
  const server = new McpTestServer();
  const httpServer = await startSse({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const preset = 'client-owned-session-abc';
    const res = await postWithSession(port, {
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
    }, preset);
    assert.equal(res.sessionId, preset);
  } finally {
    await closeServer(httpServer);
  }
});

test('SSE GET /mcp opens a text/event-stream that receives fanout on POST', async () => {
  const server = new McpTestServer();
  const httpServer = await startSse({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;
  const sessionId = 'fanout-session-1';

  try {
    // Open the SSE stream.
    const streamOpen = new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          method: 'GET',
          host: '127.0.0.1',
          port,
          path: '/mcp',
          headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId },
        },
        (res) => resolve(res),
      );
      req.on('error', reject);
      req.end();
    });
    const streamRes = await streamOpen;
    assert.equal(streamRes.headers['content-type'], 'text/event-stream');

    const received: string[] = [];
    streamRes.on('data', (c: Buffer) => received.push(c.toString('utf8')));

    // No wait needed before the POST: the server registers the stream in the
    // same synchronous block that writes the response headers, so having the
    // headers in hand means the stream is already registered.

    // POST a request that will fan out over the stream.
    await postWithSession(port, {
      jsonrpc: '2.0', id: 99, method: 'tools/list',
    }, sessionId);

    // The fan-out is written after the POST response ends, on a different
    // socket — wait for it to arrive rather than for a fixed delay.
    const joined = await waitFor(
      () => (/"id":99/.test(received.join('')) ? received.join('') : undefined),
      () => `fan-out of id 99 on the SSE stream; received so far: ${JSON.stringify(received.join(''))}`,
    );
    assert.match(joined, /event: message/);
    assert.match(joined, /"id":99/);
  } finally {
    await closeServer(httpServer);
  }
});

// ── Production-hardening tests (2026-07-11 self-review) ─────────────────────

test('SSE POST /mcp with JSON-RPC batch returns InvalidRequest (-32600)', async () => {
  const server = new McpTestServer();
  const httpServer = await startSse({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const res = await postWithSession(port, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    assert.equal(res.status, 400);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, -32600);
    assert.match(parsed.error.message, /batch/i);
  } finally {
    await closeServer(httpServer);
  }
});

test('SSE fanout survives a client that disconnects — no unhandled error, other streams keep receiving', async () => {
  const server = new McpTestServer();
  const httpServer = await startSse({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;
  const sessionId = 'disconnect-session';

  const uncaught: Error[] = [];
  const onUncaught = (err: Error) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);

  try {
    // Open TWO SSE streams so we can prove the survivor keeps receiving
    // even after the other one goes dark.
    const openStream = () => new Promise<http.IncomingMessage>((resolve, reject) => {
      const r = http.request({
        method: 'GET', host: '127.0.0.1', port, path: '/mcp',
        headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId },
      }, resolve);
      r.on('error', reject);
      r.end();
    });

    const a = await openStream();
    const b = await openStream();
    const bReceived: string[] = [];
    b.on('data', (c: Buffer) => bReceived.push(c.toString('utf8')));

    const seenOnB = (id: number) => new RegExp(`"id":${id}\\b`).test(bReceived.join(''));

    // Kill stream A abruptly. Whether the server has noticed by the time the
    // POST lands is a race the server must survive either way — which is the
    // point of this test — so there is nothing to wait for here.
    a.destroy();

    // Send a request — should fan out to B without server crash.
    await postWithSession(port, {
      jsonrpc: '2.0', id: 42, method: 'ping',
    }, sessionId);
    await waitFor(
      () => seenOnB(42),
      () => `surviving stream to receive fan-out of id 42; got: ${JSON.stringify(bReceived.join(''))}`,
    );

    // "No uncaughtException" is a negative assertion: a write to the dead
    // stream fails asynchronously. Rather than sleep and hope, push a second
    // request through the same path; once ITS fan-out has arrived on B, any
    // error from the first write to A has had a full round trip to surface.
    await postWithSession(port, {
      jsonrpc: '2.0', id: 43, method: 'ping',
    }, sessionId);
    await waitFor(
      () => seenOnB(43),
      () => `surviving stream to receive sentinel fan-out of id 43; got: ${JSON.stringify(bReceived.join(''))}`,
    );

    assert.equal(uncaught.length, 0, `no uncaughtException expected; got: ${uncaught.map((e) => e.message).join('; ')}`);
  } finally {
    process.off('uncaughtException', onUncaught);
    await closeServer(httpServer);
  }
});
