/**
 * Aforo Pre-Flight Quota Check for AWS Lambda (API Gateway integration)
 *
 * Called in the authorizer or pre-invoke phase. Synchronous check against
 * the usage-ingestor /api/v1/quota/check endpoint.
 *
 * Fail behaviour: a timeout, a network error, a non-2xx status or a body
 * without an ALLOW / WARN / DENY decision returns config.preflightFallback
 * (default ALLOW) and is not cached.
 *
 * Decisions are cached per container, keyed by a SHA-256 fingerprint of the
 * API key, config.tenantId (when set), the customer and the metric, so one
 * workspace's DENY is never served to another workspace's caller. ALLOW and
 * WARN are cached for config.allowCacheTtlMs (default 1000 ms); DENY until
 * the server's retryAfterMs, at most 60 s (a wallet top-up must unblock
 * quickly), or 5 s when the server sent none. A cached DENY reports the
 * remaining wait in retryAfterMs. The cache holds at most
 * config.cacheMaxEntries (default 5000) entries.
 *
 * Requests reuse TLS connections (keep-alive agent), so only the first call
 * in a container pays the handshake.
 */
'use strict';

const https = require('https');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_ALLOW_CACHE_MS = 1000;
const DEFAULT_DENY_CACHE_MS = 5000;
const MAX_DENY_CACHE_MS = 60000;
// No retryAfterMs from the ingestor: the DENY is cached this long, and the
// 429 tells the client the same (Kong 2.8.0 does the same).
const DEFAULT_DENY_RETRY_S = 5;
const DEFAULT_CACHE_MAX_ENTRIES = 5000;
const MAX_RESPONSE_BYTES = 65536;
const DECISIONS = new Set(['ALLOW', 'WARN', 'DENY']);

const agent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const cache = new Map();

function positive(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function cacheGet(key, now) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) { cache.delete(key); return undefined; }
    cache.delete(key);
    cache.set(key, hit);
    if (hit.data.decision === 'DENY') {
        // The wait left, not the one the server gave when the entry was stored.
        return { ...hit.data, retryAfterMs: hit.expiresAt - now };
    }
    return hit.data;
}

/** Same approach as margin-guard.js: never keep the raw key in the cache. */
function keyFingerprint(apiKey) {
    return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

function cacheSet(key, data, ttlMs, maxEntries, now) {
    cache.delete(key);
    cache.set(key, { data, expiresAt: now + ttlMs });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

/** How long a decision may be reused, or 0 to not cache it. */
function cacheTtl(data, config) {
    if (data.decision === 'DENY') {
        return Math.min(positive(data.retryAfterMs, DEFAULT_DENY_CACHE_MS), MAX_DENY_CACHE_MS);
    }
    return positive(config.allowCacheTtlMs, DEFAULT_ALLOW_CACHE_MS);
}

/**
 * Check pre-flight quota for a customer.
 *
 * @param {Object} config - { preflightEnabled, preflightUrl, apiKey, tenantId,
 *   timeoutMs, preflightFallback, allowCacheTtlMs, cacheMaxEntries }
 *   tenantId is optional and only scopes the local cache.
 *   apiKey is sent as X-API-Key (the tenant is derived from the key).
 * @param {string} customerId - Customer identifier
 * @param {string} [metricName] - Optional metric name
 * @returns {Promise<{decision: string, reason?: string, headers?: Object}>}
 */
async function checkPreFlightQuota(config, customerId, metricName) {
    if (!config.preflightEnabled) return { decision: 'ALLOW' };
    if (!customerId) return { decision: 'ALLOW' };

    const fallback = config.preflightFallback || 'ALLOW';
    const now = Date.now();
    const key = [keyFingerprint(config.apiKey || ''), config.tenantId || '', customerId, metricName || ''].join('\u0000');
    const cached = cacheGet(key, now);
    if (cached) return cached;

    let url;
    try {
        url = new URL(config.preflightUrl);
    } catch (e) {
        console.warn('[aforo-preflight] preflightUrl is not a URL:', e.message);
        return { decision: fallback };
    }
    if (url.protocol !== 'https:') {
        console.warn('[aforo-preflight] preflightUrl must use https');
        return { decision: fallback };
    }
    if (!config.apiKey) {
        console.warn('[aforo-preflight] No apiKey configured');
        return { decision: fallback };
    }

    const payload = JSON.stringify({ customerId, metricName });
    const timeoutMs = positive(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        agent,
        headers: {
            'Content-Type': 'application/json',
            // X-API-Key alone: Bearer is parsed as a JWT and rejected 401.
            // The tenant comes from the key, so no X-Tenant-Id is sent.
            'X-API-Key': config.apiKey,
            'Content-Length': Buffer.byteLength(payload),
        },
    };

    return new Promise((resolve) => {
        let settled = false;
        const finish = (data, ttlMs) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (ttlMs > 0) {
                cacheSet(key, data, ttlMs, Math.floor(positive(config.cacheMaxEntries, DEFAULT_CACHE_MAX_ENTRIES)), Date.now());
            }
            resolve(data);
        };
        const fail = (msg) => {
            console.warn('[aforo-preflight]', msg);
            finish({ decision: fallback }, 0);
        };

        const req = https.request(options, (res) => {
            const status = res.statusCode || 0;
            let body = '';
            let size = 0;
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                size += Buffer.byteLength(chunk);
                if (size > MAX_RESPONSE_BYTES) {
                    req.destroy();
                    fail('Response too large');
                    return;
                }
                body += chunk;
            });
            res.on('end', () => {
                if (status < 200 || status >= 300) {
                    fail(`HTTP ${status}`);
                    return;
                }
                let data;
                try {
                    const parsed = JSON.parse(body);
                    data = parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object'
                        ? parsed.data : parsed;
                } catch (e) {
                    fail(`Parse error: ${e.message}`);
                    return;
                }
                if (!data || !DECISIONS.has(data.decision)) {
                    fail('Response has no ALLOW / WARN / DENY decision');
                    return;
                }
                finish(data, cacheTtl(data, config));
            });
            res.on('error', (err) => fail(`Response error: ${err.message}`));
        });

        const timer = setTimeout(() => {
            req.destroy();
            fail(`Timeout after ${timeoutMs} ms`);
        }, timeoutMs);

        req.on('error', (err) => fail(`Request error: ${err.message}`));
        req.write(payload);
        req.end();
    });
}

/**
 * Build a 429 response for API Gateway Lambda proxy integration.
 * Retry-After is retryAfterMs rounded up to whole seconds (at least 1), or
 * DEFAULT_DENY_RETRY_S (5 s) when the decision carries no wait.
 */
function build429Response(data) {
    const waitMs = Number(data.retryAfterMs);
    const retryAfter = Number.isFinite(waitMs) && waitMs > 0 ? Math.max(1, Math.ceil(waitMs / 1000)) : DEFAULT_DENY_RETRY_S;
    const headers = {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        ...(data.headers || {}),
    };

    return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
            message: data.reason || 'Rate limit exceeded',
            retryAfter,
        }),
    };
}

module.exports = {
    checkPreFlightQuota,
    build429Response,
    _test: { agent, cache, reset() { cache.clear(); } },
};
