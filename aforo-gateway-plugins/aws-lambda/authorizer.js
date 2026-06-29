/**
 * Aforo JWT Lambda Authorizer for AWS API Gateway
 *
 * Validates RS256 JWTs issued by Aforo's OAuth token endpoint at
 * POST /oauth/token on the org-service.
 *
 * Validation steps (in order):
 *   1. Decode and parse JWT header + claims
 *   2. Fetch JWKS from AFORO_JWKS_URI (cached per Lambda warm instance)
 *   3. Verify RS256 signature with the matching key (kid lookup)
 *   4. Check exp (expiry), iss (issuer)
 *   5. Check jti blocklist in Redis: key `jti:blocked:{jti}` — exists = revoked
 *   6. Check client-level revocation in Redis: key `jti:client:{keyId}` — exists = all tokens revoked
 *   7. Return IAM Allow policy with claims as authorizer context variables
 *
 * JWT claims expected:
 *   sub            — customerId (fallback when customer_id absent)
 *   tenant_id      — Aforo tenant identifier
 *   customer_id    — Aforo customer identifier
 *   key_id         — API key identifier (used for client revocation lookup)
 *   offering_ids   — array of offering IDs the token is scoped to
 *   subscription_ids — array of subscription IDs
 *   scopes         — space-separated scope string (or array)
 *   environment    — "live" | "sandbox"
 *   exp            — expiry (Unix timestamp)
 *   jti            — unique token ID (for blocklist check)
 *   iss            — issuer (e.g. "https://auth.aforo.ai")
 *
 * Environment variables:
 *   AFORO_JWKS_URI      — Aforo JWKS endpoint URL (required)
 *                         e.g. https://auth.smartai.com/.well-known/jwks.json
 *   AFORO_JWT_ISSUER    — Expected issuer string (optional — skip check if unset)
 *   REDIS_HOST          — ElastiCache Redis host for jti/client blocklist (optional)
 *   REDIS_PORT          — Redis port (default: 6379)
 *   TOKEN_CACHE_TTL_MS  — JWKS cache TTL in ms (default: 3600000 = 1 hour)
 *
 * API Gateway Authorizer settings:
 *   Type:                 TOKEN
 *   Identity source:      method.request.header.Authorization
 *   Token validation:     ^Bearer\s.+  (optional — authorizer validates itself)
 *   Authorization caching: TTL = token_exp - 60s (recommended: 840s for 15-min tokens)
 *
 * Downstream context variables (accessible via $context.authorizer.* in integrations):
 *   customerId, tenantId, keyId, scopes, environment, offeringIds
 */

'use strict';

const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const net   = require('net');

// ────────────────────────────────────────────────────────────
// JWKS cache — survives across warm Lambda invocations
// ────────────────────────────────────────────────────────────

/** @type {{ keys: Array<{ kid: string, n: string, e: string, kty: string }> } | null} */
let jwksCache = null;
let jwksCacheExpiry = 0;

// Negative caching: after a JWKS fetch failure, wait 30s before retrying.
// Prevents hammering the JWKS endpoint when it is temporarily unavailable.
let jwksFetchErrorTime = 0;
const JWKS_ERROR_BACKOFF_MS = 30000;

/**
 * Fetch JWKS from Aforo's JWKS endpoint.
 * Returns cached result when still fresh; performs HTTP fetch on miss.
 * Negative-caches failures for 30 seconds to prevent cascading retries.
 *
 * @returns {Promise<{ keys: object[] }>}
 */
async function fetchJwks() {
    const now = Date.now();
    const ttl = parseInt(process.env.TOKEN_CACHE_TTL_MS || '3600000', 10);

    // Negative cache: if last fetch errored recently, fail fast
    if (jwksFetchErrorTime > 0 && (now - jwksFetchErrorTime) < JWKS_ERROR_BACKOFF_MS) {
        throw new Error('JWKS endpoint unavailable (cached failure — retry in 30s)');
    }

    if (jwksCache && now < jwksCacheExpiry) {
        return jwksCache;
    }

    const jwksUri = process.env.AFORO_JWKS_URI;
    if (!jwksUri) throw new Error('AFORO_JWKS_URI environment variable is not configured');

    try {
        const jwks = await httpGet(jwksUri);
        jwksCache = jwks;
        jwksCacheExpiry = now + ttl;
        jwksFetchErrorTime = 0; // Clear error state on success
        return jwks;
    } catch (err) {
        jwksFetchErrorTime = now;
        throw err;
    }
}

/**
 * Fetch JSON from a URL using Node's built-in https/http.
 * No external dependencies required.
 *
 * @param {string} url
 * @returns {Promise<object>}
 */
function httpGet(url) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const transport = parsedUrl.protocol === 'https:' ? https : http;

        const req = transport.get(url, { timeout: 5000 }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`JWKS fetch failed: HTTP ${res.statusCode} from ${url}`));
            }
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`JWKS response is not valid JSON: ${e.message}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('JWKS fetch timed out'));
        });
        req.on('error', reject);
    });
}

// ────────────────────────────────────────────────────────────
// JWT parsing and verification
// ────────────────────────────────────────────────────────────

/**
 * Convert a JWKS RSA key entry to a Node.js KeyObject.
 *
 * @param {{ n: string, e: string, kty: string }} jwk
 * @returns {crypto.KeyObject}
 */
function jwkToPublicKey(jwk) {
    if (jwk.kty !== 'RSA') {
        throw new Error(`Unsupported key type: ${jwk.kty}`);
    }
    return crypto.createPublicKey({
        key:    { kty: 'RSA', n: jwk.n, e: jwk.e },
        format: 'jwk',
    });
}

/**
 * Decode, verify, and return JWT claims.
 *
 * @param {string} token  — raw JWT string (without "Bearer " prefix)
 * @returns {Promise<object>}  — parsed, verified claims
 * @throws {Error} on any validation failure
 */
async function verifyJwt(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT format — expected 3 dot-separated parts');

    // Decode header and payload without using atob (not available in Lambda Node.js < 18)
    const headerJson  = Buffer.from(parts[0], 'base64url').toString('utf8');
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');

    let header, claims;
    try {
        header = JSON.parse(headerJson);
        claims = JSON.parse(payloadJson);
    } catch (e) {
        throw new Error(`JWT parse error: ${e.message}`);
    }

    if (header.alg !== 'RS256') {
        throw new Error(`Unsupported JWT algorithm: ${header.alg}. Expected RS256.`);
    }
    if (!header.kid) {
        throw new Error('JWT header missing kid (key ID)');
    }

    // Resolve signing key from JWKS
    const jwk = await resolveSigningKey(header.kid);
    const publicKey = jwkToPublicKey(jwk);

    // Verify RS256 signature
    const signatureInput = `${parts[0]}.${parts[1]}`;
    const signature      = Buffer.from(parts[2], 'base64url');

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(signatureInput);
    if (!verifier.verify(publicKey, signature)) {
        throw new Error('JWT signature verification failed');
    }

    // Expiry check (with 30s clock skew allowance)
    const now = Math.floor(Date.now() / 1000);
    if (!claims.exp || now > claims.exp + 30) {
        throw new Error(`Token expired at ${new Date((claims.exp || 0) * 1000).toISOString()}`);
    }

    // Issuer check
    const expectedIssuer = process.env.AFORO_JWT_ISSUER;
    if (expectedIssuer && claims.iss !== expectedIssuer) {
        throw new Error(`Invalid issuer: got '${claims.iss}', expected '${expectedIssuer}'`);
    }

    return claims;
}

/**
 * Find the JWKS key matching `kid`.
 * On cache miss: clears cache, re-fetches once, and tries again.
 *
 * @param {string} kid
 * @returns {Promise<object>}  — the matching JWK entry
 */
async function resolveSigningKey(kid) {
    const jwks = await fetchJwks();
    const jwk  = jwks.keys.find(k => k.kid === kid);
    if (jwk) return jwk;

    // kid not in cache — force one refresh (key rotation scenario)
    console.log(`kid '${kid}' not in JWKS cache — refreshing`);
    jwksCache = null;
    const freshJwks = await fetchJwks();
    const freshJwk  = freshJwks.keys.find(k => k.kid === kid);
    if (!freshJwk) {
        throw new Error(`No JWKS key found for kid '${kid}'`);
    }
    return freshJwk;
}

// ────────────────────────────────────────────────────────────
// Redis blocklist check (raw TCP — no external package needed)
// ────────────────────────────────────────────────────────────

/**
 * Send a raw Redis GET command over a plain TCP socket.
 * Fail-open: returns false on any connection or protocol error.
 *
 * @param {string} key  — Redis key to GET
 * @returns {Promise<boolean>}  — true if key exists (non-nil response)
 */
function redisGet(key) {
    const host = process.env.REDIS_HOST;
    if (!host) return Promise.resolve(false);

    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const command = `*2\r\n$3\r\nGET\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`;

    return new Promise((resolve) => {
        let settled = false;
        let accumulated = '';

        const done = (val) => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve(val);
            }
        };

        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.on('timeout', () => done(false));
        socket.on('error',   () => done(false));

        socket.connect(port, host, () => {
            socket.write(command);
        });

        socket.on('data', (chunk) => {
            // Accumulate chunks — TCP may split a single RESP response across multiple events
            accumulated += chunk.toString('ascii');
            // A complete RESP response always ends with \r\n
            if (!accumulated.includes('\r\n')) return;
            // Redis RESP: "$-1\r\n" = nil (key not found), "$N\r\n..." = key exists
            done(accumulated.startsWith('$') && !accumulated.startsWith('$-1'));
        });
    });
}

/**
 * Check whether a specific jti has been blocklisted.
 * Redis key format: `jti:blocked:{jti}`
 *
 * @param {string} jti
 * @returns {Promise<boolean>}
 */
function isJtiBlocked(jti) {
    if (!jti) return Promise.resolve(false);
    return redisGet(`jti:blocked:${jti}`);
}

/**
 * Check whether all tokens for a given keyId have been revoked
 * (client-level revocation).
 * Redis key format: `jti:client:{keyId}`
 *
 * @param {string} keyId
 * @returns {Promise<boolean>}
 */
function isClientRevoked(keyId) {
    if (!keyId) return Promise.resolve(false);
    return redisGet(`jti:client:${keyId}`);
}

// ────────────────────────────────────────────────────────────
// IAM policy builder
// ────────────────────────────────────────────────────────────

/**
 * Build an API Gateway IAM policy document.
 *
 * Using a wildcard resource (`arn:...:*`) means the cached policy
 * is valid for any method/resource on the same API, avoiding
 * repeated Authorizer invocations within the cache TTL.
 *
 * @param {'Allow'|'Deny'} effect
 * @param {string} resource  — the methodArn from the authorizer event
 * @param {object} [context] — key/value pairs passed to $context.authorizer.*
 * @returns {object}  — IAM policy response
 */
function buildPolicy(effect, resource, context) {
    // Wildcard the method/path so the cached policy covers the whole API
    const arnParts  = (resource || '').split(':');
    const wildcardArn = arnParts.length >= 6
        ? arnParts.slice(0, 6).join(':') + ':*'
        : resource;

    return {
        principalId:    (context && context.customerId) || 'aforo-user',
        policyDocument: {
            Version:   '2012-10-17',
            Statement: [{
                Action:   'execute-api:Invoke',
                Effect:   effect,
                Resource: wildcardArn,
            }],
        },
        context: context || {},
    };
}

// ────────────────────────────────────────────────────────────
// Lambda handler
// ────────────────────────────────────────────────────────────

/**
 * Main authorizer entry point called by API Gateway.
 *
 * @param {{ authorizationToken: string, methodArn: string }} event
 * @returns {Promise<object>}  — IAM policy document
 */
exports.handler = async (event) => {
    const methodArn = event.methodArn;

    // Strip "Bearer " prefix (case-insensitive)
    const rawToken = event.authorizationToken || '';
    const token    = rawToken.replace(/^[Bb]earer\s+/, '').trim();

    if (!token) {
        console.warn('Authorizer: no token in Authorization header — denying');
        return buildPolicy('Deny', methodArn, { error: 'NO_TOKEN' });
    }

    let claims;
    try {
        claims = await verifyJwt(token);
    } catch (err) {
        console.warn(`Authorizer: JWT validation failed — ${err.message}`);
        // Return Deny rather than throwing so API Gateway returns 403 (not 500)
        return buildPolicy('Deny', methodArn, { error: err.message });
    }

    // Check jti blocklist and client-level revocation in parallel
    const keyId = claims.key_id || '';
    const [jtiBlocked, clientRevoked] = await Promise.all([
        isJtiBlocked(claims.jti || ''),
        isClientRevoked(keyId),
    ]);

    if (jtiBlocked) {
        console.warn(`Authorizer: jti '${claims.jti}' is blocklisted — denying`);
        return buildPolicy('Deny', methodArn, { error: 'TOKEN_REVOKED' });
    }

    if (clientRevoked) {
        console.warn(`Authorizer: keyId '${keyId}' is client-revoked — denying`);
        return buildPolicy('Deny', methodArn, { error: 'CLIENT_REVOKED' });
    }

    // Normalise scopes to a space-separated string
    const scopes = Array.isArray(claims.scopes)
        ? claims.scopes.join(' ')
        : (claims.scopes || '');

    // Build authorizer context — all values MUST be strings (API Gateway requirement)
    const context = {
        customerId:   String(claims.customer_id || claims.sub || ''),
        tenantId:     String(claims.tenant_id   || ''),
        keyId:        String(claims.key_id       || ''),
        scopes:       String(scopes),
        environment:  String(claims.environment  || 'live'),
        offeringIds:  JSON.stringify(claims.offering_ids      || []),
        subscriptionIds: JSON.stringify(claims.subscription_ids || []),
    };

    console.log(`Authorizer: Allow — customerId=${context.customerId} tenantId=${context.tenantId}`);
    return buildPolicy('Allow', methodArn, context);
};

// ────────────────────────────────────────────────────────────
// Exports for unit testing
// ────────────────────────────────────────────────────────────
module.exports.handler;
module.exports._test = {
    fetchJwks,
    verifyJwt,
    isJtiBlocked,
    isClientRevoked,
    buildPolicy,
    jwkToPublicKey,
};
