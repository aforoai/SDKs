/**
 * @file Regression tests for the SDK review of 2026-11-09 (mcp-proxy findings
 * 1, 2, 5-9, 11-13 and rules R3/R4).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolCallTracker } from '../src/interceptor/ToolCallTracker.js';
import { extractToolCall } from '../src/interceptor/MessageInterceptor.js';
import { StreamableHttpProxy } from '../src/proxy/StreamableHttpProxy.js';
import { SseProxy } from '../src/proxy/SseProxy.js';
import { loadConfig } from '../src/config.js';
import type { JsonRpcRequest, ProxyConfig, ProxyUsageEvent } from '../src/types.js';
import { startMockIngestor, type MockIngestor } from './support/mock-ingestor.js';

const CLI = resolve(__dirname, '../bin/aforo-mcp-proxy.js');
/** Usage events only: the mock ingestor also records session heartbeats. */
const usage = (events: Array<Record<string, any>>) => events.filter((e) => e.metricName !== 'system.session.heartbeat');
const README = resolve(__dirname, '../../README.md');

class StubBuffer {
  events: ProxyUsageEvent[] = [];
  drops: Array<{ reason: string }> = [];
  push(e: ProxyUsageEvent) { this.events.push(e); }
  recordDrop(_e: ProxyUsageEvent[], reason: string) { this.drops.push({ reason }); }
}
const stubHeartbeat = { activeSessionId: 'hb', startSession() {}, async stopSession() {} };
function tracker(extra: Record<string, unknown> = {}) {
  const buffer = new StubBuffer();
  const t = new ToolCallTracker({ buffer: buffer as any, heartbeat: stubHeartbeat as any, tenantId: 't', productId: 'p',
    transport: 'stdio', customerId: 'cust_1', ...extra });
  return { t, buffer };
}

/**
 * Spawn the CLI in stdio mode; `input` is written to its stdin, which closes
 * after `holdMs`, or once `untilLines` lines have come back on stdout
 * (whichever is later, capped at 60 s), so a loaded machine cannot cut it short.
 */
function runCli(args: string[], env: Record<string, string>, input: string, holdMs: number, untilLines = 0): Promise<{ stdout: string; stderr: string }> {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [CLI, '--transport', 'stdio', ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', AFORO_TENANT_ID: 't', AFORO_PRODUCT_ID: 'p',
        AFORO_CUSTOMER_ID: 'cust_1', AFORO_FLUSH_INTERVAL_MS: '30', AFORO_HEARTBEAT_INTERVAL_MS: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = []; const err: Buffer[] = [];
    proc.stdout!.on('data', (c) => out.push(c));
    proc.stderr!.on('data', (c) => err.push(c));
    proc.stdin!.write(input);
    const started = Date.now();
    const close = () => {
      const lines = Buffer.concat(out).toString('utf8').split('\n').length - 1;
      if ((Date.now() - started >= holdMs && lines >= untilLines) || Date.now() - started > 60_000) proc.stdin!.end();
      else setTimeout(close, 50);
    };
    setTimeout(close, holdMs);
    proc.once('exit', () => done({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

describe('SDK review fixes (mcp-proxy)', () => {
  let mock: MockIngestor;
  let dir: string;
  before(async () => { mock = await startMockIngestor(); dir = mkdtempSync(join(tmpdir(), 'aforo-review-')); });
  after(async () => { await mock.close(); });

  it('#1 stdio keeps multi-byte UTF-8 intact in both directions across pipe chunks', async () => {
    const child = join(dir, 'echo-utf8.js');
    writeFileSync(child, `
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.on('line', (line) => { const m = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: m.params.arguments.text + '|' + '日本語🙂'.repeat(60000) }] } }) + '\\n'); });
    `);
    const sentText = 'Grüße 🙂 テスト'.repeat(30000); // ~ 600 KB, written in one go: the pipe splits it
    const req = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: sentText } } };
    const { stdout } = await runCli(['--command', process.execPath, '--arg', child],
      { AFORO_API_KEY: 'k_test', AFORO_INGESTOR_URL: mock.url }, JSON.stringify(req) + '\n', 300, 1);
    const text: string = JSON.parse(stdout.trim().split('\n')[0]).result.content[0].text;
    assert.equal(text.includes('�'), false, 'no replacement characters');
    assert.equal(text, sentText + '|' + '日本語🙂'.repeat(60000));
  });

  it('#2 a non-string tool name or agent_id is never copied into the event', () => {
    const call = extractToolCall({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: { x: 1 }, _meta: { agent_id: ['a'] } } } as unknown as JsonRpcRequest)!;
    assert.equal(call.toolName, 'unknown');
    assert.equal(call.agentId, 'unknown');
    const { t, buffer } = tracker();
    t.trackRequest({ requestId: 1, toolName: { x: 1 } as any, agentId: { x: 1 } as any }, 's');
    t.trackResponse({ requestId: 1, hasError: false, responseBytes: 1 }, 's');
    assert.equal(typeof buffer.events[0].toolName, 'string');
    assert.equal(buffer.events[0].agentId, 'unknown');
    t.shutdown();
  });

  it('#6 a JSON-RPC id reused while earlier calls wait meters every call once', () => {
    const { t, buffer } = tracker();
    for (const name of ['a', 'b', 'c']) t.trackRequest({ requestId: 5, toolName: name, agentId: 'x' }, 's');
    for (let i = 0; i < 4; i++) t.trackResponse({ requestId: 5, hasError: false, responseBytes: 1 }, 's');
    assert.deepEqual(buffer.events.map((e) => e.toolName), ['a', 'b', 'c']);
    assert.equal(t.inFlightCount, 0);
    t.shutdown();
  });

  it('#7 an unusable client agent_id is billed as "unknown", not dropped; #8 --agent-id still wins', () => {
    const { t, buffer } = tracker();
    assert.equal(t.trackRequest({ requestId: 1, toolName: 't', agentId: 'a'.repeat(37) }, 's'), true);
    assert.equal(t.trackRequest({ requestId: 2, toolName: 't', agentId: '   ' }, 's'), true);
    t.trackResponse({ requestId: 1, hasError: false, responseBytes: 1 }, 's');
    t.trackResponse({ requestId: 2, hasError: false, responseBytes: 1 }, 's');
    assert.deepEqual(buffer.events.map((e) => e.agentId), ['unknown', 'unknown']);
    assert.equal(buffer.drops.length, 0);
    t.shutdown();
    const withOverride = tracker({ agentIdOverride: 'agent_cfg' });
    withOverride.t.trackRequest({ requestId: 1, toolName: 't', agentId: 'agent_client' }, 's');
    withOverride.t.trackResponse({ requestId: 1, hasError: false, responseBytes: 1 }, 's');
    assert.equal(withOverride.buffer.events[0].agentId, 'agent_cfg');
    withOverride.t.shutdown();
  });

  it('#9 notifications/cancelled meters the waiting call as CANCELLED, once', async () => {
    const { t, buffer } = tracker();
    t.trackRequest({ requestId: 9, toolName: 'long_job', agentId: 'a' }, 's');
    assert.equal(t.trackCancellation(9, 's'), true);
    assert.equal(t.trackResponse({ requestId: 9, hasError: false, responseBytes: 1 }, 's'), false);
    assert.deepEqual(buffer.events.map((e) => e.executionStatus), ['CANCELLED']);
    t.shutdown();

    // Through the CLI: a spec-compliant server sends no response for the cancelled call.
    await mock.reset();
    const child = join(dir, 'cancel.js');
    writeFileSync(child, `
      const rl = require('readline').createInterface({ input: process.stdin });
      const pending = new Map();
      rl.on('line', (line) => { const m = JSON.parse(line);
        if (m.method === 'notifications/cancelled') { clearTimeout(pending.get(m.params.requestId)); return; }
        if (m.id !== undefined) pending.set(m.id, setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n'), 400)); });
    `);
    const input = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'long_job' } }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }) + '\n';
    await runCli(['--command', process.execPath, '--arg', child], { AFORO_API_KEY: 'k_test', AFORO_INGESTOR_URL: mock.url }, input, 800);
    const state = await mock.waitFor((s) => usage(s.events).length >= 1);
    assert.deepEqual(usage(state.events).map((e) => `${e.toolName}/${e.executionStatus}`), ['long_job/CANCELLED']);
  });

  it('R3 an executionDurationMs beyond the Java int range is left off; the event is still sent', () => {
    const { t, buffer } = tracker({ staleCallTimeoutMs: 1000 });
    t.trackRequest({ requestId: 1, toolName: 't', agentId: 'a' }, 's');
    t.cleanupStale(Date.now() + 3_000_000_000);
    assert.equal(buffer.events.length, 1);
    assert.equal('executionDurationMs' in buffer.events[0], false);
    t.shutdown();
  });

  describe('#5 a forward the upstream never answered is not billed', () => {
    let upstream: Server;
    let upstreamUrl: string;
    let executed = 0;
    before(async () => {
      upstream = createServer((req, res) => {
        let body = ''; req.on('data', (c) => (body += c)).on('end', () => {
          const url = new URL(req.url ?? '/', 'http://u');
          if (req.method === 'GET' && url.pathname === '/sse') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('event: endpoint\ndata: /messages?sessionId=s1\n\n');
            return;
          }
          if (url.pathname === '/messages') { res.writeHead(500).end('boom'); return; }
          if (req.headers['mcp-session-id'] === 'expired') { res.writeHead(404).end('Session not found'); return; }
          executed++;
          const msg = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [] } }));
        });
      });
      await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
      upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    });
    after(() => new Promise<void>((r) => { upstream.closeAllConnections?.(); upstream.close(() => r()); }));

    const cfg = (transport: 'sse' | 'streamable-http', url: string): ProxyConfig => ({
      transport, upstream: url, handleSignals: false,
      listen: { port: 0, host: '127.0.0.1', allowUnauthenticated: true },
      aforo: { tenantId: 't', productId: 'p', apiKey: 'k_test', ingestorUrl: mock.url, customerId: 'cust_1',
        flushIntervalMs: 20, heartbeatIntervalMs: 0, responseTimeoutMs: 2000 },
    } as ProxyConfig);
    const call = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search', arguments: {} } });

    it('Streamable HTTP: a 404 for an expired session and a refused connection bill nothing; the retry bills once', async () => {
      await mock.reset();
      const proxy = new StreamableHttpProxy(cfg('streamable-http', `${upstreamUrl}/mcp`));
      await proxy.start();
      const post = (session: string, id: number) => fetch(`http://127.0.0.1:${proxy.port}/mcp`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-session-id': session }, body: call(id) });
      assert.equal((await post('expired', 1)).status, 404);
      assert.equal((await post('fresh', 2)).status, 200);
      await proxy.stop(); // anything still waiting would be metered CANCELLED here
      const dead = new StreamableHttpProxy(cfg('streamable-http', 'http://127.0.0.1:9/mcp'));
      await dead.start();
      assert.equal((await fetch(`http://127.0.0.1:${dead.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': 'x' }, body: call(3) })).status, 502);
      await dead.stop();
      await mock.waitFor((s) => usage(s.events).length >= 1);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(executed, 1);
      assert.deepEqual(usage((await mock.state()).events).map((e) => `${e.sessionId}/${e.executionStatus}`), ['fresh/SUCCESS']);
    });

    it('SSE: an HTTP error from the upstream message endpoint bills nothing', async () => {
      await mock.reset();
      const proxy = new SseProxy(cfg('sse', `${upstreamUrl}/sse`));
      await proxy.start();
      const stream = await fetch(`http://127.0.0.1:${proxy.port}/sse`);
      const reader = stream.body!.getReader();
      let text = '';
      while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
      const endpoint = /data: (\S+)/.exec(text)![1];
      const res = await fetch(`http://127.0.0.1:${proxy.port}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: call(1) });
      assert.equal(res.status, 500);
      await reader.cancel();
      await proxy.stop();
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(usage((await mock.state()).events), []);
    });
  });

  it('#11/#12/#13 CLI: --api-key with stdio warns, AFORO_COMPRESSION=none sends plain JSON, --debug logs "Flushed events"', async () => {
    await mock.reset();
    const child = join(dir, 'answer.js');
    writeFileSync(child, `require('readline').createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n'); });`);
    let input = '';
    for (let i = 1; i <= 12; i++) input += JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'search_tool_name', arguments: {} } }) + '\n';
    const { stderr } = await runCli(['--command', process.execPath, '--arg', child, '--api-key', '  k_test  ', '--debug'],
      { AFORO_INGESTOR_URL: mock.url, AFORO_COMPRESSION: 'none', AFORO_FLUSH_INTERVAL_MS: '300' }, input, 1000, 12);
    assert.match(stderr, /--api-key puts the Aforo API key on the proxy's command line/);
    assert.match(stderr, /"msg":"Flushed events"/);
    const state = await mock.waitFor((s) => usage(s.events).length >= 12);
    const batches = (state.requests as Array<Record<string, any>>).filter((r) => r.eventCount > 0);
    assert.ok(batches.some((r) => r.bytes >= 1024), 'a batch big enough to be gzipped by default');
    assert.ok(batches.every((r) => r.contentEncoding === null), 'compression none: plain JSON');
    assert.ok(state.requests.every((r) => r.apiKeyPresent));
  });

  it('#12/R4 loadConfig reads compression from config, CLI and env, and trims the API key', () => {
    const base = { transport: 'stdio' as const, command: 'x', aforo: { tenantId: 't', productId: 'p', apiKey: ' k_test\n', ingestorUrl: 'https://a.example', customerId: 'c' } };
    const saved = { ...process.env };
    try {
      delete process.env.AFORO_API_KEY; delete process.env.AFORO_COMPRESSION;
      assert.equal(loadConfig(base).aforo.apiKey, 'k_test');
      assert.equal(loadConfig(base).aforo.compression, undefined);
      assert.equal(loadConfig({ ...base, aforo: { ...base.aforo, compression: 'none' } }).aforo.compression, 'none');
      process.env.AFORO_COMPRESSION = 'NONE';
      assert.equal(loadConfig(base).aforo.compression, 'none');
      process.env.AFORO_COMPRESSION = 'brotli';
      assert.throws(() => loadConfig(base), /compression must be "gzip" or "none"/);
    } finally {
      process.env = saved;
    }
  });

  it('#13 the README Claude Desktop config starts (it has a customer source)', () => {
    const blocks = readFileSync(README, 'utf8').split('```json').slice(1).map((b) => b.split('```')[0]);
    const desktop = JSON.parse(blocks.find((b) => b.includes('"transport": "stdio"'))!);
    const file = join(dir, 'aforo-proxy.json');
    writeFileSync(file, JSON.stringify(desktop));
    const saved = process.env.AFORO_API_KEY;
    process.env.AFORO_API_KEY = 'sk_live_xxx';
    try {
      const config = loadConfig({ config: file });
      assert.equal(config.aforo.customerId, 'cust_acme');
      assert.equal('apiKey' in desktop.aforo, false, 'the key is not in the file');
    } finally {
      if (saved === undefined) delete process.env.AFORO_API_KEY; else process.env.AFORO_API_KEY = saved;
    }
  });
});
