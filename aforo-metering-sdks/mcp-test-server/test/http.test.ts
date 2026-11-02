import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { McpTestServer } from '../src/server.js';
import { startHttp } from '../src/transport/http.js';

async function postJson(port: number, path: string, body: unknown): Promise<{
  status: number; body: string;
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
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getPlain(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'GET', host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('POST /mcp with tools/call returns a JSON-RPC 2.0 response envelope', async () => {
  const server = new McpTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const { status, body } = await postJson(port, '/mcp', {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'search_web', arguments: { query: 'aforo' } },
    });
    assert.equal(status, 200);
    const parsed = JSON.parse(body);
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, 42);
    assert.ok(parsed.result);
  } finally {
    httpServer.close();
  }
});

test('GET /health returns 200 ok — docker HEALTHCHECK path', async () => {
  const server = new McpTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const { status, body } = await getPlain(port, '/health');
    assert.equal(status, 200);
    assert.equal(body, 'ok');
  } finally {
    httpServer.close();
  }
});

test('POST /mcp with invalid JSON returns ParseError (-32700)', async () => {
  const server = new McpTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    // Send raw bad JSON — bypass the JSON.stringify helper.
    const bad = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          method: 'POST',
          host: '127.0.0.1',
          port,
          path: '/mcp',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        },
      );
      req.on('error', reject);
      req.write('{ not valid json');
      req.end();
    });
    assert.equal(bad.status, 400);
    const parsed = JSON.parse(bad.body);
    assert.equal(parsed.error.code, -32700);
  } finally {
    httpServer.close();
  }
});

test('GET on wrong path returns 404', async () => {
  const server = new McpTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const { status } = await getPlain(port, '/does-not-exist');
    assert.equal(status, 404);
  } finally {
    httpServer.close();
  }
});

// ── Production-hardening tests (2026-07-11 self-review) ─────────────────────

test('POST /mcp with JSON-RPC batch (array root) returns InvalidRequest (-32600)', async () => {
  const server = new McpTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const { status, body } = await postJson(port, '/mcp', [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    assert.equal(status, 400);
    const parsed = JSON.parse(body);
    assert.equal(parsed.error.code, -32600);
    assert.match(parsed.error.message, /batch/i);
  } finally {
    httpServer.close();
  }
});

test('POST /mcp body exceeding maxBodyBytes returns 413 with -32700 ParseError', async () => {
  const server = new McpTestServer();
  const httpServer = await startHttp({ port: 0, server, maxBodyBytes: 512 });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const huge = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'search_web',
      arguments: { query: 'x'.repeat(2000) }, // pushes body over 512 bytes
    }};
    const { status, body } = await postJson(port, '/mcp', huge);
    assert.equal(status, 413);
    const parsed = JSON.parse(body);
    assert.equal(parsed.error.code, -32700);
    assert.match(parsed.error.message, /body exceeds/i);
  } finally {
    httpServer.close();
  }
});

test('tools/call with params.arguments as a string returns InvalidParams (-32602)', async () => {
  const server = new McpTestServer();
  const httpServer = await startHttp({ port: 0, server });
  const { port } = httpServer.address() as AddressInfo;

  try {
    const { body } = await postJson(port, '/mcp', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'search_web', arguments: 'not-an-object' },
    });
    const parsed = JSON.parse(body);
    assert.equal(parsed.error.code, -32602);
    assert.match(parsed.error.message, /arguments/i);
  } finally {
    httpServer.close();
  }
});

test('startHttp rejects when the requested host:port is already in use', async () => {
  const server = new McpTestServer();
  // Bind explicitly to 127.0.0.1 so the same address is truly re-requested.
  // Binding to 0.0.0.0 then re-binding 127.0.0.1 has OS-dependent behavior
  // (works on some macOS versions, fails on Linux).
  const first = await startHttp({ port: 0, host: '127.0.0.1', server });
  const { port } = first.address() as AddressInfo;

  try {
    await assert.rejects(
      startHttp({ port, host: '127.0.0.1', server }),
      /EADDRINUSE|listen/i,
    );
  } finally {
    first.close();
  }
});
