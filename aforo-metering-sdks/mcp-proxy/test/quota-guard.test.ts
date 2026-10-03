/**
 * @file Unit tests for QuotaGuard — deny cache, fail-open, timeout behavior.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { QuotaGuard, parseQuotaResponse } from '../src/interceptor/QuotaGuard.js';
import { unwrapEnvelope } from '../src/telemetry/IngestorClient.js';

// Response shapes come from the shared contract (derived from the real
// controller + ApiResponseAdvice), not from this proxy's own types.
const contract = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../contract/ingest-contract.json'), 'utf8'),
).responses;
const quotaSpec = contract['/api/v1/quota/check'];

const realFetch = globalThis.fetch;

/** Stub fetch with a queue of replies; a function reply gets (url, init). */
function stubFetch(replies: Array<{ status?: number; body?: unknown; raw?: string; delayMs?: number } | Error>) {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const next = replies.shift();
    if (!next) throw new Error('no more stubbed responses');
    if (next instanceof Error) throw next;
    if (next.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, next.delayMs);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason ?? new Error('aborted')); });
      });
    }
    return new Response(next.raw ?? JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

function enabledGuard(): QuotaGuard {
  return new QuotaGuard({ ingestorUrl: 'https://x.test/', tenantId: 't1', apiKey: 'k1', enabled: true });
}

describe('QuotaGuard', () => {
  it('returns null when disabled', async () => {
    const guard = new QuotaGuard({
      ingestorUrl: 'http://localhost:9999',
      tenantId: 'test',
      apiKey: 'key',
      enabled: false,
    });

    const result = await guard.check('customer_1', 'mcp_server.tool_invocations', 1);
    assert.equal(result, null);
  });

  it('fails open when ingestor is unreachable', async () => {
    const guard = new QuotaGuard({
      ingestorUrl: 'http://localhost:1', // Unreachable port
      tenantId: 'test',
      apiKey: 'key',
      enabled: true,
    });

    const result = await guard.check('customer_1', 'mcp_server.tool_invocations', 1);
    // Should fail-open (return null = allow)
    assert.equal(result, null);
  });

  it('returns JSON-RPC error with code -32000 structure', () => {
    // Test the error response shape directly
    const guard = new QuotaGuard({
      ingestorUrl: 'http://localhost:9999',
      tenantId: 'test',
      apiKey: 'key',
      enabled: true,
    });

    // Access private method via prototype for testing
    const response = (guard as any).buildDenyResponse(42, {
      decision: 'DENY',
      reason: 'Quota exceeded',
      currentUsage: 1000,
      limit: 1000,
      retryAfterMs: 3600000,
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 42);
    assert.ok(response.error);
    assert.equal(response.error.code, -32000);
    assert.equal(response.error.message, 'Quota exceeded');
    assert.equal(response.error.data.currentUsage, 1000);
    assert.equal(response.error.data.limit, 1000);
    assert.equal(response.error.data.retryAfterMs, 3600000);
    assert.ok(response.error.data.resetsAt); // ISO string
  });

  describe('against the ingestor response contract', () => {
    afterEach(() => { globalThis.fetch = realFetch; });

    it('sends the request the controller binds: path, X-API-Key, DTO field names', async () => {
      const calls = stubFetch([{ body: quotaSpec.examples.allow }]);
      await enabledGuard().check('cust_1', 'mcp_server.tool_invocations', 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://x.test/api/v1/quota/check');
      assert.equal(calls[0].init.method, quotaSpec.method);
      assert.equal(calls[0].init.headers['X-API-Key'], 'k1');
      assert.equal(calls[0].init.headers['X-Tenant-Id'], 't1');
      const body = JSON.parse(calls[0].init.body);
      for (const f of quotaSpec.requestRequiredFields) assert.ok(body[f], `required request field '${f}'`);
      const known = [...quotaSpec.requestRequiredFields, ...quotaSpec.requestOptionalFields];
      for (const k of Object.keys(body)) assert.ok(known.includes(k), `request field '${k}' is not on the DTO`);
      assert.equal(body.customerId, 'cust_1');
    });

    it('DENY in the {success, data} envelope blocks with -32000, reason and retryAfterMs', async () => {
      const deny = quotaSpec.examples.deny;
      assert.equal(deny[contract.envelope.dataKey].decision, 'DENY'); // fixture really is enveloped
      stubFetch([{ body: deny }]);
      const res = await enabledGuard().check('cust_1', 'm', 7);
      assert.ok(res?.error);
      assert.equal(res.id, 7);
      assert.equal(res.error.code, -32000);
      assert.equal(res.error.message, deny.data.reason);
      const data = res.error.data as Record<string, unknown>;
      assert.equal(data.reason, deny.data.reason);
      assert.equal(data.retryAfterMs, deny.data.retryAfterMs);
      assert.equal(data.currentUsage, deny.data.currentUsage);
      assert.equal(data.limit, deny.data.limit);
      assert.ok(data.resetsAt);
    });

    it('DENY in the bare shape blocks too', async () => {
      stubFetch([{ body: quotaSpec.examples.deny.data }]);
      const res = await enabledGuard().check('cust_1', 'm', 1);
      assert.equal(res?.error?.code, -32000);
    });

    it('ALLOW and WARN pass, enveloped or bare; only the contract\'s blocking decisions block', async () => {
      for (const decision of quotaSpec.decisions as string[]) {
        const blocks = quotaSpec.blockingDecisions.includes(decision);
        for (const body of [{ success: true, data: { decision, reason: 'r' } }, { decision, reason: 'r' }]) {
          stubFetch([{ body }]);
          const res = await enabledGuard().check('cust_1', 'm', 1);
          assert.equal(res !== null, blocks, `${decision} ${JSON.stringify(body)}`);
        }
      }
      stubFetch([{ body: quotaSpec.examples.warn }]);
      assert.equal(await enabledGuard().check('cust_1', 'm', 1), null);
    });

    it('WARN is logged once per window, not once per call', async () => {
      const lines: string[] = [];
      const realErr = console.error, realWarn = console.warn, realLog = console.log;
      const realWrite = process.stderr.write.bind(process.stderr);
      const capture = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
      console.error = capture; console.warn = capture; console.log = capture;
      (process.stderr as any).write = (chunk: any) => { lines.push(String(chunk)); return true; };
      try {
        const guard = enabledGuard();
        stubFetch([{ body: quotaSpec.examples.warn }, { body: quotaSpec.examples.warn }, { body: quotaSpec.examples.warn }]);
        for (let i = 0; i < 3; i++) assert.equal(await guard.check('cust_1', 'm', i), null);
      } finally {
        console.error = realErr; console.warn = realWarn; console.log = realLog;
        (process.stderr as any).write = realWrite;
      }
      assert.equal(lines.filter(l => l.includes('Quota warning')).length, 1);
    });

    it('fails open on malformed JSON, non-object bodies, unknown decisions and non-200', async () => {
      const replies = [
        { raw: 'not json{' }, { raw: '' }, { raw: 'null' }, { raw: '[]' }, { raw: '"DENY"' },
        { body: { success: true, data: null } }, { body: { success: true, data: { decision: 'MAYBE' } } },
        { body: { success: true, data: 'DENY' } }, { body: { success: false } },
        { status: 500, body: quotaSpec.examples.deny }, { status: 401, body: {} },
        new Error('socket hang up'),
      ];
      for (const reply of replies) {
        stubFetch([reply]);
        assert.equal(await enabledGuard().check('cust_1', 'm', 1), null, JSON.stringify(reply));
      }
    });

    it('fails open when the check takes longer than 50ms', async () => {
      stubFetch([{ body: quotaSpec.examples.deny, delayMs: 2000 }]);
      const started = Date.now();
      assert.equal(await enabledGuard().check('cust_1', 'm', 1), null);
      assert.ok(Date.now() - started < 1500, 'gave up at the timeout, did not wait for the reply');
    });

    it('caches a DENY per customer + metric: no second request, fresh request id, other keys unaffected', async () => {
      const guard = enabledGuard();
      const calls = stubFetch([{ body: quotaSpec.examples.deny }, { body: quotaSpec.examples.allow }]);
      assert.equal((await guard.check('cust_1', 'm', 1))?.id, 1);
      const cached = await guard.check('cust_1', 'm', 2);
      assert.equal(cached?.id, 2);
      assert.equal(cached?.error?.code, -32000);
      assert.equal(calls.length, 1);
      assert.equal(await guard.check('cust_2', 'm', 3), null); // different customer → asks again
      assert.equal(calls.length, 2);
    });

    it('asks again once the 5s deny cache entry has expired', async () => {
      const guard = enabledGuard();
      const calls = stubFetch([{ body: quotaSpec.examples.deny }, { body: quotaSpec.examples.allow }]);
      assert.ok(await guard.check('cust_1', 'm', 1));
      for (const entry of (guard as any).denyCache.values()) entry.expiresAt = Date.now() - 1;
      assert.equal(await guard.check('cust_1', 'm', 2), null);
      assert.equal(calls.length, 2);
    });

    it('parseQuotaResponse never throws and drops non-numeric fields', () => {
      for (const junk of [undefined, null, 1, 'x', [], {}, { data: [] }, { data: { decision: 5 } }]) {
        assert.equal(parseQuotaResponse(junk), null);
      }
      const parsed = parseQuotaResponse({ data: { decision: 'deny', retryAfterMs: 'soon', limit: 10 } });
      assert.deepEqual(parsed, { decision: 'DENY', reason: '', currentUsage: undefined, limit: 10, retryAfterMs: undefined, tierName: undefined });
    });

    it('batch-ingest responses in the contract unwrap to the fields the proxy reads', () => {
      const spec = contract['/v1/ingest/batch'];
      const partial = unwrapEnvelope(spec.examples.partialFailure);
      assert.equal(partial.failed, 1);
      assert.equal(partial.errors[0].index, 0);
      assert.deepEqual(unwrapEnvelope(spec.examples.killedSession).killedSessionIds, ['s1']);
      const bare = { accepted: 1, duplicates: 0, failed: 0 };
      assert.equal(unwrapEnvelope(bare), bare);
      for (const junk of [null, undefined, 'x', [], { data: null }, { data: [1] }]) assert.equal(unwrapEnvelope(junk), junk);
    });
  });
});
