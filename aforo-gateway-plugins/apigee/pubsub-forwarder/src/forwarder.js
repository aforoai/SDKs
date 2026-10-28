'use strict';
/**
 * Aforo Pub/Sub forwarder: the delivery half of the Apigee "pubsub" mode.
 *
 * aforo-metering's AforoMeteringPublish step writes each call's events
 * ({"events":[...]}) as one Pub/Sub message. subscriber.js collects messages
 * from a pull subscription and hands their data to Forwarder.forward(), which
 * sends the events to the ingestor in batches and resolves only when every
 * event was accepted or permanently rejected. On an outage it THROWS; the
 * subscriber then nacks the messages, Pub/Sub redelivers them after the
 * subscription's retry delay, and nothing is lost while the subscription
 * keeps them (7 days by default). Events the ingestor already accepted are
 * sent again on redelivery; the ingestor deduplicates on idempotencyKey,
 * which the flow froze to Apigee's messageid (Rule #21).
 *
 * Transport rules follow aforo-metering-sdks/contract/TRANSPORT-SPEC.md:
 *   - batches of at most 500 events and 4 MiB of JSON, no Content-Encoding
 *   - the API key only as X-API-Key, never logged
 *   - https only (http for localhost or with allowInsecureHttp)
 *   - one total deadline per request, covering the response body
 *   - retry network errors, timeouts, 408, 429 and every 5xx with full
 *     jitter (base 500 ms, max 30 s); Retry-After read as seconds (may be
 *     fractional) or an HTTP-date, delay = max(retryAfter, jitter), cap 60 s
 *   - 413: split in half; a single event still 413 is rejected
 *   - 401, 403 and any 3xx: outage (a fixed key or URL must not lose usage);
 *     redirects are never followed
 *   - other 4xx: the batch is rejected (logged with its idempotency keys)
 *   - 2xx with errors[]: retryable events are re-sent with the same keys up
 *     to maxRetries times, then outage; the rest are rejected
 *
 * Same logic as azure-apim/eventhub-forwarder/src/forwarder.js, without the
 * compound endpoint (the Apigee flows send no compound events).
 */

const DEFAULTS = Object.freeze({
    ingestUrl: 'https://api.aforo.ai/v1/ingest/batch',
    apiKey: '',
    maxEvents: 500,
    maxBodyBytes: 4 * 1024 * 1024,
    timeoutMs: 10000,
    maxRetries: 5,
    baseDelayMs: 500,
    maxDelayMs: 30000,
    retryAfterCapMs: 60000,
    budgetMs: 2 * 60 * 1000,
    allowInsecureHttp: false,
});

class OutageError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'OutageError';
        this.kind = 'outage';
        this.status = status;
    }
}

function positiveInt(raw, fallback, max) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const n = Number(String(raw).trim());
    if (!Number.isInteger(n) || n < 1) throw new Error('expected a positive integer, got ' + JSON.stringify(raw));
    return max !== undefined ? Math.min(n, max) : n;
}

function configFromEnv(env) {
    const e = env || {};
    return validateConfig({
        ingestUrl: e.AFORO_INGEST_URL || DEFAULTS.ingestUrl,
        apiKey: e.AFORO_API_KEY || '',
        maxEvents: positiveInt(e.AFORO_BATCH_MAX_EVENTS, DEFAULTS.maxEvents, 1000),
        maxBodyBytes: DEFAULTS.maxBodyBytes,
        timeoutMs: positiveInt(e.AFORO_REQUEST_TIMEOUT_MS, DEFAULTS.timeoutMs),
        maxRetries: positiveInt(e.AFORO_MAX_RETRIES, DEFAULTS.maxRetries, 20),
        baseDelayMs: DEFAULTS.baseDelayMs,
        maxDelayMs: DEFAULTS.maxDelayMs,
        retryAfterCapMs: DEFAULTS.retryAfterCapMs,
        budgetMs: positiveInt(e.AFORO_FLUSH_BUDGET_MS, DEFAULTS.budgetMs),
        allowInsecureHttp: String(e.AFORO_ALLOW_INSECURE_HTTP || '').toLowerCase() === 'true',
    });
}

function checkUrl(name, value, allowInsecureHttp) {
    let u;
    try { u = new URL(value); } catch (err) { throw new Error(name + ' is not a URL'); }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1';
    if (u.protocol === 'https:') return u;
    if (u.protocol === 'http:' && (local || allowInsecureHttp)) return u;
    throw new Error(name + ' must be https:// (http only for localhost or with AFORO_ALLOW_INSECURE_HTTP=true)');
}

function validateConfig(partial) {
    const cfg = Object.assign({}, DEFAULTS, partial || {});
    if (!cfg.apiKey || !String(cfg.apiKey).trim()) throw new Error('AFORO_API_KEY is not set');
    checkUrl('AFORO_INGEST_URL', cfg.ingestUrl, cfg.allowInsecureHttp);
    return Object.freeze(cfg);
}

/**
 * Reads Pub/Sub message data (Buffer, string or an already-parsed object)
 * into usage events. A message that is not {"events":[...]} can never be
 * delivered: it is counted as invalid and logged.
 */
function parseMessages(messages, log) {
    const usage = [];
    const seenKeys = new Set();
    let invalid = 0;
    let duplicates = 0;
    (Array.isArray(messages) ? messages : [messages]).forEach(function (m) {
        let v = m;
        try {
            if (Buffer.isBuffer(v)) v = v.toString('utf8');
            if (typeof v === 'string') v = JSON.parse(v);
        } catch (err) {
            invalid++;
            log.warn('aforo-forwarder: skipped a message that is not JSON');
            return;
        }
        if (v && typeof v === 'object' && Array.isArray(v.events)) {
            v.events.forEach(function (evt) {
                if (!evt || typeof evt !== 'object' || Array.isArray(evt)) { invalid++; return; }
                const key = typeof evt.idempotencyKey === 'string' ? evt.idempotencyKey : '';
                if (key && seenKeys.has(key)) { duplicates++; return; }
                if (key) seenKeys.add(key);
                usage.push(evt);
            });
            return;
        }
        invalid++;
        log.warn('aforo-forwarder: skipped a message that is not a usage batch');
    });
    return { usage: usage, invalid: invalid, duplicates: duplicates };
}

/** Greedy chunks of at most maxEvents events and maxBodyBytes of JSON. */
function chunk(events, maxEvents, maxBodyBytes) {
    const out = [];
    let cur = [];
    let bytes = 12; // {"events":[]}
    events.forEach(function (evt) {
        const size = Buffer.byteLength(JSON.stringify(evt)) + 1;
        if (cur.length > 0 && (cur.length >= maxEvents || bytes + size > maxBodyBytes)) {
            out.push(cur);
            cur = [];
            bytes = 12;
        }
        cur.push(evt);
        bytes += size;
    });
    if (cur.length) out.push(cur);
    return out;
}

function parseRetryAfter(value, nowMs) {
    if (value === null || value === undefined) return null;
    const v = String(value).trim();
    if (v === '') return null;
    if (/^[0-9]+(\.[0-9]+)?$/.test(v)) return Math.round(Number(v) * 1000);
    const at = Date.parse(v);
    if (Number.isNaN(at)) return null;
    return Math.max(0, at - nowMs);
}

function backoffMs(attempt, cfg, deps) {
    const ceiling = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * Math.pow(2, attempt));
    return Math.floor(deps.random() * ceiling);
}

function isRetryableStatus(status) {
    return status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function unwrap(json) {
    if (json && typeof json === 'object' && json.data && typeof json.data === 'object' && 'success' in json) return json.data;
    return json || {};
}

function keysOf(events) {
    return events.map(function (e) { return e.idempotencyKey || '?'; });
}

// The ingestor's answer is a status and per-event results: well under this
// even for 500 rejected events with long messages. Read at most this much, so
// a misbehaving endpoint cannot make the forwarder buffer an unbounded body.
// readCapped returns null past the cap and stops reading.
const MAX_RESPONSE_BYTES = 256 * 1024;

async function readCapped(res, max) {
    if (!res.body || typeof res.body.getReader !== 'function') {
        const t = await res.text();
        return Buffer.byteLength(t) > max ? null : t;
    }
    const reader = res.body.getReader();
    const parts = [];
    let size = 0;
    try {
        for (;;) {
            const r = await reader.read();
            if (r.done) break;
            size += r.value.byteLength;
            if (size > max) {
                await reader.cancel().catch(function () {});
                return null;
            }
            parts.push(r.value);
        }
    } finally {
        try { reader.releaseLock(); } catch (err) { /* already released */ }
    }
    return Buffer.concat(parts.map(function (p) { return Buffer.from(p.buffer, p.byteOffset, p.byteLength); })).toString('utf8');
}

class Forwarder {
    constructor(cfg, deps) {
        this.cfg = validateConfig(cfg);
        const d = deps || {};
        this.fetch = d.fetch || globalThis.fetch;
        this.now = d.now || Date.now;
        this.sleep = d.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        this.random = d.random || Math.random;
        this.log = d.log || { info: function () {}, warn: console.warn, error: console.error };
    }

    async post(url, body, deadline) {
        const left = deadline - this.now();
        if (left <= 0) throw new OutageError('aforo-forwarder: flush budget used up');
        const timeout = Math.min(this.cfg.timeoutMs, left);
        const signal = AbortSignal.timeout(timeout);
        try {
            const res = await this.fetch(url, {
                method: 'POST',
                redirect: 'manual',
                headers: { 'Content-Type': 'application/json', 'X-API-Key': this.cfg.apiKey, 'User-Agent': 'aforo-apigee-pubsub-forwarder/3.1.0' },
                body: body,
                signal: signal,
            });
            const text = await readCapped(res, MAX_RESPONSE_BYTES);
            if (text === null && res.status >= 200 && res.status < 300) {
                // Without the per-event results the batch can't be counted as
                // accepted: retry it (same keys, so no double count).
                return { status: 0, error: 'response over ' + MAX_RESPONSE_BYTES + ' bytes' };
            }
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (err) { json = null; }
            return { status: res.status, retryAfter: res.headers.get('retry-after'), json: json, location: res.headers.get('location') };
        } catch (err) {
            return { status: 0, error: err && err.name === 'TimeoutError' ? 'timeout' : 'network error' };
        }
    }

    /** POST with transport retries. Returns { kind: 'ok'|'tooLarge'|'rejected', res }. Throws OutageError. */
    async send(url, events, deadline, what) {
        const body = JSON.stringify({ events: events });
        for (let attempt = 0; ; attempt++) {
            const res = await this.post(url, body, deadline);
            const s = res.status;
            if (s >= 200 && s < 300) return { kind: 'ok', res: res };
            if ((s >= 300 && s < 400) || s === 401 || s === 403) {
                const where = s >= 300 && s < 400 && res.location ? ' (redirect to ' + safeHost(res.location) + ', not followed)' : '';
                this.log.error('aforo-forwarder: ' + what + ' refused with HTTP ' + s + where + '; check AFORO_API_KEY / AFORO_INGEST_URL. The messages are left unacked in the subscription.');
                throw new OutageError('ingestor answered HTTP ' + s, s);
            }
            if (s === 413) return { kind: 'tooLarge', res: res };
            if (!isRetryableStatus(s)) return { kind: 'rejected', res: res };
            if (attempt >= this.cfg.maxRetries) {
                throw new OutageError('ingestor unavailable after ' + (attempt + 1) + ' attempts (' + (s || res.error) + ')', s);
            }
            let delay = backoffMs(attempt, this.cfg, this);
            const ra = parseRetryAfter(res.retryAfter, this.now());
            if (ra !== null) delay = Math.max(delay, ra);
            delay = Math.min(delay, this.cfg.retryAfterCapMs);
            if (this.now() + delay >= deadline) throw new OutageError('flush budget used up while retrying', s);
            await this.sleep(delay);
        }
    }

    async deliverUsage(batch, deadline, stats, perEventAttempt) {
        const r = await this.send(this.cfg.ingestUrl, batch, deadline, 'usage batch');
        if (r.kind === 'tooLarge') {
            if (batch.length === 1) { this.reject(stats, batch, 'HTTP 413 for a single event'); return; }
            const mid = Math.ceil(batch.length / 2);
            await this.deliverUsage(batch.slice(0, mid), deadline, stats, perEventAttempt);
            await this.deliverUsage(batch.slice(mid), deadline, stats, perEventAttempt);
            return;
        }
        if (r.kind === 'rejected') { this.reject(stats, batch, 'HTTP ' + r.res.status); return; }
        const data = unwrap(r.res.json);
        const errors = Array.isArray(data.errors) ? data.errors : [];
        const retry = [];
        const rejected = [];
        const named = new Set();
        errors.forEach(function (e) {
            if (!e || !Number.isInteger(e.index) || e.index < 0 || e.index >= batch.length || named.has(e.index)) return;
            named.add(e.index);
            (e.retryable === true ? retry : rejected).push(batch[e.index]);
        });
        stats.accepted += batch.length - named.size;
        if (rejected.length) this.reject(stats, rejected, 'rejected by the ingestor');
        if (!retry.length) return;
        if (perEventAttempt >= this.cfg.maxRetries) {
            throw new OutageError(retry.length + ' events still retryable after ' + perEventAttempt + ' re-sends');
        }
        const delay = backoffMs(perEventAttempt, this.cfg, this);
        if (this.now() + delay >= deadline) throw new OutageError('flush budget used up before a re-send');
        await this.sleep(delay);
        await this.deliverUsage(retry, deadline, stats, perEventAttempt + 1);
    }

    reject(stats, events, reason) {
        stats.rejected += events.length;
        this.log.error('aforo-forwarder: dropped ' + events.length + ' event(s): ' + reason + '; keys ' + keysOf(events).slice(0, 20).join(', '));
    }

    /** Delivers one set of messages. Resolves with counts; rejects with OutageError. */
    async forward(messages) {
        const parsed = parseMessages(messages, this.log);
        const stats = { accepted: 0, rejected: 0, invalid: parsed.invalid, duplicates: parsed.duplicates };
        const deadline = this.now() + this.cfg.budgetMs;
        for (const batch of chunk(parsed.usage, this.cfg.maxEvents, this.cfg.maxBodyBytes)) {
            await this.deliverUsage(batch, deadline, stats, 0);
        }
        return stats;
    }
}

function safeHost(location) {
    try { return new URL(location).host; } catch (err) { return 'an unreadable location'; }
}

module.exports = { MAX_RESPONSE_BYTES, readCapped, Forwarder, OutageError, configFromEnv, validateConfig, parseMessages, chunk, parseRetryAfter, DEFAULTS };
