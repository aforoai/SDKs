'use strict';
// BatchingSubscriber tests: a fake subscription (EventEmitter + messages with
// ack/nack) and fake timers, plus one end-to-end run through the real
// Forwarder and the mock ingestor.
//   node --test apigee/pubsub-forwarder/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { BatchingSubscriber, BREAKER_BASE_MS } = require('../src/subscriber');
const { Forwarder, OutageError } = require('../src/forwarder');

class FakeSubscription extends EventEmitter {
    constructor() { super(); this.closed = false; }
    async close() { this.closed = true; }
}

let ids = 0;
function message(events) {
    const m = { id: 'm' + (++ids), data: Buffer.from(JSON.stringify({ events: events })), acks: 0, nacks: 0 };
    m.ack = function () { m.acks++; };
    m.nack = function () { m.nacks++; };
    return m;
}
function evt(n) { return { idempotencyKey: 'k-' + n, customerId: 'c', metricName: 'm', quantity: 1 }; }

function clock() {
    const c = { t: 1000, timers: [] };
    c.now = function () { return c.t; };
    c.setTimeout = function (fn, ms) { const t = { fn: fn, at: c.t + ms }; c.timers.push(t); return t; };
    c.clearTimeout = function (t) { c.timers = c.timers.filter(function (x) { return x !== t; }); };
    c.advance = async function (ms) {
        c.t += ms;
        const due = c.timers.filter(function (x) { return x.at <= c.t; });
        c.timers = c.timers.filter(function (x) { return x.at > c.t; });
        due.forEach(function (x) { x.fn(); });
        await settle();
    };
    return c;
}
function settle() { return new Promise(function (r) { setImmediate(r); }); }

function fakeForwarder(behaviour) {
    const f = { calls: [] };
    f.forward = function (datas) {
        f.calls.push(datas.map(function (d) { return JSON.parse(d.toString()).events.map(function (e) { return e.idempotencyKey; }); }).flat());
        return behaviour(f.calls.length, datas);
    };
    return f;
}
const ok = function () { return Promise.resolve({ accepted: 1, rejected: 0, invalid: 0, duplicates: 0 }); };
const quiet = { info: function () {}, warn: function () {}, error: function () {} };

function setup(behaviour, opts) {
    const c = clock();
    const sub = new FakeSubscription();
    const f = fakeForwarder(behaviour);
    const logs = [];
    const s = new BatchingSubscriber(sub, f, Object.assign({ maxBatchMessages: 3, maxWaitMs: 1000 }, opts || {}), {
        now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, random: function () { return 0.5; },
        log: { info: function () {}, warn: function (m) { logs.push(m); }, error: function (m) { logs.push(m); } },
    }).start();
    return { c: c, sub: sub, f: f, s: s, logs: logs };
}

test('a full batch flushes at once; the messages are acked after the forwarder resolves', async function () {
    const t = setup(ok);
    const ms = [message([evt(1)]), message([evt(2)]), message([evt(3)])];
    ms.forEach(function (m) { t.sub.emit('message', m); });
    await settle();
    assert.deepEqual(t.f.calls, [['k-1', 'k-2', 'k-3']]);
    ms.forEach(function (m) { assert.equal(m.acks, 1); assert.equal(m.nacks, 0); });
});

test('a partial batch waits maxWaitMs, then flushes', async function () {
    const t = setup(ok);
    const m = message([evt(1)]);
    t.sub.emit('message', m);
    await settle();
    assert.equal(t.f.calls.length, 0);
    await t.c.advance(999);
    assert.equal(t.f.calls.length, 0);
    await t.c.advance(1);
    assert.equal(t.f.calls.length, 1);
    assert.equal(m.acks, 1);
});

test('an outage nacks the batch (never acks) and opens the breaker', async function () {
    const t = setup(function (n) { return n === 1 ? Promise.reject(new OutageError('ingestor unavailable', 503)) : ok(); });
    const ms = [message([evt(1)]), message([evt(2)]), message([evt(3)])];
    ms.forEach(function (m) { t.sub.emit('message', m); });
    await settle();
    ms.forEach(function (m) { assert.equal(m.nacks, 1); assert.equal(m.acks, 0); });
    // The next message waits for the breaker: max(250, 0.5 * 5000) = 2500 ms.
    const next = message([evt(4)]);
    t.sub.emit('message', next);
    await t.c.advance(1000);
    assert.equal(t.f.calls.length, 1, 'no flush while the breaker is open');
    await t.c.advance(1500);
    assert.equal(t.f.calls.length, 2);
    assert.equal(next.acks, 1);
    assert.equal(t.s.breakerOpenings, 0, 'a successful flush closes the breaker');
    assert.ok(t.logs.some(function (l) { return /nacked for redelivery/.test(l); }));
});

test('the breaker ceiling doubles per opening, capped at 5 minutes', async function () {
    const t = setup(function () { return Promise.reject(new OutageError('down', 503)); }, { maxBatchMessages: 1 });
    const waits = [];
    for (let i = 0; i < 9; i++) {
        t.sub.emit('message', message([evt(i)]));
        await settle();
        waits.push(t.s.breakerUntil - t.c.now());
        await t.c.advance(waits[i]);
    }
    assert.equal(waits[0], BREAKER_BASE_MS / 2);
    assert.equal(waits[1], BREAKER_BASE_MS);
    assert.equal(waits[8], 150000, 'half of the 5 min cap');
});

test('an unexpected error also nacks; nothing undelivered is acked', async function () {
    const t = setup(function () { return Promise.reject(new TypeError('bug')); });
    const m = message([evt(1)]);
    t.s.maxBatchMessages = 1;
    t.sub.emit('message', m);
    await settle();
    assert.equal(m.nacks, 1);
    assert.equal(m.acks, 0);
});

test('one flusher: a second batch waits for the first', async function () {
    let release;
    const t = setup(function (n) { return n === 1 ? new Promise(function (r) { release = r; }) : ok(); }, { maxBatchMessages: 1 });
    t.sub.emit('message', message([evt(1)]));
    t.sub.emit('message', message([evt(2)]));
    await settle();
    assert.equal(t.f.calls.length, 1);
    release({ accepted: 1, rejected: 0, invalid: 0, duplicates: 0 });
    await settle();
    await settle();
    assert.equal(t.f.calls.length, 2);
});

test('stop: flushes what is waiting, closes the subscription; messages after stop are nacked', async function () {
    const t = setup(ok);
    const m = message([evt(1)]);
    t.sub.emit('message', m);
    const stats = await t.s.stop(5000);
    assert.equal(m.acks, 1);
    assert.equal(stats.acked, 1);
    assert.equal(t.sub.closed, true);
    const late = message([evt(2)]);
    t.s.add(late);
    assert.equal(late.nacks, 1);
});

test('stop with the breaker open: waiting messages are nacked, not acked', async function () {
    const t = setup(function () { return Promise.reject(new OutageError('down', 503)); }, { maxBatchMessages: 1 });
    t.sub.emit('message', message([evt(1)]));
    await settle();
    const waiting = message([evt(2)]);
    t.sub.emit('message', waiting);
    await t.s.stop(100);
    assert.equal(waiting.nacks, 1);
    assert.equal(waiting.acks, 0);
});

// ── End to end with the real Forwarder and the mock ingestor ─────────────
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const MOCK = [
    process.env.AFORO_MOCK_INGESTOR,
    path.join(repoRoot, '..', 'aforo-metering-sdks', 'mock-ingestor', 'bin', 'mock-ingestor.mjs'),
    path.join(repoRoot, '..', 'Nextgen_Aforo', 'aforo-metering-sdks', 'mock-ingestor', 'bin', 'mock-ingestor.mjs'),
].filter(Boolean).find(function (p) { return fs.existsSync(p); });

test('end to end: an outage nacks, the redelivery is accepted once per key', async function () {
    assert.ok(MOCK, 'mock ingestor not found: set AFORO_MOCK_INGESTOR');
    const key = 'sk_test_pubsub';
    const mock = spawn(process.execPath, [MOCK, '--port', '0', '--api-key', key], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
        const base = await new Promise(function (resolve, reject) {
            let buf = '';
            mock.stdout.on('data', function (d) { buf += d; try { resolve(JSON.parse(buf.split('\n')[0]).url); } catch (e) { /* partial line */ } });
            mock.on('exit', function (code) { reject(new Error('mock exited ' + code)); });
        });
        const control = function (method, p, body) {
            return fetch(base + p, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
                .then(function (r) { return r.status === 204 ? null : r.json().catch(function () { return null; }); });
        };
        await control('POST', '/__control/faults', { faults: [{ status: 503, times: 3 }] });
        const fwd = new Forwarder({ ingestUrl: base + '/v1/ingest/batch', apiKey: key, maxRetries: 2, timeoutMs: 2000, budgetMs: 10000 },
            { sleep: function () { return Promise.resolve(); }, log: quiet });
        const sub = new FakeSubscription();
        const s = new BatchingSubscriber(sub, fwd, { maxBatchMessages: 2, maxWaitMs: 10 }, { log: quiet, random: function () { return 0; } }).start();
        const ms = [message([{ customerId: 'cust_1', metricName: 'api_calls', quantity: 1, idempotencyKey: 'msg-a', occurredAt: new Date().toISOString(), productType: 'API' }]),
            message([{ customerId: 'cust_1', metricName: 'api_calls', quantity: 1, idempotencyKey: 'msg-b', occurredAt: new Date().toISOString(), productType: 'API' }])];
        ms.forEach(function (m) { sub.emit('message', m); });
        await s.flushing;
        ms.forEach(function (m) { assert.equal(m.nacks, 1); assert.equal(m.acks, 0); });
        // Pub/Sub redelivers the same messages (same data, same keys).
        await new Promise(function (r) { setTimeout(r, 300); });
        ms.forEach(function (m) { sub.emit('message', m); });
        for (let i = 0; i < 200 && !ms.every(function (m) { return m.acks === 1; }); i++) {
            await new Promise(function (r) { setTimeout(r, 10); });
        }
        ms.forEach(function (m) { assert.equal(m.acks, 1); });
        const st = await control('GET', '/__control/state');
        assert.equal(st.uniqueKeys, 2);
        assert.equal(st.acceptedCount, 2);
        await s.stop(1000);
    } finally {
        mock.kill('SIGTERM');
    }
});
