'use strict';
// Forwarder tests against the fault-injecting mock ingestor from
// aforo-metering-sdks (the same target every SDK suite uses).
//   node --test azure-apim/eventhub-forwarder/tests/
// Set AFORO_MOCK_INGESTOR to the mock's bin/mock-ingestor.mjs when the
// aforo-metering-sdks checkout is not next to this repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { Forwarder, OutageError, configFromEnv, parseMessages, chunk, parseRetryAfter, compoundOutcome } = require('../src/forwarder');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const MOCK = [
    process.env.AFORO_MOCK_INGESTOR,
    path.join(repoRoot, '..', 'aforo-metering-sdks', 'mock-ingestor', 'bin', 'mock-ingestor.mjs'),
    path.join(repoRoot, '..', 'Nextgen_Aforo', 'aforo-metering-sdks', 'mock-ingestor', 'bin', 'mock-ingestor.mjs'),
].filter(Boolean).find(function (p) { return fs.existsSync(p); });

const API_KEY = 'sk_test_forwarder_key';
let mock;
let base;

test.before(async function () {
    assert.ok(MOCK, 'mock ingestor not found: set AFORO_MOCK_INGESTOR to aforo-metering-sdks/mock-ingestor/bin/mock-ingestor.mjs');
    mock = spawn(process.execPath, [MOCK, '--port', '0', '--api-key', API_KEY], { stdio: ['pipe', 'pipe', 'inherit'] });
    base = await new Promise(function (resolve, reject) {
        let buf = '';
        mock.stdout.on('data', function (d) {
            buf += d;
            const line = buf.split('\n')[0];
            try { resolve(JSON.parse(line).url); } catch (err) { /* wait for the full line */ }
        });
        mock.on('exit', function (code) { reject(new Error('mock exited ' + code)); });
    });
});
test.after(function () { if (mock) mock.kill('SIGTERM'); });
test.beforeEach(async function () { await control('POST', '/__control/reset'); });

async function control(method, p, body) {
    const res = await fetch(base + p, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return res.headers.get('content-type') && res.headers.get('content-type').indexOf('json') !== -1 ? res.json() : null;
}
const state = function () { return control('GET', '/__control/state'); };
const faults = function (list) { return control('POST', '/__control/faults', { faults: list }); };

function usageEvent(n) {
    return {
        customerId: 'cust_1', metricName: 'api_calls', quantity: 1,
        idempotencyKey: 'req-' + n, occurredAt: new Date(1767225600000 + n).toISOString(),
        productType: 'API', endpointPath: '/v1/x', httpMethod: 'GET', statusCode: 200, responseTimeMs: 3,
        metadata: { gateway: 'azure-apim' },
    };
}
// One Event Hub message per APIM request, exactly what the policy logs.
function messages(from, to) {
    const out = [];
    for (let i = from; i < to; i++) out.push(JSON.stringify({ events: [usageEvent(i)] }));
    return out;
}

function forwarder(overrides, deps) {
    const sleeps = [];
    const logs = [];
    const f = new Forwarder(Object.assign({
        ingestUrl: base + '/v1/ingest/batch', apiKey: API_KEY, maxRetries: 3, timeoutMs: 2000, budgetMs: 30000,
    }, overrides || {}), Object.assign({
        sleep: function (ms) { sleeps.push(ms); return Promise.resolve(); },
        random: function () { return 0.5; },
        log: { info: function () {}, warn: function (m) { logs.push(m); }, error: function (m) { logs.push(m); } },
    }, deps || {}));
    f.sleeps = sleeps;
    f.logs = logs;
    return f;
}

test('delivers one invocation as one batch with the policy keys', async function () {
    const f = forwarder();
    const stats = await f.forward(messages(0, 3));
    assert.equal(stats.accepted, 3);
    const s = await state();
    assert.equal(s.requests.length, 1);
    assert.deepEqual(s.requests[0].idempotencyKeys, ['req-0', 'req-1', 'req-2']);
    assert.ok(!s.requests[0].contentEncoding, 'no Content-Encoding');
});

test('batches of at most 500 events, one request at a time', async function () {
    const f = forwarder();
    const stats = await f.forward(messages(0, 1200));
    assert.equal(stats.accepted, 1200);
    const s = await state();
    assert.deepEqual(s.requests.map(function (r) { return r.eventCount; }), [500, 500, 200]);
    assert.equal(s.maxInFlight, 1);
    assert.equal(s.uniqueKeys, 1200);
});

test('an outage that recovers within the retries loses nothing and keeps the keys', async function () {
    await faults([{ status: 503, times: 2 }]);
    const f = forwarder();
    const stats = await f.forward(messages(0, 4));
    assert.equal(stats.accepted, 4);
    const s = await state();
    assert.equal(s.requests.length, 3);
    s.requests.forEach(function (r) { assert.deepEqual(r.idempotencyKeys, ['req-0', 'req-1', 'req-2', 'req-3']); });
    assert.equal(f.sleeps.length, 2);
    assert.ok(f.sleeps[0] <= 500 && f.sleeps[1] <= 1000, 'full jitter within base * 2^attempt: ' + f.sleeps);
});

test('an outage that does not recover throws, so the checkpoint does not move; the re-run delivers once', async function () {
    await faults([{ status: 503, times: -1 }]);
    const f = forwarder();
    await assert.rejects(f.forward(messages(0, 5)), function (err) { return err instanceof OutageError && err.kind === 'outage'; });
    let s = await state();
    assert.equal(s.acceptedCount, 0);
    assert.equal(s.requests.length, 4); // 1 + maxRetries
    await control('DELETE', '/__control/faults');
    const stats = await f.forward(messages(0, 5)); // the Functions retry policy re-runs the same messages
    assert.equal(stats.accepted, 5);
    s = await state();
    assert.equal(s.uniqueKeys, 5);
});

test('accepted events are only billed once when an outage hits a later batch', async function () {
    await faults([{ delayMs: 1, times: 1 }, { status: 503, times: -1 }]); // first batch accepted, then down
    const f = forwarder({ maxEvents: 2 });
    await assert.rejects(f.forward(messages(0, 4)), OutageError);
    await control('DELETE', '/__control/faults');
    await f.forward(messages(0, 4));
    const s = await state();
    assert.equal(s.uniqueKeys, 4);
    assert.ok(s.duplicates >= 2, 'the first batch is sent again and deduplicated: ' + s.duplicates);
});

test('429 Retry-After is honoured, as seconds and as an HTTP-date, capped at 60 s', async function () {
    await faults([{ status: 429, retryAfter: '2', times: 1 }]);
    let f = forwarder();
    await f.forward(messages(0, 1));
    assert.ok(f.sleeps[0] >= 2000, 'slept ' + f.sleeps[0]);

    await control('POST', '/__control/reset');
    const at = new Date(Date.now() + 120000).toUTCString();
    await faults([{ status: 429, retryAfter: at, times: 1 }]);
    f = forwarder({ budgetMs: 120000 });
    await f.forward(messages(0, 1));
    assert.equal(f.sleeps[0], 60000);
});

test('401 is an outage at once: no retry, nothing dropped', async function () {
    const f = forwarder({ apiKey: 'sk_test_wrong' });
    await assert.rejects(f.forward(messages(0, 2)), function (err) { return err instanceof OutageError && err.status === 401; });
    const s = await state();
    assert.equal(s.requests.length, 1);
    assert.ok(f.logs.join('\n').indexOf('sk_test_wrong') === -1, 'the API key is never logged');
});

test('a redirect is never followed and counts as an outage', async function () {
    await faults([{ status: 302, location: 'https://elsewhere.example/v1/ingest/batch', times: 1 }]);
    const f = forwarder();
    await assert.rejects(f.forward(messages(0, 1)), function (err) { return err.status === 302; });
    assert.equal((await state()).requests.length, 1);
    assert.ok(f.logs.join('\n').indexOf('elsewhere.example') !== -1);
});

test('413 splits the batch in half', async function () {
    await faults([{ status: 413, times: 1 }]);
    const f = forwarder();
    const stats = await f.forward(messages(0, 6));
    assert.equal(stats.accepted, 6);
    const s = await state();
    assert.deepEqual(s.requests.map(function (r) { return r.eventCount; }), [6, 3, 3]);
});

test('a single event that still gets 413 is rejected, the rest goes through', async function () {
    await faults([{ status: 413, times: 3 }]);
    const f = forwarder();
    const stats = await f.forward(messages(0, 2));
    assert.equal(stats.rejected, 2);
    assert.equal(stats.accepted, 0);
});

test('per-event retryable errors are re-sent with the same keys; others are rejected', async function () {
    await faults([{ perEvent: [{ index: 0, retryable: true, message: 'busy' }, { index: 2, retryable: false, message: 'bad metric' }], times: 1 }]);
    const f = forwarder();
    const stats = await f.forward(messages(0, 3));
    assert.equal(stats.accepted, 2);
    assert.equal(stats.rejected, 1);
    const s = await state();
    assert.deepEqual(s.requests[1].idempotencyKeys, ['req-0']);
    assert.ok(f.logs.join('\n').indexOf('req-2') !== -1, 'a rejected event is logged with its key');
});

test('per-event retryable errors that never clear become an outage', async function () {
    await faults([{ perEvent: [{ index: 0, retryable: true }], times: -1 }]);
    const f = forwarder();
    await assert.rejects(f.forward(messages(0, 2)), OutageError);
});

test('other 4xx rejects the batch without retry', async function () {
    await faults([{ status: 400, times: 1 }]);
    const f = forwarder();
    const stats = await f.forward(messages(0, 2));
    assert.equal(stats.rejected, 2);
    assert.equal((await state()).requests.length, 1);
});

test('a hung response is cut off by the request deadline and retried', async function () {
    await faults([{ hang: true, times: 1 }]);
    const f = forwarder({ timeoutMs: 300 });
    const started = Date.now();
    const stats = await f.forward(messages(0, 1));
    assert.equal(stats.accepted, 1);
    assert.ok(Date.now() - started < 5000);
});

test('a body that drips past the deadline is cut off too', async function () {
    await faults([{ dripMs: 200, times: 1 }]);
    const f = forwarder({ timeoutMs: 400 });
    const stats = await f.forward(messages(0, 1));
    assert.equal(stats.accepted, 1);
});

test('a huge response body is read only up to the cap, then cancelled and retried', async function () {
    const { MAX_RESPONSE_BYTES } = require('../src/forwarder');
    assert.equal(MAX_RESPONSE_BYTES, 256 * 1024);
    let pulled = 0;
    let cancelled = false;
    const chunkBytes = new Uint8Array(16 * 1024).fill(0x61);
    const fakeFetch = async function () {
        const body = new ReadableStream({
            pull: function (c) {
                if (pulled >= 4 * 1024 * 1024) { c.close(); return; }
                pulled += chunkBytes.length; c.enqueue(chunkBytes);
            },
            cancel: function () { cancelled = true; },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const f = forwarder({ timeoutMs: 5000 }, { fetch: fakeFetch });
    const res = await f.post('https://ingest.example.com/v1/ingest/batch', '{}', Date.now() + 5000);
    assert.equal(res.status, 0, 'an unreadable 2xx is not counted as accepted');
    assert.ok(cancelled, 'the rest of the body is not read');
    assert.ok(pulled <= MAX_RESPONSE_BYTES + 2 * chunkBytes.length, 'read ' + pulled + ' bytes');
});

test('an over-cap 2xx answer is retried with the same keys, then accepted', async function () {
    let calls = 0;
    const bodies = [];
    const fakeFetch = async function (url, init) {
        calls++;
        bodies.push(init.body);
        if (calls === 1) return new Response('x'.repeat(300 * 1024), { status: 200 });
        return new Response(JSON.stringify({ success: true, data: { accepted: 1, errors: [] } }), { status: 200 });
    };
    const f = forwarder({}, { fetch: fakeFetch });
    const stats = await f.forward(messages(0, 1));
    assert.equal(stats.accepted, 1);
    assert.equal(calls, 2);
    assert.equal(bodies[0], bodies[1]);
});

test('the invocation budget bounds the run', async function () {
    await faults([{ status: 503, times: -1 }]);
    const f = forwarder({ maxRetries: 20, budgetMs: 1000 }, {
        sleep: function (ms) { return new Promise(function (r) { setTimeout(r, Math.min(ms, 50)); }); },
    });
    await assert.rejects(f.forward(messages(0, 1)), OutageError);
});

test('messages: non-JSON and unknown shapes are skipped, duplicates removed', function () {
    const log = { warn: function () {} };
    const r = parseMessages([
        'not json',
        JSON.stringify({ events: [usageEvent(1), usageEvent(1)] }),
        Buffer.from(JSON.stringify({ events: [usageEvent(2)] })),
        { events: [usageEvent(3), null] },
        JSON.stringify({ something: 'else' }),
        JSON.stringify({ correlationId: 'c1', measurements: [] }),
        JSON.stringify({ correlationId: 'c1', measurements: [] }),
    ], log);
    assert.equal(r.usage.length, 3);
    assert.equal(r.compound.length, 1);
    assert.equal(r.invalid, 3);
    assert.equal(r.duplicates, 2);
});

test('chunk respects the body size cap', function () {
    const big = { idempotencyKey: 'x', pad: 'a'.repeat(1000) };
    const chunks = chunk([big, big, big, big], 500, 2500);
    assert.deepEqual(chunks.map(function (c) { return c.length; }), [2, 2]);
});

test('Retry-After parsing', function () {
    assert.equal(parseRetryAfter('1.5', 0), 1500);
    assert.equal(parseRetryAfter(new Date(10000).toUTCString(), 20000), 0);
    assert.equal(parseRetryAfter('soon', 0), null);
    assert.equal(parseRetryAfter(null, 0), null);
});

test('config: https only, key required', function () {
    assert.throws(function () { configFromEnv({ AFORO_API_KEY: 'k', AFORO_INGEST_URL: 'http://ingest.example.com/v1/ingest/batch' }); }, /https/);
    assert.throws(function () { configFromEnv({}); }, /AFORO_API_KEY/);
    const cfg = configFromEnv({ AFORO_API_KEY: 'k' });
    assert.equal(cfg.ingestUrl, 'https://api.aforo.ai/v1/ingest/batch');
    assert.equal(cfg.compoundUrl, 'https://api.aforo.ai/api/v1/ingest/compound/batch');
    assert.equal(configFromEnv({ AFORO_API_KEY: 'k', AFORO_INGEST_URL: 'http://127.0.0.1:1/v1/ingest/batch' }).ingestUrl, 'http://127.0.0.1:1/v1/ingest/batch');
    assert.throws(function () { configFromEnv({ AFORO_API_KEY: 'k', AFORO_MAX_RETRIES: 'many' }); }, /positive integer/);
});

test('compound events go to the compound batch endpoint; a permanent failure is rejected', async function () {
    const seen = [];
    const server = http.createServer(function (req, res) {
        let body = '';
        req.on('data', function (d) { body += d; });
        req.on('end', function () {
            seen.push({ path: req.url, key: req.headers['x-api-key'], body: JSON.parse(body) });
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: { totalProcessed: 2, succeeded: 1, failed: 1,
                results: [{ correlationId: 'c1', success: true }, { correlationId: 'c2', success: false, errors: ['unknown metric'] }] } }));
        });
    });
    await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
    try {
        const url = 'http://127.0.0.1:' + server.address().port;
        const f = forwarder({ ingestUrl: url + '/v1/ingest/batch' });
        const c = function (id) { return JSON.stringify({ correlationId: id, customerId: 'cust_1', occurredAt: new Date(0).toISOString(), measurements: [{ metricName: 'input-tokens', quantity: 5 }] }); };
        const stats = await f.forward([c('c1'), c('c2')]);
        assert.equal(stats.accepted, 1);
        assert.equal(stats.rejected, 1);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].path, '/api/v1/ingest/compound/batch');
        assert.equal(seen[0].key, API_KEY);
        assert.equal(seen[0].body.events.length, 2);
    } finally {
        server.close();
    }
});

// A compound endpoint that answers each request with the next scripted result list.
async function compoundServer(answers) {
    const seen = [];
    const server = http.createServer(function (req, res) {
        let body = '';
        req.on('data', function (d) { body += d; });
        req.on('end', function () {
            const parsed = JSON.parse(body);
            seen.push(parsed.events.map(function (e) { return e.correlationId; }));
            const results = (answers[seen.length - 1] || function (ids) { return ids.map(function (id) { return { correlationId: id, success: true, accepted: 1 }; }); })(seen[seen.length - 1]);
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: { results: results } }));
        });
    });
    await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
    return { server: server, seen: seen, url: 'http://127.0.0.1:' + server.address().port };
}
const compoundMsg = function (id) { return JSON.stringify({ correlationId: id, customerId: 'cust_1', occurredAt: new Date(0).toISOString(), measurements: [{ metricName: 'input-tokens', quantity: 5 }] }); };

test('compoundOutcome: retryable flag, BUSY / TIMEOUT texts, all-duplicate redelivery', function () {
    assert.equal(compoundOutcome({ success: true, accepted: 1 }), 'delivered');
    assert.equal(compoundOutcome({ success: false, retryable: true, errors: ['Server busy, retry the batch'] }), 'retry');
    assert.equal(compoundOutcome({ success: false, retryable: true, errors: ['db down'] }), 'retry');
    assert.equal(compoundOutcome({ success: false, errors: ['Server busy, retry the batch'] }), 'retry');
    assert.equal(compoundOutcome({ success: false, errors: ['Processing timeout'] }), 'retry');
    assert.equal(compoundOutcome({ success: false, retryable: false, errors: ['Server busy, retry the batch'] }), 'rejected', 'an explicit false wins over the text');
    assert.equal(compoundOutcome({ success: false, errors: ['unknown metric'] }), 'rejected');
    assert.equal(compoundOutcome({ success: false, accepted: 0, duplicates: 2, failed: 0 }), 'delivered');
    assert.equal(compoundOutcome({ success: false, retryable: false, accepted: 0, duplicates: 0, failed: 1 }), 'rejected');
});

test('compound BUSY / TIMEOUT results are resent with the same correlationIds, then counted', async function () {
    const srv = await compoundServer([
        function (ids) { return [
            { correlationId: ids[0], success: true, accepted: 1 },
            { correlationId: ids[1], success: false, errors: ['Server busy, retry the batch'] },
            { correlationId: ids[2], success: false, retryable: true, errors: ['Processing timeout'] },
            { correlationId: ids[3], success: false, retryable: false, errors: ['unknown metric'] },
        ]; },
    ]);
    try {
        const f = forwarder({ ingestUrl: srv.url + '/v1/ingest/batch' });
        const stats = await f.forward(['c1', 'c2', 'c3', 'c4'].map(compoundMsg));
        assert.deepEqual(srv.seen, [['c1', 'c2', 'c3', 'c4'], ['c2', 'c3']]);
        assert.equal(stats.accepted, 3);
        assert.equal(stats.rejected, 1);
        assert.equal(f.sleeps.length, 1);
    } finally {
        srv.server.close();
    }
});

test('a redelivered compound event that is all duplicates counts as delivered', async function () {
    const srv = await compoundServer([
        function (ids) { return [{ correlationId: ids[0], success: false, accepted: 0, duplicates: 1, failed: 0 }]; },
    ]);
    try {
        const f = forwarder({ ingestUrl: srv.url + '/v1/ingest/batch' });
        const stats = await f.forward([compoundMsg('c1')]);
        assert.equal(stats.accepted, 1);
        assert.equal(stats.rejected, 0);
        assert.equal(srv.seen.length, 1);
        assert.ok(!f.logs.some(function (l) { return /dropped/.test(l); }), 'nothing logged as dropped');
    } finally {
        srv.server.close();
    }
});

test('compound events still busy after the retries end the invocation without a checkpoint', async function () {
    const busy = function (ids) { return ids.map(function (id) { return { correlationId: id, success: false, retryable: true, errors: ['Server busy, retry the batch'] }; }); };
    const srv = await compoundServer([busy, busy, busy, busy, busy]);
    try {
        const f = forwarder({ ingestUrl: srv.url + '/v1/ingest/batch', maxRetries: 3 });
        await assert.rejects(f.forward([compoundMsg('c1')]), OutageError);
        assert.equal(srv.seen.length, 4);
        srv.seen.forEach(function (ids) { assert.deepEqual(ids, ['c1']); });
    } finally {
        srv.server.close();
    }
});
