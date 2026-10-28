'use strict';
/**
 * margin-guard.js — the authorizer-side margin-guard check against pricing's
 * key-authenticated /api/v1/margin-guard/quick-check.
 */
const http = require('http');
const assert = require('assert');
const mg = require('../margin-guard');

let passed = 0;
let failed = 0;
async function test(name, fn) {
    mg._resetForTests();
    try {
        await fn();
        passed++;
        console.log(`  PASS: ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL: ${name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n        ') : err}`);
    }
}

function pricing(handler) {
    const calls = [];
    const server = http.createServer((req, res) => {
        calls.push({ url: req.url, headers: req.headers });
        handler(req, res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`, calls,
        close: () => new Promise(r => { server.close(r); server.closeAllConnections(); }),
    })));
}
const json = (body, status = 200) => (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};
const cfg = (url, extra = {}) => ({ marginGuardEnabled: true, marginGuardUrl: url + '/', apiKey: 'sk_live_k', ...extra });

(async () => {
    console.log('margin-guard.js');

    await test('calls the public path with X-API-Key and no tenant id', async () => {
        const p = await pricing(json({ verdict: 'ALLOW', currentLevel: 'NONE' }));
        try {
            const r = await mg.checkMarginGuard('cus 1', cfg(p.url));
            assert.strictEqual(r.verdict, 'ALLOW');
            assert.strictEqual(r.allowed, true);
            assert.strictEqual(p.calls[0].url, '/api/v1/margin-guard/quick-check?scopeType=CUSTOMER&scopeId=cus%201');
            assert.strictEqual(p.calls[0].headers['x-api-key'], 'sk_live_k');
            assert.strictEqual(p.calls[0].headers['x-tenant-id'], undefined);
        } finally { await p.close(); }
    });

    await test('BLOCK → 429 L3, cached', async () => {
        const p = await pricing(json({ verdict: 'BLOCK', currentLevel: 'L3_BLOCK', message: 'low margin' }));
        try {
            const r = await mg.checkMarginGuard('c', cfg(p.url));
            await mg.checkMarginGuard('c', cfg(p.url));
            assert.strictEqual(p.calls.length, 1);
            const resp = mg.buildEnforcementResponse(r, cfg(p.url));
            assert.strictEqual(resp.statusCode, 429);
            assert.strictEqual(resp.headers['X-Margin-Guard-Level'], 'L3');
            assert.strictEqual(resp.headers['Retry-After'], '30');
            assert.strictEqual(JSON.parse(resp.body).error.message, 'low margin');
        } finally { await p.close(); }
    });

    await test('THROTTLE → 429 L2 every time, never cached, no dice', async () => {
        const p = await pricing(json({ verdict: 'THROTTLE', currentLevel: 'L2_THROTTLE' }));
        try {
            for (let i = 0; i < 5; i++) {
                const r = await mg.checkMarginGuard('c', cfg(p.url));
                const resp = mg.buildEnforcementResponse(r);
                assert.strictEqual(resp.statusCode, 429);
                assert.strictEqual(resp.headers['Retry-After'], '1');
            }
            assert.strictEqual(p.calls.length, 5);
        } finally { await p.close(); }
    });

    await test('ALLOW while a throttle is active (currentLevel L2) is not cached', async () => {
        const p = await pricing(json({ verdict: 'ALLOW', currentLevel: 'L2_THROTTLE' }));
        try {
            await mg.checkMarginGuard('c', cfg(p.url));
            await mg.checkMarginGuard('c', cfg(p.url));
            assert.strictEqual(p.calls.length, 2);
        } finally { await p.close(); }
    });

    await test('an enveloped answer is read too', async () => {
        const p = await pricing(json({ success: true, data: { verdict: 'BLOCK', currentLevel: 'L3_BLOCK' } }));
        try {
            const r = await mg.checkMarginGuard('c', cfg(p.url));
            assert.strictEqual(r.verdict, 'BLOCK');
        } finally { await p.close(); }
    });

    await test('401 / missing verdict / unreachable → fail-open ALLOW', async () => {
        const p = await pricing(json({ status: 401 }, 401));
        try {
            assert.strictEqual((await mg.checkMarginGuard('c', cfg(p.url))).allowed, true);
        } finally { await p.close(); }
        const q = await pricing(json({ allowed: false, level: 'L3_BLOCK' }));
        try {
            assert.strictEqual((await mg.checkMarginGuard('c', cfg(q.url))).allowed, true);
        } finally { await q.close(); }
        const r = await mg.checkMarginGuard('c', cfg('http://127.0.0.1:1', { marginGuardTimeoutMs: 100 }));
        assert.strictEqual(r.allowed, true);
    });

    await test('a customer id over 128 characters is not sent (pricing refuses it); 128 is', async () => {
        const p = await pricing(json({ verdict: 'BLOCK' }));
        try {
            assert.strictEqual((await mg.checkMarginGuard('c'.repeat(129), cfg(p.url))).allowed, true);
            assert.strictEqual(p.calls.length, 0);
            assert.strictEqual((await mg.checkMarginGuard('d'.repeat(128), cfg(p.url))).verdict, 'BLOCK');
            assert.strictEqual(p.calls.length, 1);
        } finally { await p.close(); }
    });

    await test('no API key, disabled, or no customer → no call', async () => {
        const p = await pricing(json({ verdict: 'BLOCK' }));
        try {
            await mg.checkMarginGuard('c', cfg(p.url, { apiKey: '' }));
            await mg.checkMarginGuard('c', cfg(p.url, { marginGuardEnabled: false }));
            await mg.checkMarginGuard('', cfg(p.url));
            assert.strictEqual(p.calls.length, 0);
        } finally { await p.close(); }
    });

    await test('cached answers are per API key, never shared across workspaces', async () => {
        const p = await pricing((req, res) => {
            const block = req.headers['x-api-key'] === 'sk_live_a';
            json(block ? { verdict: 'BLOCK', currentLevel: 'L3_BLOCK' } : { verdict: 'ALLOW', currentLevel: 'NONE' })(req, res);
        });
        try {
            assert.strictEqual((await mg.checkMarginGuard('cus', cfg(p.url, { apiKey: 'sk_live_a' }))).verdict, 'BLOCK');
            assert.strictEqual((await mg.checkMarginGuard('cus', cfg(p.url, { apiKey: 'sk_live_b' }))).verdict, 'ALLOW');
            assert.strictEqual((await mg.checkMarginGuard('cus', cfg(p.url, { apiKey: 'sk_live_a' }))).verdict, 'BLOCK');
            assert.strictEqual(p.calls.length, 2);
        } finally { await p.close(); }
    });

    await test('ALLOW / WARN build no response', async () => {
        assert.strictEqual(mg.buildEnforcementResponse({ verdict: 'ALLOW' }), null);
        assert.strictEqual(mg.buildEnforcementResponse({ verdict: 'WARN' }), null);
        assert.strictEqual(mg.buildEnforcementResponse(null), null);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
