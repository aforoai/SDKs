/**
 * Aforo Margin Guard Pre-Flight Check for AWS API Gateway (Lambda)
 *
 * Asks pricing-service whether a customer is margin-blocked or throttled:
 *
 *   GET {marginGuardUrl}/api/v1/margin-guard/quick-check?scopeType=CUSTOMER&scopeId={customerId}
 *   X-API-Key: {apiKey}
 *
 * The key is the same Aforo tenant key this deployment ingests with (a
 * `usage:ingest` key). Pricing takes the tenant from the key, so no tenant id
 * is sent. The answer is flat:
 *   { "verdict": "ALLOW" | "THROTTLE" | "BLOCK", "currentLevel", "message" }
 * A THROTTLE is pricing's decision for this request (it counts requests and
 * rejects its configured share), so it is never cached and no local dice are
 * rolled. BLOCK and a plain ALLOW are cached for marginGuardCacheTtlMs.
 *
 * Before 2.4.0 this module called /internal/v1/margin-guard/quick-check, which
 * public hosts refuse, with no credential, and read `allowed` / `level` /
 * `throttleRate`, which pricing never sent, so it never blocked anything.
 *
 * Fail-open: no key, a timeout, an error status or an unreadable answer lets
 * the request through.
 *
 * config: { marginGuardEnabled, marginGuardUrl, apiKey,
 *           marginGuardCacheTtlMs (default 30000), marginGuardTimeoutMs (default 200),
 *           marginGuardCacheMaxEntries (default 10000; least recently used dropped) }
 * The cache key includes a fingerprint of apiKey, so one container used with
 * two tenants' keys never answers one tenant from the other's entry.
 *
 * The CloudWatch Logs trigger (index.js) runs after the response and cannot
 * block requests: use this from a Lambda Authorizer for real-time enforcement.
 */

'use strict';

const QUICK_CHECK_PATH = '/api/v1/margin-guard/quick-check';
const ALLOW = Object.freeze({ verdict: 'ALLOW', currentLevel: 'NONE', allowed: true });

const crypto = require('crypto');

const DEFAULT_CACHE_MAX_ENTRIES = 10000;
const DEFAULT_TIMEOUT_MS = 200;

// In-memory cache for Lambda warm starts. Bounded: expired entries are dropped
// on read and the least recently used entry is dropped once the cache is full.
const marginGuardCache = new Map();
let warnedNoKey = false;

function positive(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function cacheGet(key, now) {
    const hit = marginGuardCache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
        marginGuardCache.delete(key);
        return undefined;
    }
    marginGuardCache.delete(key); // most recently used goes to the end
    marginGuardCache.set(key, hit);
    return hit.data;
}

function cacheSet(key, data, ttlMs, maxEntries, now) {
    marginGuardCache.delete(key);
    marginGuardCache.set(key, { data, expiresAt: now + ttlMs });
    while (marginGuardCache.size > maxEntries) {
        marginGuardCache.delete(marginGuardCache.keys().next().value);
    }
}

/** Short fingerprint of the API key: answers for one tenant never serve another. */
function keyFingerprint(apiKey) {
    return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

function normalize(body) {
    const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body;
    if (!data || typeof data.verdict !== 'string') return null;
    const verdict = data.verdict.toUpperCase();
    return {
        verdict,
        currentLevel: typeof data.currentLevel === 'string' ? data.currentLevel : 'NONE',
        message: typeof data.message === 'string' ? data.message : undefined,
        allowed: verdict !== 'BLOCK' && verdict !== 'THROTTLE',
    };
}

/**
 * @param {string} customerId
 * @param {object} config - see module comment
 * @returns {Promise<{verdict: string, currentLevel: string, message?: string, allowed: boolean}>}
 */
async function checkMarginGuard(customerId, config) {
    if (!config || !config.marginGuardEnabled || !config.marginGuardUrl || !customerId) {
        return ALLOW;
    }
    if (!config.apiKey) {
        if (!warnedNoKey) {
            warnedNoKey = true;
            console.warn('[aforo-margin-guard] No Aforo API key configured -- margin guard is NOT enforced.');
        }
        return ALLOW;
    }

    const cacheKey = `mg:${keyFingerprint(config.apiKey)}:${customerId}`;
    const cached = cacheGet(cacheKey, Date.now());
    if (cached) {
        return cached;
    }

    try {
        const base = String(config.marginGuardUrl).replace(/\/+$/, '');
        // encodeURIComponent escapes &, =, ?, # and spaces (%20); new URL() rejects a bad base.
        const url = new URL(`${base}${QUICK_CHECK_PATH}?scopeType=CUSTOMER&scopeId=${encodeURIComponent(String(customerId))}`);
        const response = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json', 'X-API-Key': config.apiKey },
            signal: AbortSignal.timeout(positive(config.marginGuardTimeoutMs, DEFAULT_TIMEOUT_MS)),
        });
        if (!response.ok) {
            console.warn(`[aforo-margin-guard] Non-200 response: ${response.status} -- fail-open ALLOW`);
            return ALLOW;
        }
        const result = normalize(await response.json());
        if (!result) {
            console.warn('[aforo-margin-guard] Response has no verdict -- fail-open ALLOW');
            return ALLOW;
        }
        const ttl = config.marginGuardCacheTtlMs === undefined ? 30000 : config.marginGuardCacheTtlMs;
        const plainAllow = result.verdict === 'ALLOW' && result.currentLevel === 'NONE';
        if (ttl > 0 && (result.verdict === 'BLOCK' || plainAllow)) {
            const max = Math.floor(positive(config.marginGuardCacheMaxEntries, DEFAULT_CACHE_MAX_ENTRIES));
            cacheSet(cacheKey, result, ttl, max, Date.now());
        }
        return result;
    } catch (e) {
        console.warn(`[aforo-margin-guard] Check failed: ${e.message} -- fail-open ALLOW`);
        return ALLOW;
    }
}

/**
 * Build a 429 response for margin guard enforcement.
 *
 * @param {object} result - checkMarginGuard result
 * @param {object} [config] - for the BLOCK Retry-After (the cache TTL)
 * @returns {object|null} API Gateway response when refused, null when allowed
 */
function buildEnforcementResponse(result, config) {
    if (!result || (result.verdict !== 'BLOCK' && result.verdict !== 'THROTTLE')) {
        return null;
    }
    const block = result.verdict === 'BLOCK';
    const ttlMs = config && config.marginGuardCacheTtlMs !== undefined ? config.marginGuardCacheTtlMs : 30000;
    const retryAfter = block ? Math.max(1, Math.floor(ttlMs / 1000)) : 1;
    return {
        statusCode: 429,
        headers: {
            'Content-Type': 'application/json',
            'X-Margin-Guard': block ? 'blocked' : 'throttled',
            'X-Margin-Guard-Level': block ? 'L3' : 'L2',
            'Retry-After': String(retryAfter),
        },
        body: JSON.stringify({
            error: block ? {
                code: 'SERVICE_RESTRICTED_MARGIN',
                message: result.message || 'Service restricted due to margin constraints. Contact support.',
                retryAfterSeconds: retryAfter,
                supportUrl: '/portal/support',
            } : {
                code: 'RATE_LIMITED_MARGIN',
                message: result.message || 'Rate limited due to margin constraints. Please retry.',
                retryAfterSeconds: retryAfter,
                dashboardUrl: '/portal/cost-explorer',
            },
        }),
    };
}

function _resetForTests() {
    marginGuardCache.clear();
    warnedNoKey = false;
}

module.exports = { checkMarginGuard, buildEnforcementResponse, _resetForTests, QUICK_CHECK_PATH, _cacheSize: () => marginGuardCache.size };
