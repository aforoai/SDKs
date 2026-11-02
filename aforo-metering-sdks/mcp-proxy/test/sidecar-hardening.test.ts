/**
 * @file Sidecar hardening (wave 5, W5.5): child environment (G301), batches
 * through the shared client-message path (G303), quota timeout / ALLOW cache /
 * fail-closed against the mock ingestor (G304), bounded tables, the health
 * file and the container image (G306), and config loading.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildChildEnv } from '../src/util/childEnv.js';
import { BoundedMap } from '../src/util/BoundedMap.js';
import { HealthFile } from '../src/util/HealthFile.js';
import { SseParser } from '../src/util/sse.js';
import { checkBaseUrl as assertIngestorUrl } from '../src/transport-core/core.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { QuotaGuard } from '../src/interceptor/QuotaGuard.js';
import { parseJsonRpc } from '../src/interceptor/MessageInterceptor.js';
import { BaseProxy } from '../src/proxy/BaseProxy.js';
import { loadConfig } from '../src/config.js';
import type { ProxyConfig } from '../src/types.js';
import { startMockIngestor, type MockIngestor } from './support/mock-ingestor.js';

describe('child environment (G301)', () => {
  const parent = {
    PATH: '/usr/bin', HOME: '/home/op', LANG: 'en_US.UTF-8', LC_ALL: 'C',
    AFORO_API_KEY: 'sk_secret', AFORO_TENANT_ID: 't', aforo_lower: 'x',
    GITHUB_TOKEN: 'ghp_secret', DATABASE_URL: 'postgres://secret',
  };

  it('passes only the base set: never AFORO_* and never other secrets', () => {
    const { env } = buildChildEnv(parent, undefined, undefined);
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH']);
  });

  it('passes names listed in passEnv and explicit entries, still never AFORO_*', () => {
    const { env, withheld } = buildChildEnv(parent, { SERVER_MODE: 'ro', AFORO_X: 'no' }, ['GITHUB_TOKEN', 'AFORO_API_KEY', 'MISSING']);
    assert.equal(env.GITHUB_TOKEN, 'ghp_secret');
    assert.equal(env.SERVER_MODE, 'ro');
    assert.equal(env.AFORO_API_KEY, undefined);
    assert.equal(env.AFORO_X, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal('MISSING' in env, false);
    assert.deepEqual(withheld.sort(), ['AFORO_API_KEY', 'AFORO_X']);
  });
});

/** A proxy with no transport: exposes the shared client/server message path. */
class HarnessProxy extends BaseProxy {
  async start(): Promise<void> { /* no transport */ }
  protected async cleanup(): Promise<void> { /* nothing to close */ }
  client(raw: string, session = 's1') { return this.handleClientMessage(raw, session); }
  server(raw: string, session = 's1') { this.handleServerMessage(raw, session); }
  get tracked() { return this.tracker; }
  get guardQuota() { return this.quota; }
}

function harnessConfig(mock: MockIngestor, aforo: Record<string, unknown> = {}): ProxyConfig {
  return {
    transport: 'stdio', command: 'unused', handleSignals: false,
    aforo: {
      tenantId: 't', productId: 'p', apiKey: 'sk_test', ingestorUrl: mock.url, customerId: 'cust_1',
      flushIntervalMs: 30, heartbeatIntervalMs: 0, ...aforo,
    },
  } as ProxyConfig;
}

const call = (id: number, name: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, _meta: { agent_id: 'agent_1' } } });

describe('with the mock ingestor', () => {
  let mock: MockIngestor;
  before(async () => { mock = await startMockIngestor(); });
  after(async () => { await mock.close(); });
  beforeEach(async () => { await mock.reset(); });

  describe('JSON-RPC batches (G303)', () => {
    it('removes refused calls from a batch, forwards the rest and answers the refusals', async () => {
      const proxy = new HarnessProxy(harnessConfig(mock, { quotaEnforcement: true }));
      // Refuse tool "b" only.
      const quota = proxy.guardQuota as any;
      const original = quota.check.bind(quota);
      quota.check = async (customer: string, metric: string, id: number) => (id === 2
        ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'Over quota' } }
        : original(customer, metric, id));
      await mock.quota({ decision: 'ALLOW' });

      const result = await proxy.client(JSON.stringify([call(1, 'a'), call(2, 'b'), call(3, 'c')]));
      assert.equal(result.forward, true);
      assert.deepEqual(JSON.parse(result.raw).map((m: any) => m.id), [1, 3]);
      assert.deepEqual(JSON.parse(result.response!).map((r: any) => [r.id, r.error.code]), [[2, -32000]]);

      // A batch response is metered element by element.
      proxy.server(JSON.stringify([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 3, result: { isError: true } }]));
      const state = await mock.waitFor((s) => s.events.filter((e) => e.metricName === 'mcp_server.tool_invocations').length === 2);
      const byTool = Object.fromEntries(state.events.filter((e) => e.toolName).map((e) => [e.toolName, e.executionStatus]));
      assert.deepEqual(byTool, { a: 'SUCCESS', c: 'ERROR' });
      await proxy.stop();
    });

    it('a single refused call is not forwarded', async () => {
      await mock.quota({ decision: 'DENY', reason: 'Over quota' });
      const proxy = new HarnessProxy(harnessConfig(mock, { quotaEnforcement: true }));
      const result = await proxy.client(JSON.stringify(call(9, 'x')));
      assert.equal(result.forward, false);
      assert.equal(JSON.parse(result.response!).error.code, -32000);
      await proxy.stop();
    });

    it('parseJsonRpc reads single messages and batches, and skips junk', () => {
      assert.deepEqual(parseJsonRpc('{"jsonrpc":"2.0","id":1,"method":"x"}')?.batch, false);
      assert.equal(parseJsonRpc('[{"jsonrpc":"2.0","id":1,"method":"x"}, 5, {"no":"rpc"}]')?.messages.length, 1);
      assert.equal(parseJsonRpc('[1, 2]'), null);
      assert.equal(parseJsonRpc('not json'), null);
    });
  });

  describe('quota pre-check (G304)', () => {
    const guard = (extra: Record<string, unknown> = {}) => new QuotaGuard({ ingestorUrl: mock.url, tenantId: 't', apiKey: 'sk_test', enabled: true, ...extra });

    it('a DENY that takes 200 ms is enforced with the default timeout', async () => {
      await mock.quota({ decision: 'DENY', reason: 'Over quota', delayMs: 200 });
      const res = await guard().check('cust_1', 'm', 1);
      assert.equal(res?.error?.code, -32000);
      assert.equal(res?.error?.message, 'Over quota');
    });

    it('reuses an ALLOW for the cache window, then asks again', async () => {
      let now = 1_000_000;
      const g = guard({ now: () => now, allowCacheMs: 1000 });
      assert.equal(await g.check('cust_1', 'm', 1), null);
      assert.equal(await g.check('cust_1', 'm', 2), null);
      assert.equal((await mock.state()).quotaChecks.length, 1);
      now += 1001;
      assert.equal(await g.check('cust_1', 'm', 3), null);
      assert.equal((await mock.state()).quotaChecks.length, 2);
    });

    it('never reuses a WARN, and the ALLOW cache can be turned off', async () => {
      await mock.quota({ decision: 'WARN', reason: 'Near limit' });
      const g = guard();
      await g.check('cust_1', 'm', 1);
      await g.check('cust_1', 'm', 2);
      const off = guard({ allowCacheMs: 0 });
      await mock.quota({ decision: 'ALLOW' });
      await off.check('cust_1', 'm', 3);
      await off.check('cust_1', 'm', 4);
      assert.equal((await mock.state()).quotaChecks.length, 4);
    });

    it('fail-closed refuses the call when the check times out or errors; fail-open lets it through', async () => {
      await mock.faults([{ match: 'quota', hang: true, times: 2 }]);
      const closed = await guard({ failMode: 'closed', timeoutMs: 100 }).check('cust_1', 'm', 7);
      assert.equal(closed?.error?.code, -32000);
      assert.deepEqual(closed?.error?.data, { reason: 'QUOTA_CHECK_UNAVAILABLE' });
      assert.equal(await guard({ timeoutMs: 100 }).check('cust_1', 'm', 8), null);

      await mock.faults([{ match: 'quota', status: 503 }]);
      assert.equal((await guard({ failMode: 'closed' }).check('cust_2', 'm', 9))?.error?.code, -32000);
    });

    it('rejects an unknown fail mode', () => {
      assert.throws(() => guard({ failMode: 'maybe' }), /must be "open" or "closed"/);
    });

    it('caps its caches (G306)', async () => {
      const g = guard({ maxCacheEntries: 3 });
      for (let i = 0; i < 6; i++) await g.check(`cust_${i}`, 'm', i);
      assert.equal(g.cacheSizes.allow, 3);
    });
  });
});

describe('bounded tables (G306)', () => {
  it('BoundedMap evicts the oldest entry past its cap and expires entries', () => {
    const evicted: string[] = [];
    const map = new BoundedMap<string, number>({ maxEntries: 2, onEvict: (k) => evicted.push(k) });
    map.set('a', 1, 100, 0);
    map.set('b', 2, undefined, 0);
    map.set('c', 3, undefined, 0);
    assert.deepEqual(evicted, ['a']);
    assert.equal(map.get('b', 50), 2);
    map.set('d', 4, 10, 0);
    assert.equal(map.get('d', 10), undefined, 'expired at its ttl');
    assert.throws(() => new BoundedMap({ maxEntries: 0 }));
  });

  it('SessionManager caps open sessions and forgets idle ones', () => {
    let now = 0;
    const mgr = new SessionManager('streamable-http', { maxSessions: 3, idleTimeoutMs: 1000, now: () => now });
    for (let i = 0; i < 5; i++) mgr.getOrCreate(`ext-${i}`);
    assert.equal(mgr.size, 3);
    assert.equal(mgr.has('ext-0'), false);
    assert.equal(mgr.has('ext-4'), true);
    now += 1001;
    mgr.sweep();
    assert.equal(mgr.size, 0);
  });

  it('SessionManager keeps an over-long external id under the ingestor limit, stably', () => {
    const mgr = new SessionManager('streamable-http');
    const long = 'x'.repeat(200);
    const id = mgr.getOrCreate(long);
    assert.ok(id.length <= 64);
    assert.equal(mgr.getOrCreate(long), id);
  });
});

describe('health file and container image (G306)', () => {
  it('writes the file while serving and removes it on stop', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'aforo-health-')), 'alive');
    const health = new HealthFile(path, 50);
    health.start();
    assert.ok(existsSync(path));
    health.stop();
    assert.equal(existsSync(path), false);
  });

  it('the Dockerfile runs as a non-root user and checks that the health file is fresh', () => {
    const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM '));
    assert.match(runtime, /^USER node$/m);
    assert.match(runtime, /AFORO_HEALTH_FILE=/);
    assert.match(runtime, /HEALTHCHECK[\s\S]*-mmin/);
  });
});

describe('SSE parser', () => {
  it('reassembles events split across chunks and joins multi-line data', () => {
    const p = new SseParser();
    assert.deepEqual(p.push('event: message\ndata: {"a"'), []);
    const events = p.push(':1}\ndata: x\n\nevent: endpoint\r\ndata: /m\r\n\r\n');
    assert.deepEqual(events.map((e) => [e.event, e.data]), [['message', '{"a":1}\nx'], ['endpoint', '/m']]);
  });
});

describe('config loading', () => {
  const base = { transport: 'stdio' as const, command: 'node' };
  const creds = { tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://x.test' };

  it('refuses to start without a customer source', () => {
    assert.throws(() => loadConfig({ ...base, aforo: creds }), /No customer source configured/);
    assert.equal(loadConfig({ ...base, aforo: { ...creds, trustClientCustomerId: true } }).aforo.trustClientCustomerId, true);
  });

  it('a config file alone is enough (CLI fields left unset do not blank it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aforo-cfg-'));
    const file = join(dir, 'proxy.json');
    writeFileSync(file, JSON.stringify({ ...base, aforo: { ...creds, customerId: 'cust_f', quotaEnforcement: true } }));
    const cfg = loadConfig({ config: file, aforo: { tenantId: undefined } as any });
    assert.equal(cfg.aforo.tenantId, 't');
    assert.equal(cfg.aforo.customerId, 'cust_f');
    assert.equal(cfg.aforo.quotaEnforcement, true);
  });

  it('the HTTP transports need listener auth; a tokens file can be the customer source', () => {
    const http = { transport: 'sse' as const, upstream: 'http://127.0.0.1:1/sse', aforo: creds };
    assert.throws(() => loadConfig({ ...http, aforo: { ...creds, customerId: 'c' } }), /needs authentication/);
    const dir = mkdtempSync(join(tmpdir(), 'aforo-tok-'));
    const tokens = join(dir, 'tokens.json');
    writeFileSync(tokens, JSON.stringify({ 'a-client-token-000001': 'cust_x' }));
    assert.equal(loadConfig({ ...http, listen: { authTokensFile: tokens } }).listen?.authTokensFile, tokens);
    writeFileSync(tokens, JSON.stringify({ 'a-client-token-000001': '' }));
    assert.throws(() => loadConfig({ ...http, listen: { authTokensFile: tokens } }), /non-blank customer id/);
  });

  it('requires https for the ingestor except on loopback or with allowInsecureHttp (G270)', () => {
    assert.throws(() => assertIngestorUrl('http://ingest.example.com'), /must use https/);
    assertIngestorUrl('http://127.0.0.1:8084');
    assertIngestorUrl('http://ingest.internal', true);
    assert.throws(() => loadConfig({ ...base, aforo: { ...creds, customerId: 'c', ingestorUrl: 'http://ingest.example.com' } }), /https/);
  });
});
