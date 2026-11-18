/**
 * Delivery flow scenarios — run by tests/run-dataweave.sh after
 * dataweave.test.cjs (needs the DataWeave CLI; DW_BIN as there).
 *
 * dataweave.test.cjs checks each script alone. This file checks how the
 * metering block uses them together: which pending entries a delivery
 * claims, what one request carries, and what happens to events a delivery
 * could not deliver.
 *
 * No Mule runtime is involved. `delivery()` below restates, in JavaScript,
 * the steps of the async scope in template.xml (claim own entry, list keys,
 * walk the others, build the batch, up to 3 attempts, put back), and calls
 * the template's own DataWeave scripts (claim, batch, delivery, put-back)
 * for every decision. The pending store is a Map whose remove() throws when
 * the key is gone, which is what the ObjectStore connector does
 * (OS:KEY_NOT_FOUND, under a per-key lock). policy.test.cjs pins the XML to
 * the same order of steps. What this cannot show is the runtime itself: the
 * async scope's queueing, the connector, the HTTP requester.
 * tests/policy-contract.md has the live checklist for those.
 *
 * `delivery()` is a generator that yields before every store or HTTP step,
 * so a scenario can run two deliveries one step at a time, in any order.
 */
'use strict';

const { runCases } = require('./dw-runner.cjs');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL: ' + name + (detail !== undefined ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
    check(name, JSON.stringify(actual) === JSON.stringify(expected),
        'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

// One CLI call per distinct (script, vars); the scripts are pure.
const memo = new Map();
function dw(name, vars) {
    const key = name + '\u0000' + JSON.stringify(vars);
    if (!memo.has(key)) {
        const r = runCases(name, [{ vars: vars, attributes: {}, payload: null }])[0];
        if (!r.ok) throw new Error('script ' + name + ' failed: ' + r.error);
        memo.set(key, r.result);
    }
    return memo.get(key);
}

function event(key, metric) {
    return { productType: 'API', customerId: 'cust-1', metricName: metric || 'api_calls', quantity: 1,
        idempotencyKey: key, occurredAt: '2026-10-22T07:26:13.125Z' };
}

// The world one scenario runs in: the pending store, the ingestor, the log.
function world(answer) {
    const w = {
        store: new Map(),
        requests: [],          // every POST: {keys, text}
        accepted: new Map(),   // idempotencyKey -> times the ingestor stored it
        logs: [],
        pb: 0,
        limit: 10000
    };
    w.remove = function (key) {
        if (!w.store.has(key)) throw new Error('OS:KEY_NOT_FOUND');
        w.store.delete(key);
    };
    // A call: the events script's payload, stored under the request id.
    w.call = function (id, events) {
        const c = { id: id, events: events, text: JSON.stringify({ events: events }) };
        if (w.store.size < w.limit) w.store.set(id, c.text);
        return c;
    };
    // The ingestor. `answer(requestNumber, events)` -> {status, errors?, retryAfter?};
    // default 202 with every event stored.
    w.post = function (text) {
        const events = JSON.parse(text).events;
        const n = w.requests.length + 1;
        w.requests.push({ keys: events.map(function (e) { return e.idempotencyKey; }), text: text, events: events });
        const a = (answer && answer(n, events)) || { status: 202 };
        if (a.status >= 200 && a.status < 300) {
            const bad = {};
            (a.errors || []).forEach(function (e) { bad[e.index] = true; });
            events.forEach(function (e, i) {
                if (!bad[i]) w.accepted.set(e.idempotencyKey, (w.accepted.get(e.idempotencyKey) || 0) + 1);
            });
        }
        return {
            status: a.status,
            text: a.status >= 200 && a.status < 300
                ? JSON.stringify({ success: true, data: { accepted: 0, failed: (a.errors || []).length, errors: a.errors || [] } }) : '',
            retryAfter: a.retryAfter === undefined ? null : a.retryAfter
        };
    };
    return w;
}

// The async scope of the METER BLOCK, step for step.
function* delivery(w, call) {
    let claimed = [];
    let batch = null;
    let reason = null;
    try {
        yield 'retrieve own';
        const own = w.store.has(call.id) ? w.store.get(call.id) : '';
        if (own !== '') {
            yield 'remove own';
            try { w.remove(call.id); claimed = [own]; } catch (e) { /* another delivery owns it */ }
        }
        if (claimed.length === 0) return;

        let claim = { take: true, events: call.events.length, chars: own.length, full: false };
        yield 'list keys';
        const others = Array.from(w.store.keys()).filter(function (k) { return k !== call.id; }).slice(0, 500);
        for (let i = 0; i < others.length; i++) {
            if (claim.full) break;
            yield 'retrieve other';
            const text = w.store.has(others[i]) ? w.store.get(others[i]) : '';
            const next = dw('claim', { aforoClaim: claim, aforoOtherText: text });
            if (next.take) {
                yield 'remove other';
                try { w.remove(others[i]); claimed = claimed.concat([text]); claim = next; } catch (e) { /* taken meanwhile */ }
            }
        }

        const built = dw('batch', { aforoClaimed: claimed });
        batch = { text: built.text, counts: built.counts };
        let d = { retryText: built.text, retryCounts: built.counts, retryReason: '' };
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (d.retryText === null) continue;
            yield 'post';
            const resp = w.post(batch.text);
            d = dw('delivery', { aforoBatch: batch, aforoIngestResponse: resp, aforoAttempt: attempt, aforoJitter: 0.5, aforoNowMs: 1761609600000 });
            if (d.refusedLog !== null) w.logs.push(d.refusedLog);
            batch = { text: d.retryText, counts: d.retryCounts };
        }
        if (d.retryText !== null) reason = d.retryReason;
    } catch (e) {
        reason = String(e.message);
    }
    if (reason !== null) {
        yield 'put back';
        const pb = dw('put-back', { aforoBatch: batch, aforoClaimed: claimed, aforoFailReason: reason, aforoReq: { requestId: call.id } });
        pb.entries.forEach(function (t) { w.pb++; w.store.set('pb-' + w.pb, t); });
        w.logs.push(pb.log);
        if (pb.droppedLog !== null) w.logs.push(pb.droppedLog);
    }
}

function run(gen) { while (!gen.next().done) { /* to the end */ } }
// Steps two deliveries in the order `pick()` chooses (0 or 1) until both end.
function interleave(a, b, pick) {
    const gens = [a, b];
    const done = [false, false];
    while (!done[0] || !done[1]) {
        let i = pick();
        if (done[i]) i = 1 - i;
        done[i] = gens[i].next().done;
    }
}
function rng(seed) {
    let s = seed >>> 0;
    return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function allKeys(w) {
    return w.requests.reduce(function (acc, r) { return acc.concat(r.keys); }, []);
}
function storedEvents(w) {
    let n = 0;
    w.store.forEach(function (t) { n += JSON.parse(t).events.length; });
    return n;
}

try {
    // ── 1. Light load: one call, one delivery, the request it sends today ──
    {
        const w = world();
        const c = w.call('call-1', [event('call-1')]);
        run(delivery(w, c));
        eq('light load: one request', w.requests.length, 1);
        eq('light load: the body is the call\'s stored payload, byte for byte', w.requests[0].text, c.text);
        eq('light load: the pending store is empty afterwards', w.store.size, 0);
        eq('light load: stored once', w.accepted.get('call-1'), 1);
    }

    // ── 2. Under load: waiting calls go out in the next delivery ──
    {
        const w = world();
        const calls = [1, 2, 3, 4, 5].map(function (i) { return w.call('call-' + i, [event('call-' + i)]); });
        calls.push(w.call('call-6', [event('mcp:42:call-6:1:search', 'mcp_server.tool_invocations'), event('mcp:42:call-6:2:fetch', 'mcp_server.tool_invocations')]));
        run(delivery(w, calls[0]));
        eq('under load: six waiting calls, one request', w.requests.length, 1);
        eq('under load: the request holds every waiting event, each with the key its call froze',
            w.requests[0].keys, ['call-1', 'call-2', 'call-3', 'call-4', 'call-5', 'mcp:42:call-6:1:search', 'mcp:42:call-6:2:fetch']);
        eq('under load: the events are the stored events, unchanged', w.requests[0].events,
            calls.reduce(function (acc, c) { return acc.concat(c.events); }, []));
        calls.slice(1).forEach(function (c) { run(delivery(w, c)); });
        eq('under load: the other calls\' own deliveries send nothing', w.requests.length, 1);
        eq('under load: nothing left in the pending store', w.store.size, 0);
    }

    // ── 3. Two deliveries at once never send the same event ──
    {
        let worst = null;
        let schedules = 0;
        const picks = [
            function () { return 0; },                       // one after the other
            function () { return 1; },
            (function () { let t = 0; return function () { return (t++) % 2; }; })()   // strict alternation
        ];
        for (let seed = 1; seed <= 60; seed++) {
            const r = rng(seed);
            picks.push(function () { return r() < 0.5 ? 0 : 1; });
        }
        picks.forEach(function (pick, n) {
            const w = world();
            const calls = [1, 2, 3, 4].map(function (i) { return w.call('call-' + i, [event('call-' + i)]); });
            interleave(delivery(w, calls[0]), delivery(w, calls[1]), pick);
            calls.slice(2).forEach(function (c) { run(delivery(w, c)); });
            const keys = allKeys(w).slice().sort();
            schedules++;
            if (JSON.stringify(keys) !== JSON.stringify(['call-1', 'call-2', 'call-3', 'call-4']) || w.store.size !== 0) {
                worst = worst || ('schedule ' + n + ': sent ' + JSON.stringify(allKeys(w)) + ', left ' + w.store.size);
            }
        });
        check('two concurrent deliveries: every event is sent exactly once, in ' + schedules + ' interleavings', worst === null, worst);
    }

    // ── 4. A delivery that fails puts its events back; a later call sends them once ──
    {
        const w = world(function (n) { return n <= 3 ? { status: 503 } : { status: 202 }; });
        const a = w.call('call-1', [event('call-1')]);
        const b = w.call('call-2', [event('call-2')]);
        run(delivery(w, a));
        eq('failed delivery: 3 attempts', w.requests.length, 3);
        eq('failed delivery: every attempt carries the same keys', w.requests.map(function (r) { return r.keys.join(','); }),
            ['call-1,call-2', 'call-1,call-2', 'call-1,call-2']);
        eq('failed delivery: both events are back in the pending store, count 1',
            Array.from(w.store.values()).map(function (t) { return JSON.parse(t); }),
            [{ events: [event('call-1'), event('call-2')], putBacks: 1 }]);
        eq('failed delivery: the log says so',
            w.logs, ['[aforo-metering] USAGE NOT DELIVERED (the ingestor answered HTTP 503): 2 event(s) put back for a later call\'s delivery']);
        run(delivery(w, b));
        eq('failed delivery: the call whose entry was taken sends nothing itself', w.requests.length, 3);
        const c = w.call('call-3', [event('call-3')]);
        run(delivery(w, c));
        eq('later call: one request with its own event and the two put back, same keys', w.requests[3].keys, ['call-3', 'call-1', 'call-2']);
        eq('later call: the put-back count is not sent', w.requests[3].events, [event('call-3'), event('call-1'), event('call-2')]);
        eq('later call: each event stored exactly once',
            ['call-1', 'call-2', 'call-3'].map(function (k) { return w.accepted.get(k); }), [1, 1, 1]);
        eq('later call: the pending store is empty', w.store.size, 0);
    }

    // ── 5. Only what the ingestor calls retryable goes back; a permanent reject does not ──
    {
        const w = world(function (n, events) {
            if (n > 3) return { status: 202 };
            return { status: 202, errors: events.map(function (e, i) {
                return e.idempotencyKey === 'call-1' ? { index: i, message: 'The event could not be stored', retryable: true }
                    : e.idempotencyKey === 'call-2' ? { index: i, message: 'Unknown metric: nope', retryable: false } : null;
            }).filter(function (x) { return x !== null; }) };
        });
        const a = w.call('call-1', [event('call-1')]);
        w.call('call-2', [event('call-2', 'nope')]);
        w.call('call-3', [event('call-3')]);
        run(delivery(w, a));
        eq('partial failure: attempt 1 sends all three, attempts 2 and 3 only the retryable one',
            w.requests.map(function (r) { return r.keys.join(','); }), ['call-1,call-2,call-3', 'call-1', 'call-1']);
        eq('partial failure: only the retryable event is put back',
            Array.from(w.store.values()).map(function (t) { return JSON.parse(t); }), [{ events: [event('call-1')], putBacks: 1 }]);
        check('partial failure: the permanent reject is logged, once',
            w.logs.filter(function (l) { return l.indexOf('USAGE EVENT REFUSED') !== -1; }).length === 1 &&
            w.logs.join('\n').indexOf('nope call-2: Unknown metric: nope') !== -1, w.logs.join(' // '));
        const d = w.call('call-4', [event('call-4')]);
        run(delivery(w, d));
        eq('partial failure: the next call sends the retryable event once more, same key', w.requests[3].keys, ['call-4', 'call-1']);
        eq('partial failure: the rejected event was never stored nor sent again',
            [w.accepted.get('call-2'), allKeys(w).filter(function (k) { return k === 'call-2'; }).length], [undefined, 1]);
        eq('partial failure: stored exactly once each', ['call-1', 'call-3', 'call-4'].map(function (k) { return w.accepted.get(k); }), [1, 1, 1]);
    }

    // ── 6. A long outage: an event is put back 3 times, then dropped ──
    {
        const w = world(function () { return { status: 503 }; });
        let c = w.call('call-1', [event('call-1')]);
        const counts = [];
        for (let round = 1; round <= 4; round++) {
            run(delivery(w, c));
            counts.push(Array.from(w.store.values()).map(function (t) {
                const e = JSON.parse(t);
                return e.events.map(function (x) { return x.idempotencyKey + ':' + e.putBacks; }).join(',');
            }).sort().join(' '));
            c = w.call('call-' + (round + 1), [event('call-' + (round + 1))]);
        }
        eq('outage: put-back counts rise by one per failed delivery; past 3 the event leaves',
            counts, ['call-1:1', 'call-1:2 call-2:1', 'call-1:3 call-2:2 call-3:1', 'call-2:3 call-3:2 call-4:1']);
        check('outage: the dropped event is named', w.logs.indexOf('[aforo-metering] USAGE DROPPED after 3 put-backs: api_calls call-1') !== -1, w.logs.join(' // '));
        eq('outage: 4 deliveries of 3 attempts each', w.requests.length, 12);
    }

    // ── 7. The 500-event cap ──
    {
        const w = world();
        const first = w.call('call-0', [event('call-0')]);
        const calls = [];
        for (let i = 1; i <= 13; i++) {
            const evs = [];
            for (let j = 0; j < 50; j++) evs.push(event('c' + i + '-' + j, 'mcp_server.tool_invocations'));
            calls.push(w.call('call-' + i, evs));
        }
        run(delivery(w, first));
        eq('cap: 651 events waiting, the first request takes 451 (own + 9 whole entries of 50)', w.requests[0].keys.length, 451);
        eq('cap: the entries that did not fit are still waiting', storedEvents(w), 200);
        calls.forEach(function (c) { run(delivery(w, c)); });
        check('cap: no request has more than 500 events', w.requests.every(function (r) { return r.keys.length <= 500; }),
            w.requests.map(function (r) { return r.keys.length; }).join(','));
        eq('cap: every event sent exactly once', [allKeys(w).length, new Set(allKeys(w)).size, w.store.size], [651, 651, 0]);
        eq('cap: two requests in all', w.requests.length, 2);
    }
    {
        // A call with 50 events, 9 more entries that bring the request to exactly 500, and one that must wait.
        const w = world();
        const calls = [];
        for (let i = 0; i <= 10; i++) {
            const evs = [];
            for (let j = 0; j < 50; j++) evs.push(event('d' + i + '-' + j, 'mcp_server.tool_invocations'));
            calls.push(w.call('call-' + i, evs));
        }
        run(delivery(w, calls[0]));
        eq('cap: the first request holds exactly 500 events', w.requests[0].keys.length, 500);
        run(delivery(w, calls[10]));
        eq('cap: the entry that did not fit goes in the next request', w.requests.map(function (r) { return r.keys.length; }), [500, 50]);
    }
} catch (e) {
    if (e.noCli) {
        console.error(e.message);
        process.exit(2);
    }
    failed++;
    console.error('FAIL: ' + (e.stack || e.message));
}

console.log('\nMuleSoft delivery flow scenarios: ' + passed + ' passed, ' + failed + ' failed (' + memo.size + ' DataWeave calls)');
process.exit(failed === 0 ? 0 : 1);
