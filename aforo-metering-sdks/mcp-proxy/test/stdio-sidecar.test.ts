/**
 * @file The stdio sidecar through its CLI, against the mock ingestor: the
 * child never sees AFORO_* (G301), JSON-RPC batches are metered (G303),
 * messages keep their order while a quota check is in flight, and the health
 * file exists only while the proxy serves (G306).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { startMockIngestor, waitUntil, type MockIngestor } from './support/mock-ingestor.js';

const CLI = resolve(__dirname, '../bin/aforo-mcp-proxy.js');

/** A child MCP server: answers every request (or batch) and reports a few env values. */
function writeChild(dir: string): string {
  const path = join(dir, 'child.js');
  writeFileSync(path, `
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      const env = { key: process.env.AFORO_API_KEY ?? null, tenant: process.env.AFORO_TENANT_ID ?? null, passed: process.env.SERVER_TOKEN ?? null };
      const answer = (m) => m.id === undefined ? undefined : ({ jsonrpc: '2.0', id: m.id, result: { method: m.method, env } });
      const out = Array.isArray(msg) ? msg.map(answer).filter(Boolean) : answer(msg);
      if (out !== undefined && !(Array.isArray(out) && out.length === 0)) process.stdout.write(JSON.stringify(out) + '\\n');
    });
  `);
  return path;
}

interface Running {
  proc: ChildProcess;
  lines: string[];
  send(msg: unknown): void;
  stop(): Promise<void>;
}

function startProxy(mock: MockIngestor, child: string, extraArgs: string[] = [], extraEnv: Record<string, string> = {}): Running {
  const proc = spawn(process.execPath, [CLI, '--transport', 'stdio', '--command', process.execPath, '--args', child, ...extraArgs], {
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
      AFORO_TENANT_ID: 't', AFORO_PRODUCT_ID: 'p', AFORO_API_KEY: 'sk_secret_key', AFORO_INGESTOR_URL: mock.url,
      AFORO_FLUSH_INTERVAL_MS: '30', AFORO_HEARTBEAT_INTERVAL_MS: '0',
      SERVER_TOKEN: 'srv_token', ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines: string[] = [];
  createInterface({ input: proc.stdout! }).on('line', (l) => lines.push(l));
  return {
    proc, lines,
    send: (msg) => proc.stdin!.write(JSON.stringify(msg) + '\n'),
    stop: () => new Promise<void>((done) => {
      if (proc.exitCode !== null) return done();
      proc.once('exit', () => done());
      proc.kill('SIGTERM');
    }),
  };
}

describe('stdio sidecar (CLI)', () => {
  let mock: MockIngestor;
  let dir: string;
  let child: string;
  before(async () => {
    mock = await startMockIngestor();
    dir = mkdtempSync(join(tmpdir(), 'aforo-stdio-'));
    child = writeChild(dir);
  });
  after(async () => { await mock.close(); });
  beforeEach(async () => { await mock.reset(); });

  it('the child never sees AFORO_* variables; --pass-env hands it named ones (G301)', async () => {
    const p = startProxy(mock, child, ['--customer-id', 'cust_1', '--pass-env', 'SERVER_TOKEN,AFORO_API_KEY']);
    try {
      p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await waitUntil(() => p.lines.length >= 1);
      const env = JSON.parse(p.lines[0]).result.env;
      assert.deepEqual(env, { key: null, tenant: null, passed: 'srv_token' });
    } finally {
      await p.stop();
    }
  });

  it('meters each tools/call in a JSON-RPC batch (G303)', async () => {
    const p = startProxy(mock, child, ['--customer-id', 'cust_1']);
    try {
      p.send([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a', _meta: { agent_id: 'agent_1' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'b', _meta: { agent_id: 'agent_1' } } },
      ]);
      await waitUntil(() => p.lines.length >= 1);
      assert.equal(JSON.parse(p.lines[0]).length, 2);
      const state = await mock.waitFor((s) => s.events.filter((e) => e.metricName === 'mcp_server.tool_invocations').length === 2);
      const events = state.events.filter((e) => e.metricName === 'mcp_server.tool_invocations');
      assert.deepEqual(events.map((e) => e.toolName).sort(), ['a', 'b']);
      assert.ok(events.every((e) => e.customerId === 'cust_1'));
    } finally {
      await p.stop();
    }
  });

  it('keeps message order while a quota check is in flight', async () => {
    await mock.quota({ decision: 'ALLOW', delayMs: 150 });
    const p = startProxy(mock, child, ['--customer-id', 'cust_1', '--quota-enforcement']);
    try {
      p.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', _meta: { agent_id: 'agent_1' } } });
      p.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
      await waitUntil(() => p.lines.length >= 2);
      assert.deepEqual(p.lines.map((l) => JSON.parse(l).id), [1, 2]);
    } finally {
      await p.stop();
    }
  });

  it('refuses to start without a customer source', async () => {
    const p = startProxy(mock, child);
    const code = await new Promise<number | null>((done) => p.proc.once('exit', (c) => done(c)));
    assert.equal(code, 1);
  });

  it('keeps the health file while serving and removes it on shutdown (G306)', async () => {
    const health = join(dir, 'alive');
    const p = startProxy(mock, child, ['--customer-id', 'cust_1', '--health-file', health]);
    try {
      await waitUntil(() => existsSync(health), 5000, 'health file written');
    } finally {
      await p.stop();
    }
    assert.equal(existsSync(health), false);
  });
});
