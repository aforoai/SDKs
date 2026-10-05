import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentTestServer } from '../src/server.js';
import { startSse } from '../src/transport/sse.js';
import { closeServer, waitFor } from './support/wait.js';

async function postJson(port: number, path: string, body: unknown): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port,
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

interface SseListener {
  events: { event: string; data: string }[];
  wait: (n: number) => Promise<void>;
  close: () => void;
}

function openSseStream(port: number, path: string): Promise<SseListener> {
  return new Promise((resolve, reject) => {
    const events: { event: string; data: string }[] = [];
    const waiters: Array<{ target: number; resolve: () => void }> = [];

    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port,
        path,
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE open failed: status=${res.statusCode}`));
          return;
        }
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = frame.split('\n');
            let ev = 'message';
            let data = '';
            for (const l of lines) {
              if (l.startsWith(':')) continue; // comment / heartbeat
              if (l.startsWith('event:')) ev = l.slice(6).trim();
              if (l.startsWith('data:')) data = l.slice(5).trim();
            }
            if (data !== '') {
              events.push({ event: ev, data });
              for (const w of [...waiters]) {
                if (events.length >= w.target) w.resolve();
              }
            }
          }
        });
        resolve({
          events,
          wait: (n: number) =>
            new Promise<void>((r) => {
              if (events.length >= n) return r();
              waiters.push({ target: n, resolve: r });
            }),
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('GET /agent/stream/{id} sees invocation events fanned out', async () => {
  const server = new AgentTestServer();
  const sseServer = await startSse({ port: 0, server });
  const { port } = sseServer.address() as AddressInfo;

  try {
    const create = await postJson(port, '/agent/session', { agentId: 'agt_sse' });
    const { sessionId } = JSON.parse(create.body);
    const listener = await openSseStream(port, `/agent/stream/${sessionId}`);

    // No wait needed before invoking: the server subscribes the stream in the
    // same synchronous block that writes the response headers, and
    // openSseStream resolves only once those headers have arrived.

    await postJson(port, '/agent/invoke', {
      sessionId,
      capability: 'rank_sources',
      input: { query: 'q', sources: ['a', 'b', 'c'] },
    });

    await waitFor(
      () => listener.events.length >= 1,
      () => 'an SSE event on the session stream',
    );
    assert.equal(listener.events[0].event, 'invocation');
    const payload = JSON.parse(listener.events[0].data);
    assert.equal(payload.sessionId, sessionId);
    assert.equal(payload.capability, 'rank_sources');

    listener.close();
  } finally {
    await closeServer(sseServer);
    server.dispose();
  }
});

test('GET /agent/stream/{id} sees session_end event on DELETE', async () => {
  const server = new AgentTestServer();
  const sseServer = await startSse({ port: 0, server });
  const { port } = sseServer.address() as AddressInfo;

  try {
    const create = await postJson(port, '/agent/session', { agentId: 'agt_end' });
    const { sessionId } = JSON.parse(create.body);
    // Already subscribed once the headers are in — see the test above.
    const listener = await openSseStream(port, `/agent/stream/${sessionId}`);

    // DELETE via a manual request — no helper for DELETE JSON.
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          method: 'DELETE',
          host: '127.0.0.1',
          port,
          path: `/agent/session/${sessionId}`,
        },
        (res) => {
          res.on('data', () => { /* drain */ });
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end();
    });

    await waitFor(
      () => listener.events.length >= 1,
      () => 'an SSE event on the session stream',
    );
    assert.equal(listener.events[0].event, 'session_end');
    const parsed = JSON.parse(listener.events[0].data);
    assert.equal(parsed.sessionId, sessionId);

    listener.close();
  } finally {
    await closeServer(sseServer);
    server.dispose();
  }
});

test('GET /health returns 200 UP', async () => {
  const server = new AgentTestServer();
  const sseServer = await startSse({ port: 0, server });
  const { port } = sseServer.address() as AddressInfo;

  try {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ method: 'GET', host: '127.0.0.1', port, path: '/health' }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () =>
          resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, 'UP');
  } finally {
    await closeServer(sseServer);
    server.dispose();
  }
});
