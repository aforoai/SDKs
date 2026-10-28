/**
 * Aforo customer-key authorizer for AWS API Gateway (REST API, TOKEN type).
 *
 * The end customer calls the provider's API with the key Aforo issued when
 * they subscribed:
 *
 *   Authorization: Bearer sk_live_...
 *
 * This authorizer asks Aforo who owns that key:
 *
 *   POST {AFORO_INTROSPECT_URL}   X-API-Key: <provider's tenant key>
 *   {"key": "<customer key>"}
 *
 * Aforo answers {"active": true, customerId, keyId, subscriptionId, ...} only
 * for a key of the calling tenant that is not revoked or expired and is bound
 * to an ACTIVE subscription. Anything else is {"active": false} and the call
 * gets 401. On Allow, API Gateway exposes the context to the stage's access
 * log ($context.authorizer.customerId / keyId / subscriptionId), which is
 * where the aforo-metering Lambda (index.js) takes the customer from.
 *
 * The customer key is never logged, and is held in memory only as a SHA-256
 * cache key. Introspection failures fail CLOSED (API Gateway answers 500) and
 * are not cached, so a recovered Aforo is used on the next call.
 *
 * Client-credential JWTs (AI_AGENT / MCP_SERVER customers):
 *
 *   Authorization: Bearer <JWT from POST https://org.aforo.ai/oauth/token>
 *
 * A bearer token shaped like a JWT (three base64url parts) is verified
 * locally instead: RS256 only, signature checked against Aforo's JWKS
 * (fetched and cached), exp / nbf / iat, iss == AFORO_JWT_ISSUER and
 * tenant_id == AFORO_TENANT_ID. AFORO_TENANT_ID is required for this path;
 * without it every JWT is refused (401). A JWKS fetch failure fails CLOSED
 * (500) and is not cached. Tokens are never logged; verified answers are
 * cached by SHA-256 of the token until min(exp, CACHE_TTL_MS). The
 * sk_live_/sk_test_ path is unchanged (its context gains authType "key").
 *
 * Env:
 *   AFORO_TENANT_KEY_SECRET_ARN  required for sk_live_/sk_test_ keys. ARN of
 *                          the Secrets Manager secret holding the provider's
 *                          Aforo tenant key, scope usage:ingest (or
 *                          customer-keys:introspect), as plain text or JSON
 *                          {"apiKey": "..."}. Read once per container,
 *                          refreshed every 5 minutes.
 *   AFORO_TENANT_KEY       the same key as a plain environment variable; used
 *                          only when AFORO_TENANT_KEY_SECRET_ARN is unset.
 *   AFORO_INTROSPECT_URL   default https://api.aforo.ai/api/v1/customer-keys/introspect
 *   CACHE_TTL_MS           default 60000. How long one answer is reused by this
 *                          container (API Gateway's own result TTL applies too).
 *   INTROSPECT_TIMEOUT_MS  default 3000.
 *   AFORO_TENANT_ID        required for JWTs. The provider's Aforo tenant id;
 *                          a JWT whose tenant_id differs is refused.
 *   AFORO_JWKS_URL         default https://org.aforo.ai/.well-known/jwks.json
 *   AFORO_JWT_ISSUER       default https://auth.aforo.ai
 *   JWKS_CACHE_TTL_MS      default 3600000 (1h). An unknown kid refetches once
 *                          (at most once per 60s).
 *   JWKS_TIMEOUT_MS        default 3000.
 *   JWT_CLOCK_SKEW_SECONDS default 30. Leeway for exp / nbf / iat.
 */
'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { createSecretSource } = require('./aws-secret');

const INTROSPECT_URL = process.env.AFORO_INTROSPECT_URL
    || 'https://api.aforo.ai/api/v1/customer-keys/introspect';
const TENANT_KEY = createSecretSource({
    label: 'Aforo tenant key',
    secretIdEnv: 'AFORO_TENANT_KEY_SECRET_ARN',
    plainEnv: 'AFORO_TENANT_KEY',
});
const CACHE_TTL_MS = positiveInt(process.env.CACHE_TTL_MS, 60000);
const INTROSPECT_TIMEOUT_MS = positiveInt(process.env.INTROSPECT_TIMEOUT_MS, 3000);
const MAX_CACHE_ENTRIES = 10000;

const TENANT_ID = (process.env.AFORO_TENANT_ID || '').trim();
const JWKS_URL = process.env.AFORO_JWKS_URL || 'https://org.aforo.ai/.well-known/jwks.json';
const JWT_ISSUER = process.env.AFORO_JWT_ISSUER || 'https://auth.aforo.ai';
const JWKS_CACHE_TTL_MS = positiveInt(process.env.JWKS_CACHE_TTL_MS, 3600000);
const JWKS_TIMEOUT_MS = positiveInt(process.env.JWKS_TIMEOUT_MS, 3000);
const JWT_CLOCK_SKEW_S = nonNegativeInt(process.env.JWT_CLOCK_SKEW_SECONDS, 30);
// An unknown kid refetches the JWKS at most this often, so a stream of forged
// kids cannot turn the authorizer into a JWKS hammer.
const JWKS_MIN_REFETCH_MS = 60000;
// API Gateway context values are size-limited; keep the joined list sane.
const MAX_SUBSCRIPTION_IDS_LENGTH = 1000;
const MAX_CONTEXT_ID_LENGTH = 256;

// The shape pricing-service mints for BEARER customer keys.
const KEY_PATTERN = /^sk_(live|test)_[0-9a-f]{32}$/;
// header.payload.signature, each base64url.
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const cache = new Map();

function positiveInt(raw, fallback) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(raw, fallback) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The customer key from "Bearer <key>" or a bare key; null if not key-shaped. */
function extractKey(authorizationToken) {
    const raw = String(authorizationToken || '').replace(/^Bearer\s+/i, '').trim();
    return KEY_PATTERN.test(raw) ? raw : null;
}

function introspect(key, tenantKey) {
    const body = JSON.stringify({ key });
    const url = new URL(INTROSPECT_URL);
    const client = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
        const req = client.request({
            method: 'POST',
            hostname: url.hostname,
            port: url.port || undefined,
            path: url.pathname + url.search,
            timeout: INTROSPECT_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'X-API-Key': tenantKey,
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Aforo introspection returned HTTP ${res.statusCode}`));
                }
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Aforo introspection timed out')));
        req.on('error', reject);
        req.end(body);
    });
}

/** Allow policy for the whole stage, so API Gateway's cached answer covers every route. */
function buildPolicy(info, methodArn) {
    const [arnPrefix, stage] = String(methodArn).split('/');
    return {
        principalId: info.customerId,
        policyDocument: {
            Version: '2012-10-17',
            Statement: [{
                Action: 'execute-api:Invoke',
                Effect: 'Allow',
                Resource: `${arnPrefix}/${stage}/*`,
            }],
        },
        // API Gateway context values must be strings, numbers or booleans.
        context: {
            customerId: info.customerId,
            keyId: info.keyId || '',
            subscriptionId: info.subscriptionId || '',
            productType: info.productType || '',
            authType: 'key',
        },
    };
}

async function lookup(key) {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const hit = cache.get(hash);
    if (hit && hit.expires > Date.now()) return hit.info;

    // Both throw → not cached, fails closed. The tenant key is read only on a
    // cache miss, so a warm container answers cached keys without it.
    const tenantKey = await TENANT_KEY.get();
    const info = await introspect(key, tenantKey);
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(hash, { info, expires: Date.now() + CACHE_TTL_MS });
    return info;
}

// ── Client-credential JWTs ────────────────────────────────────────────────

/** "Aforo could not be asked" — as opposed to "the token is bad". */
class JwksUnavailableError extends Error {}

/** The token without "Bearer ", if it is shaped like a JWT; else null. */
function extractJwt(authorizationToken) {
    const raw = String(authorizationToken || '').replace(/^Bearer\s+/i, '').trim();
    return JWT_PATTERN.test(raw) ? raw : null;
}

function b64urlJson(part) {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

let jwks = { keys: new Map(), fetchedAt: 0 };
let lastJwksFetch = 0;

async function fetchJwks() {
    lastJwksFetch = Date.now();
    let res;
    try {
        res = await fetch(JWKS_URL, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
        });
    } catch (err) {
        throw new JwksUnavailableError(`JWKS fetch failed: ${err.message}`);
    }
    if (!res.ok) throw new JwksUnavailableError(`JWKS fetch returned HTTP ${res.status}`);
    let doc;
    try {
        doc = await res.json();
    } catch {
        throw new JwksUnavailableError('JWKS is not valid JSON');
    }
    const keys = new Map();
    for (const jwk of (doc && Array.isArray(doc.keys) ? doc.keys : [])) {
        if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
        if ((jwk.use && jwk.use !== 'sig') || (jwk.alg && jwk.alg !== 'RS256')) continue;
        try {
            keys.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
        } catch {
            console.warn(`JWKS key ${jwk.kid} is not a usable RSA key; ignored`);
        }
    }
    if (keys.size === 0) throw new JwksUnavailableError('JWKS has no usable RS256 keys');
    jwks = { keys, fetchedAt: Date.now() };
}

/** Public key for kid: cached JWKS, refetched when stale or (rate-limited) when the kid is unknown. */
async function publicKeyFor(kid) {
    if (jwks.keys.size === 0 || Date.now() - jwks.fetchedAt > JWKS_CACHE_TTL_MS) {
        await fetchJwks();
    } else if (!jwks.keys.has(kid) && Date.now() - lastJwksFetch > JWKS_MIN_REFETCH_MS) {
        await fetchJwks(); // key rotation: one refetch for an unknown kid
    }
    return jwks.keys.get(kid) || null;
}

/** Comma-join whole ids up to max chars. */
function joinIds(ids, max) {
    let out = '';
    for (const id of ids) {
        const next = out ? `${out},${id}` : id;
        if (next.length > max) break;
        out = next;
    }
    return out;
}

function claimString(v) {
    return typeof v === 'string' ? v.trim().slice(0, MAX_CONTEXT_ID_LENGTH) : '';
}

/**
 * Verify an Aforo client-credential JWT. Resolves to { info, expMs } when the
 * token is acceptable, null when it is not; rejects with JwksUnavailableError
 * when the JWKS could not be loaded (the caller fails closed).
 */
async function verifyJwt(token, nowMs = Date.now()) {
    const [h, p, sig] = String(token).split('.');
    let header;
    let claims;
    try {
        header = b64urlJson(h);
        claims = b64urlJson(p);
    } catch {
        return null;
    }
    // RS256 only: "none", HS* (key confusion) and everything else are refused.
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return null;
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;

    const key = await publicKeyFor(header.kid);
    if (!key) return null;
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'));
    if (!ok) return null;

    const now = Math.floor(nowMs / 1000);
    if (typeof claims.exp !== 'number' || now > claims.exp + JWT_CLOCK_SKEW_S) return null;
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || now + JWT_CLOCK_SKEW_S < claims.nbf)) return null;
    if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat > now + JWT_CLOCK_SKEW_S)) return null;
    if (claims.iss !== JWT_ISSUER) return null;
    if (!TENANT_ID || claims.tenant_id !== TENANT_ID) return null;

    const customerId = claimString(claims.customer_id) || claimString(claims.sub);
    if (!customerId) return null;
    const subs = Array.isArray(claims.subscription_ids)
        ? claims.subscription_ids.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
        : [];
    return {
        info: {
            active: true,
            customerId,
            keyId: claimString(claims.key_id),
            subscriptionId: subs.length === 1 ? subs[0] : '',
            subscriptionIds: joinIds(subs, MAX_SUBSCRIPTION_IDS_LENGTH),
            agentId: claimString(claims.agent_id),
            productType: '',
        },
        expMs: claims.exp * 1000,
    };
}

async function handleJwt(token, methodArn) {
    if (!TENANT_ID) {
        console.error('AFORO_TENANT_ID is not set; refusing every JWT.');
        throw new Error('Unauthorized');
    }
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const hit = cache.get(hash);
    let info = hit && hit.expires > Date.now() ? hit.info : null;
    if (!info) {
        let verified;
        try {
            verified = await verifyJwt(token);
        } catch (err) {
            if (err instanceof JwksUnavailableError) {
                console.error(`Aforo JWKS unavailable: ${err.message}`);
                throw new Error('Aforo key check unavailable'); // API Gateway answers 500
            }
            throw new Error('Unauthorized');
        }
        if (!verified) throw new Error('Unauthorized');
        info = verified.info;
        if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
        cache.set(hash, { info, expires: Math.min(verified.expMs, Date.now() + CACHE_TTL_MS) });
    }
    const policy = buildPolicy(info, methodArn);
    policy.context.subscriptionIds = info.subscriptionIds || '';
    policy.context.agentId = info.agentId || '';
    policy.context.authType = 'jwt';
    return policy;
}

async function handler(event) {
    const jwt = extractJwt(event && event.authorizationToken);
    if (jwt) return handleJwt(jwt, event.methodArn);

    if (!TENANT_KEY.configured) {
        console.error('AFORO_TENANT_KEY_SECRET_ARN is not set; denying every call.');
        throw new Error('Aforo authorizer is not configured');
    }
    const key = extractKey(event && event.authorizationToken);
    if (!key) {
        throw new Error('Unauthorized'); // API Gateway answers 401
    }

    let info;
    try {
        info = await lookup(key);
    } catch (err) {
        console.error(`Aforo introspection failed: ${err.message}`);
        throw new Error('Aforo key check unavailable'); // API Gateway answers 500
    }

    if (!info || info.active !== true || !info.customerId) {
        throw new Error('Unauthorized');
    }
    return buildPolicy(info, event.methodArn);
}

module.exports = {
    handler,
    extractKey,
    extractJwt,
    verifyJwt,
    buildPolicy,
    _clearCache: () => cache.clear(),
    _resetJwks: ({ keepKeys = false } = {}) => {
        if (!keepKeys) jwks = { keys: new Map(), fetchedAt: 0 };
        lastJwksFetch = 0;
    },
};
