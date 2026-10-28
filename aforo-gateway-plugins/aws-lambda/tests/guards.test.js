/**
 * Tests for the two request-path helpers: margin-guard.js (G342) and
 * preflight-quota.js (G344). Run with: node tests/guards.test.js
 *
 * fetch and https.request are stubbed; nothing leaves the process.
 */
'use strict';

const https = require('https');
const { EventEmitter } = require('events');

let passed = 0;
let failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  PASS: ' + msg); } else { failed++; console.error('  FAIL: ' + msg); } }
function assertEquals(a, e, msg) {
    assert(a === e, a === e ? msg : `${msg} — expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

// ── fetch stub (margin guard) ──
const f = { calls: [], status: 200, body: { allowed: false, level: 'L3_BLOCK' }, hang: false };
global.fetch = async (url, opts) => {
    f.calls.push({ url: String(url), opts });
    if (f.hang) {
        return new Promise((_, reject) => {
            const keepAlive = setTimeout(() => {}, 2000); // AbortSignal.timeout's timer is unref'd
            opts.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('aborted')); });
        });
    }
    return { ok: f.status >= 200 && f.status < 300, status: f.status, json: async () => f.body };
};

// ── https.request stub (preflight) ──
const h = { calls: [], status: 200, body: '', delayMs: 0, error: null };
https.request = (options, onResponse) => {
    const req = new EventEmitter();
    const call = { options, written: '' };
    h.calls.push(call);
    let destroyed = false;
    req.write = (d) => { call.written += d; };
    req.destroy = () => { destroyed = true; };
    req.end = () => {
        setTimeout(() => {
            if (destroyed) return;
            if (h.error) { req.emit('error', new Error(h.error)); return; }
            const res = new EventEmitter();
            res.statusCode = h.status;
            res.setEncoding = () => {};
            onResponse(res);
            res.emit('data', h.body);
            res.emit('end');
        }, h.delayMs);
    };
    return req;
};

async function run() {
    const mg = require('../margin-guard');
    const pq = require('../preflight-quota');
    const base = { marginGuardEnabled: true, marginGuardUrl: 'https://pricing.aforo.test/', apiKey: 'sk_live_a' };
    const okBody = { verdict: 'BLOCK', currentLevel: 'L3_BLOCK' };

    console.log('\nG342: margin guard — X-API-Key, escaped query, bounded cache keyed by tenant key');
    mg._resetForTests(); f.calls = []; f.status = 200; f.body = okBody;
    let r = await mg.checkMarginGuard('c&scopeType=TENANT#x?y z', base);
    assertEquals(r.verdict, 'BLOCK', 'server verdict returned');
    const call = f.calls[0];
    assertEquals(call.opts.headers['X-API-Key'], 'sk_live_a', 'X-API-Key sent');
    const q = new URL(call.url).searchParams;
    assertEquals(q.getAll('scopeType').join(','), 'CUSTOMER', 'customer id cannot add a scopeType');
    assertEquals(q.get('scopeId'), 'c&scopeType=TENANT#x?y z', 'customer id escaped as one value');

    mg._resetForTests(); f.calls = [];
    await mg.checkMarginGuard('c1', base);
    await mg.checkMarginGuard('c1', { ...base, apiKey: 'sk_live_b' });
    assertEquals(f.calls.length, 2, 'another tenant key does not reuse the first tenant\'s answer');
    await mg.checkMarginGuard('c1', base);
    assertEquals(f.calls.length, 2, 'same key + customer served from cache');

    mg._resetForTests(); f.calls = [];
    const small = { ...base, marginGuardCacheMaxEntries: 3 };
    for (let i = 0; i < 10; i++) await mg.checkMarginGuard(`c${i}`, small);
    assertEquals(mg._cacheSize(), 3, 'cache bounded to marginGuardCacheMaxEntries');
    f.calls = [];
    await mg.checkMarginGuard('c9', small);
    assertEquals(f.calls.length, 0, 'most recent entry kept');
    await mg.checkMarginGuard('c0', small);
    assertEquals(f.calls.length, 1, 'oldest entry evicted (one at a time, not the whole cache)');
    await mg.checkMarginGuard('c8', small);
    assertEquals(f.calls.length, 1, 'other entries survive an eviction');

    mg._resetForTests(); f.calls = [];
    await mg.checkMarginGuard('c', { ...base, marginGuardCacheTtlMs: 1 });
    await new Promise((res) => setTimeout(res, 5));
    await mg.checkMarginGuard('c', { ...base, marginGuardCacheTtlMs: 1 });
    assertEquals(f.calls.length, 2, 'expired entry refetched');

    mg._resetForTests(); f.calls = [];
    r = await mg.checkMarginGuard('c', { ...base, marginGuardUrl: 'not a url' });
    assert(r.allowed === true && f.calls.length === 0, 'bad marginGuardUrl → fail-open, no call');

    mg._resetForTests(); f.hang = true;
    const t0 = Date.now();
    r = await mg.checkMarginGuard('c', { ...base, marginGuardTimeoutMs: -5 });
    assert(r.allowed === true && Date.now() - t0 < 1000, 'non-positive timeout uses the default; timeout → fail-open');
    f.hang = false;

    console.log('\nG344: preflight quota checks status, caches decisions, reuses connections');
    const pc = { preflightEnabled: true, preflightUrl: 'https://api.aforo.test/api/v1/quota/check', apiKey: 'ak_test' };
    pq._test.reset(); h.calls = []; h.status = 500; h.body = JSON.stringify({ decision: 'DENY' });
    r = await pq.checkPreFlightQuota(pc, 'c1', 'calls');
    assertEquals(r.decision, 'ALLOW', 'HTTP 500 → fallback, not the body (was the body)');

    pq._test.reset(); h.calls = []; h.status = 200; h.body = JSON.stringify({ success: true, data: { decision: 'ALLOW' } });
    r = await pq.checkPreFlightQuota(pc, 'c1', 'calls');
    assertEquals(r.decision, 'ALLOW', 'ALLOW from the envelope');
    assertEquals(h.calls[0].options.agent, pq._test.agent, 'keep-alive agent used');
    assert(pq._test.agent.keepAlive === true, 'agent keeps connections alive');
    assertEquals(h.calls[0].options.headers['X-API-Key'], 'ak_test', 'X-API-Key sent');
    await pq.checkPreFlightQuota(pc, 'c1', 'calls');
    assertEquals(h.calls.length, 1, 'ALLOW cached for a short time');
    await pq.checkPreFlightQuota(pc, 'c1', 'other');
    assertEquals(h.calls.length, 2, 'cache keyed by metric');

    pq._test.reset(); h.calls = [];
    await pq.checkPreFlightQuota({ ...pc, allowCacheTtlMs: 1 }, 'c1', 'calls');
    await new Promise((res) => setTimeout(res, 5));
    await pq.checkPreFlightQuota({ ...pc, allowCacheTtlMs: 1 }, 'c1', 'calls');
    assertEquals(h.calls.length, 2, 'ALLOW expires after allowCacheTtlMs');

    pq._test.reset(); h.calls = []; h.body = JSON.stringify({ data: { decision: 'DENY', retryAfterMs: 30000, reason: 'quota' } });
    r = await pq.checkPreFlightQuota(pc, 'c2', 'calls');
    assertEquals(r.decision, 'DENY', 'DENY returned');
    h.body = JSON.stringify({ data: { decision: 'ALLOW' } });
    r = await pq.checkPreFlightQuota(pc, 'c2', 'calls');
    assert(r.decision === 'DENY' && h.calls.length === 1, 'DENY cached until retryAfterMs');
    const entry = pq._test.cache.values().next().value;
    assert(entry.expiresAt - Date.now() > 25000 && entry.expiresAt - Date.now() <= 30000, 'DENY cache lasts retryAfterMs');

    pq._test.reset(); h.calls = []; h.body = '{"decision":"MAYBE"}';
    r = await pq.checkPreFlightQuota({ ...pc, preflightFallback: 'DENY' }, 'c3');
    assertEquals(r.decision, 'DENY', 'unknown decision → configured fallback');
    await pq.checkPreFlightQuota(pc, 'c3');
    assertEquals(h.calls.length, 2, 'fallback not cached');

    pq._test.reset(); h.calls = []; h.body = JSON.stringify({ decision: 'ALLOW' }); h.delayMs = 120;
    r = await pq.checkPreFlightQuota(pc, 'c4');
    assertEquals(r.decision, 'ALLOW', 'default timeout is long enough for a 120 ms answer (was 50 ms)');
    pq._test.reset(); h.body = JSON.stringify({ decision: 'DENY' });
    r = await pq.checkPreFlightQuota({ ...pc, timeoutMs: 20 }, 'c4');
    assertEquals(r.decision, 'ALLOW', 'timeoutMs honoured → fallback');
    h.delayMs = 0;

    pq._test.reset(); h.calls = [];
    r = await pq.checkPreFlightQuota({ ...pc, preflightUrl: 'http://api.aforo.test/q' }, 'c5');
    assert(r.decision === 'ALLOW' && h.calls.length === 0, 'non-https URL refused (fallback)');
    r = await pq.checkPreFlightQuota({ ...pc, preflightUrl: 'https://api.aforo.test/q?x=1' }, 'c5');
    assertEquals(h.calls[0].options.path, '/q?x=1', 'query string kept in the path');

    pq._test.reset(); h.error = 'ECONNRESET';
    r = await pq.checkPreFlightQuota(pc, 'c6');
    assertEquals(r.decision, 'ALLOW', 'request error → fallback');
    h.error = null;

    console.log('\nW6.2 review: DENY cache capped, keyed by tenant key, Retry-After rounds up');
    pq._test.reset(); h.calls = []; h.body = JSON.stringify({ data: { decision: 'DENY', retryAfterMs: 3600000 } });
    await pq.checkPreFlightQuota(pc, 'd1', 'calls');
    let e = pq._test.cache.values().next().value;
    assert(e.expiresAt - Date.now() <= 60000 && e.expiresAt - Date.now() > 55000, 'DENY cached at most 60 s (was up to 1 h)');

    pq._test.reset(); h.calls = []; h.body = JSON.stringify({ data: { decision: 'DENY' } });
    await pq.checkPreFlightQuota(pc, 'd2', 'calls');
    e = pq._test.cache.values().next().value;
    assert(e.expiresAt - Date.now() <= 5000 && e.expiresAt - Date.now() > 4000, 'DENY without retryAfterMs cached 5 s (was 60 s)');

    pq._test.reset(); h.calls = []; h.body = JSON.stringify({ data: { decision: 'DENY', retryAfterMs: 30000 } });
    await pq.checkPreFlightQuota(pc, 'd3', 'calls');
    h.body = JSON.stringify({ data: { decision: 'ALLOW' } });
    r = await pq.checkPreFlightQuota({ ...pc, apiKey: 'ak_other_workspace' }, 'd3', 'calls');
    assert(r.decision === 'ALLOW' && h.calls.length === 2, 'another workspace\'s key does not reuse the DENY (was a cross-tenant 429)');
    r = await pq.checkPreFlightQuota({ ...pc, tenantId: 'tB' }, 'd3', 'calls');
    assert(h.calls.length === 3, 'a different tenantId with the same key is a separate entry');
    r = await pq.checkPreFlightQuota(pc, 'd3', 'calls');
    assert(r.decision === 'DENY' && h.calls.length === 3, 'same key + customer + metric served from cache');
    assert(![...pq._test.cache.keys()].some((k) => k.includes('ak_test')), 'raw API key not stored in the cache key');

    assertEquals(pq.build429Response({ retryAfterMs: 400 }).headers['Retry-After'], '1', 'sub-second wait → Retry-After 1 (was 0)');
    assertEquals(pq.build429Response({ retryAfterMs: 1500 }).headers['Retry-After'], '2', 'Retry-After rounds up');
    assertEquals(pq.build429Response({}).headers['Retry-After'], '5', 'no wait from the server → Retry-After 5, the time the DENY stays cached (was 60)');
    pq._test.reset(); h.calls = []; h.body = JSON.stringify({ data: { decision: 'DENY', retryAfterMs: 30000 } });
    await pq.checkPreFlightQuota(pc, 'd4', 'calls');
    const k4 = pq._test.cache.keys().next().value;
    pq._test.cache.get(k4).expiresAt = Date.now() + 2500;
    r = await pq.checkPreFlightQuota(pc, 'd4', 'calls');
    assert(r.retryAfterMs > 0 && r.retryAfterMs <= 2500, 'cached DENY reports the remaining wait, not the original');
    assertEquals(pq.build429Response(r).headers['Retry-After'], '3', 'Retry-After from the remaining wait');
    assertEquals(pq._test.cache.get(k4).data.retryAfterMs, 30000, 'cached entry itself not mutated');

    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
