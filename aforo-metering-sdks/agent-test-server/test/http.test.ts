import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentTestServer } from '../src/server.js';
import { startHttp } from '../src/transport/http.js';

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port,
        path,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : {},
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
    if (payload) req.write(payload);
    req.end();
  });
}

test('POST /agent/session returns 200 with X-Session-Id + Location headers', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const res = await request(port, 'POST', '/agent/session', { agentId: 'agt_h_1' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.match(parsed.sessionId, /^sess_/);
    assert.equal(parsed.agentId, 'agt_h_1');
    assert.equal(res.headers['x-session-id'], parsed.sessionId);
    assert.equal(res.headers['location'], `/agent/session/${encodeURIComponent(parsed.sessionId)}`);
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('POST /agent/invoke → session round-trip: create, invoke, GET, DELETE', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const create = await request(port, 'POST', '/agent/session', { agentId: 'agt_rt' });
    const { sessionId } = JSON.parse(create.body);

    const invoke = await request(port, 'POST', '/agent/invoke', {
      sessionId,
      capability: 'summarize_url',
      input: { url: 'https://example.com', length: 'short' },
    });
    assert.equal(invoke.status, 200);
    const invBody = JSON.parse(invoke.body);
    assert.equal(invBody.capability, 'summarize_url');
    assert.equal(invBody.executionStatus, 'SUCCESS');

    const get = await request(port, 'GET', `/agent/session/${sessionId}`);
    assert.equal(get.status, 200);
    const view = JSON.parse(get.body);
    assert.equal(view.invocationCount, 1);
    assert.equal(view.status, 'active');

    const del = await request(port, 'DELETE', `/agent/session/${sessionId}`);
    assert.equal(del.status, 200);
    const finalState = JSON.parse(del.body);
    assert.equal(finalState.invocationCount, 1);
    assert.ok(finalState.endedAt);
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('POST /agent/invoke against ended session returns 410 session_ended', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const create = await request(port, 'POST', '/agent/session', { agentId: 'agt_e' });
    const { sessionId } = JSON.parse(create.body);
    await request(port, 'DELETE', `/agent/session/${sessionId}`);
    const invoke = await request(port, 'POST', '/agent/invoke', {
      sessionId,
      capability: 'summarize_url',
      input: { url: 'https://x' },
    });
    assert.equal(invoke.status, 410);
    const err = JSON.parse(invoke.body);
    assert.equal(err.error.code, 'session_ended');
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('POST /agent/invoke against unknown session returns 404 unknown_session', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const invoke = await request(port, 'POST', '/agent/invoke', {
      sessionId: 'sess_ghost',
      capability: 'summarize_url',
      input: { url: 'https://x' },
    });
    assert.equal(invoke.status, 404);
    const err = JSON.parse(invoke.body);
    assert.equal(err.error.code, 'unknown_session');
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('GET /health returns 200 with uptime + server info', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const res = await request(port, 'GET', '/health');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'UP');
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.match(body.server.name, /agent-test-server/);
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('GET /agent/capabilities returns the 5 canonical capabilities', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const res = await request(port, 'GET', '/agent/capabilities');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.capabilities.length, 5);
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('POST /agent/session with malformed JSON returns 400 malformed_body', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const res = await new Promise<Response>((resolve, reject) => {
      const req = http.request(
        {
          method: 'POST',
          host: '127.0.0.1',
          port,
          path: '/agent/session',
          headers: { 'Content-Type': 'application/json' },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () =>
            resolve({
              status: r.statusCode ?? 0,
              headers: r.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.write('{not valid json');
      req.end();
    });
    assert.equal(res.status, 400);
    const err = JSON.parse(res.body);
    assert.equal(err.error.code, 'malformed_body');
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('POST /agent/session body over maxBodyBytes returns 413 body_too_large', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server, maxBodyBytes: 256 });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const huge = { agentId: 'x'.repeat(2000) };
    const res = await request(port, 'POST', '/agent/session', huge);
    assert.equal(res.status, 413);
    const err = JSON.parse(res.body);
    assert.equal(err.error.code, 'body_too_large');
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('GET on unknown path returns 404 not_found', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const res = await request(port, 'GET', '/does/not/exist');
    assert.equal(res.status, 404);
    const err = JSON.parse(res.body);
    assert.equal(err.error.code, 'not_found');
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('GET /agent/session/{malformed} returns 400 malformed_body — decodeURIComponent guard', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    // %GG is a malformed URI escape — decodeURIComponent throws URIError.
    // Pre-hardening this leaked as an empty Node 500; now it's a
    // structured 400 malformed_body.
    const res = await request(port, 'GET', '/agent/session/%GG');
    assert.equal(res.status, 400);
    const err = JSON.parse(res.body);
    assert.equal(err.error.code, 'malformed_body');
    assert.match(err.error.message, /URI/i);
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('DELETE /agent/session/{malformed} returns 400 malformed_body', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const res = await request(port, 'DELETE', '/agent/session/%GG');
    assert.equal(res.status, 400);
    const err = JSON.parse(res.body);
    assert.equal(err.error.code, 'malformed_body');
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('unhandled server-side error returns structured 500 internal_error', async () => {
  const server = new AgentTestServer();
  // Monkey-patch a method to throw synchronously — simulates an unexpected
  // internal failure escaping the dispatch layer.
  const originalGetSession = server.getSession.bind(server);
  server.getSession = () => {
    throw new Error('simulated internal failure');
  };
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const create = await request(port, 'POST', '/agent/session', { agentId: 'agt_500' });
    const { sessionId } = JSON.parse(create.body);
    const get = await request(port, 'GET', `/agent/session/${sessionId}`);
    assert.equal(get.status, 500);
    const err = JSON.parse(get.body);
    assert.equal(err.error.code, 'internal_error');
    assert.match(err.error.message, /unhandled server error/i);
    assert.match(err.error.message, /simulated internal failure/i);
  } finally {
    server.getSession = originalGetSession;
    httpServer.close();
    server.dispose();
  }
});

test('POST /agent/invoke with input=string returns 400 missing_field', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const create = await request(port, 'POST', '/agent/session', { agentId: 'agt_inp' });
    const { sessionId } = JSON.parse(create.body);
    const res = await request(port, 'POST', '/agent/invoke', {
      sessionId,
      capability: 'summarize_url',
      input: 'not-an-object',
    });
    assert.equal(res.status, 400);
    const err = JSON.parse(res.body);
    assert.equal(err.error.code, 'missing_field');
    assert.match(err.error.message, /input must be an object/i);
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('POST /agent/invoke with input=array returns 400 missing_field', async () => {
  const server = new AgentTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const create = await request(port, 'POST', '/agent/session', { agentId: 'agt_inp_arr' });
    const { sessionId } = JSON.parse(create.body);
    const res = await request(port, 'POST', '/agent/invoke', {
      sessionId,
      capability: 'summarize_url',
      input: ['a', 'b'],
    });
    assert.equal(res.status, 400);
    const err = JSON.parse(res.body);
    assert.equal(err.error.code, 'missing_field');
  } finally {
    httpServer.close();
    server.dispose();
  }
});

test('startHttp rejects when the requested host:port is already in use', async () => {
  const server = new AgentTestServer();
  const first = await startHttp({ port: 0, host: '127.0.0.1', server });
  const { port } = first.address() as AddressInfo;

  try {
    await assert.rejects(
      startHttp({ port, host: '127.0.0.1', server }),
      /EADDRINUSE|listen/i,
    );
  } finally {
    first.close();
    server.dispose();
  }
});
