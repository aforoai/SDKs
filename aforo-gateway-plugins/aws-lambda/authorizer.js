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
 *   4. Check exp (expiry), iss (issuer), tenant_id == AFORO_TENANT_ID
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
 *   AFORO_TENANT_ID     — Your Aforo workspace (tenant) id (required). Aforo signs
 *                         every tenant's tokens with the same key, so a token whose
 *                         tenant_id claim differs is denied (TENANT_MISMATCH). Unset
 *                         or blank → every request is denied (TENANT_NOT_CONFIGURED).
 *                         The tenantId passed downstream is always this value.
 *   AFORO_JWT_ISSUER    — Required iss claim (default: https://auth.aforo.ai)
 *   AFORO_JWT_ISSUER_CHECK_DISABLED — "true" skips the issuer check (logged once
 *                         per container). Any other value keeps it.
 *   REDIS_HOST          — ElastiCache Redis host for jti/client blocklist (optional;
 *                         unset = no revocation check, logged once per container)
 *   REDIS_PORT          — Redis port (default: 6379)
 *   REDIS_TLS           — "true" (default) connects with TLS; "false" only for a
 *                         local Redis without in-transit encryption (logged)
 *   REDIS_TLS_SERVERNAME — TLS server name when it differs from REDIS_HOST
 *   REDIS_AUTH_SECRET_ARN — Secrets Manager secret holding the Redis AUTH token
 *                         (plain text). REDIS_AUTH_TOKEN is the plain-variable
 *                         fallback. REDIS_USERNAME adds an ACL user name.
 *   REDIS_TIMEOUT_MS    — connect + reply deadline (default: 1000)
 *   TOKEN_CACHE_TTL_MS  — JWKS cache TTL in ms (default: 3600000 = 1 hour)
 *
 * Revocation fails closed: when Redis is configured and cannot answer (timeout,
 * TLS failure, -NOAUTH / -WRONGPASS or any other error reply, a reply that is
 * not a bulk string), the token is denied.
 *
 * API Gateway Authorizer settings:
 *   Type:                 TOKEN
 *   Identity source:      method.request.header.Authorization
 *   Token validation:     ^Bearer\s.+  (optional — authorizer validates itself)
 *   Authorization caching: TTL 60 s or less (the Allow policy covers the
 *                         token's stage; a revoked token stays allowed for at
 *                         most the TTL)
 *
 * Downstream context variables (accessible via $context.authorizer.* in integrations):
 *   customerId, tenantId, keyId, scopes, environment, offeringIds
 */

'use strict';

const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const net   = require('net');
const tls   = require('tls');
const { createSecretSource } = require('./aws-secret');

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

// An unknown kid triggers at most one JWKS refetch per 30 s, so a stream of
// tokens with made-up kids cannot turn every request into a JWKS fetch.
let lastUnknownKidRefetch = 0;
const UNKNOWN_KID_REFETCH_MS = 30000;

/**
 * Fetch JWKS from Aforo's JWKS endpoint.
 * Returns the cached set while it is fresh (force skips that). A failure is
 * remembered for 30 s; during that time only a fresh cache is served.
 *
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ keys: object[] }>}
 */
async function fetchJwks({ force = false } = {}) {
    const now = Date.now();
    const ttl = parseInt(process.env.TOKEN_CACHE_TTL_MS || '3600000', 10);

    if (!force && jwksCache && now < jwksCacheExpiry) {
        return jwksCache;
    }

    // Negative cache: if the last fetch errored recently, fail fast
    if (jwksFetchErrorTime > 0 && (now - jwksFetchErrorTime) < JWKS_ERROR_BACKOFF_MS) {
        throw new Error('JWKS endpoint unavailable (cached failure — retry in 30s)');
    }

    const jwksUri = process.env.AFORO_JWKS_URI;
    if (!jwksUri) throw new Error('AFORO_JWKS_URI environment variable is not configured');

    try {
        const jwks = await httpGet(jwksUri);
        if (!jwks || !Array.isArray(jwks.keys)) {
            throw new Error('JWKS response has no "keys" array');
        }
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

    // Issuer check: required unless explicitly disabled.
    if (issuerCheckDisabled()) {
        if (!warnedIssuerDisabled) {
            warnedIssuerDisabled = true;
            console.warn('Authorizer: AFORO_JWT_ISSUER_CHECK_DISABLED=true — the iss claim is not checked');
        }
    } else {
        const expectedIssuer = expectedJwtIssuer();
        if (claims.iss !== expectedIssuer) {
            throw new Error(`Invalid issuer: got '${claims.iss}', expected '${expectedIssuer}'`);
        }
    }

    return claims;
}

const DEFAULT_JWT_ISSUER = 'https://auth.aforo.ai';
let warnedIssuerDisabled = false;

function expectedJwtIssuer() {
    return (process.env.AFORO_JWT_ISSUER || '').trim() || DEFAULT_JWT_ISSUER;
}

function issuerCheckDisabled() {
    return String(process.env.AFORO_JWT_ISSUER_CHECK_DISABLED || '').trim().toLowerCase() === 'true';
}

/** The workspace this gateway serves (AFORO_TENANT_ID), or '' when unset. */
function configuredTenantId() {
    return (process.env.AFORO_TENANT_ID || '').trim();
}

/**
 * Find the JWKS key matching `kid`.
 * An unknown kid refetches the JWKS (key rotation), at most once per 30 s.
 * The previous key set stays in place when that refetch fails, so tokens
 * signed with a known key keep verifying.
 *
 * @param {string} kid
 * @returns {Promise<object>}  — the matching JWK entry
 */
async function resolveSigningKey(kid) {
    const jwks = await fetchJwks();
    const jwk  = jwks.keys.find(k => k.kid === kid);
    if (jwk) return jwk;

    const now = Date.now();
    if (now - lastUnknownKidRefetch < UNKNOWN_KID_REFETCH_MS) {
        throw new Error(`No JWKS key found for kid '${kid}'`);
    }
    lastUnknownKidRefetch = now;
    console.log(`kid '${kid}' not in JWKS cache — refreshing`);
    let freshJwks;
    try {
        freshJwks = await fetchJwks({ force: true });
    } catch (err) {
        throw new Error(`No JWKS key found for kid '${kid}' (refresh failed: ${err.message})`);
    }
    const freshJwk = freshJwks.keys.find(k => k.kid === kid);
    if (!freshJwk) {
        throw new Error(`No JWKS key found for kid '${kid}'`);
    }
    return freshJwk;
}

// ────────────────────────────────────────────────────────────
// Redis blocklist check (RESP over TLS — no external package needed)
// ────────────────────────────────────────────────────────────

const MAX_REDIS_REPLY_BYTES = 65536;

let redisAuth = null;
let warnedNoRedis = false;
let warnedPlaintext = false;

/** AUTH token source: Secrets Manager (REDIS_AUTH_SECRET_ARN) or REDIS_AUTH_TOKEN. */
function redisAuthSource() {
    if (!redisAuth) {
        redisAuth = createSecretSource({
            label: 'Redis AUTH token',
            secretIdEnv: 'REDIS_AUTH_SECRET_ARN',
            plainEnv: 'REDIS_AUTH_TOKEN',
        });
    }
    return redisAuth;
}

/** One RESP command: an array of bulk strings. */
function encodeCommand(args) {
    let out = `*${args.length}\r\n`;
    for (const a of args) {
        const v = String(a);
        out += `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
    }
    return out;
}

/**
 * Parse RESP2 replies from buf. Returns the complete replies found (each
 * { type: 'simple'|'error'|'integer'|'bulk'|'nil', value }) and the number of
 * bytes they used. A partial reply at the end is left for the next chunk.
 * Throws on bytes that are not RESP, and on arrays (no command sent here
 * returns one).
 *
 * @param {Buffer} buf
 * @returns {{ replies: object[], used: number }}
 */
function parseRespReplies(buf) {
    const replies = [];
    let offset = 0;
    while (offset < buf.length) {
        const eol = buf.indexOf('\r\n', offset);
        if (eol < 0) break;
        const type = String.fromCharCode(buf[offset]);
        const line = buf.toString('utf8', offset + 1, eol);
        if (type === '+' || type === '-' || type === ':') {
            const t = type === '+' ? 'simple' : type === '-' ? 'error' : 'integer';
            if (t === 'integer' && !/^-?\d+$/.test(line)) throw new Error('Redis sent a malformed integer reply');
            replies.push({ type: t, value: line });
            offset = eol + 2;
        } else if (type === '$') {
            if (!/^-?\d+$/.test(line)) throw new Error('Redis sent a malformed bulk reply');
            const n = parseInt(line, 10);
            if (n === -1) {
                replies.push({ type: 'nil', value: null });
                offset = eol + 2;
                continue;
            }
            if (n < 0) throw new Error('Redis sent a malformed bulk reply');
            const end = eol + 2 + n;
            if (buf.length < end + 2) break; // body not complete yet
            if (buf[end] !== 0x0d || buf[end + 1] !== 0x0a) throw new Error('Redis sent a malformed bulk reply');
            replies.push({ type: 'bulk', value: buf.toString('utf8', eol + 2, end) });
            offset = end + 2;
        } else {
            throw new Error(`Redis sent an unexpected reply type '${type}'`);
        }
    }
    return { replies, used: offset };
}

/**
 * Send commands on one connection and return one reply per command.
 * TLS unless REDIS_TLS=false. Rejects on timeout, TLS or socket error, a
 * connection closed early, or a malformed reply.
 *
 * @param {string[][]} commands
 * @returns {Promise<object[]>}
 */
function redisCommands(commands) {
    const host = process.env.REDIS_HOST;
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const timeoutMs = parseInt(process.env.REDIS_TIMEOUT_MS || '1000', 10);
    const useTls = String(process.env.REDIS_TLS || 'true').toLowerCase() !== 'false';
    if (!useTls && !warnedPlaintext) {
        warnedPlaintext = true;
        console.warn('Authorizer: REDIS_TLS=false — the revocation lookup and AUTH token travel unencrypted');
    }
    const payload = commands.map(encodeCommand).join('');

    return new Promise((resolve, reject) => {
        let settled = false;
        let buffered = Buffer.alloc(0);
        const replies = [];
        let socket;

        const finish = (err, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (socket) socket.destroy();
            if (err) reject(err); else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error(`Redis did not answer within ${timeoutMs} ms`)), timeoutMs);

        const onReady = () => socket.write(payload);
        try {
            if (useTls) {
                const options = {
                    host,
                    port,
                    rejectUnauthorized: true,
                };
                const servername = process.env.REDIS_TLS_SERVERNAME || (net.isIP(host) ? '' : host);
                if (servername) options.servername = servername;
                if (process.env.REDIS_TLS_CA_FILE) {
                    options.ca = require('fs').readFileSync(process.env.REDIS_TLS_CA_FILE);
                }
                socket = tls.connect(options, onReady);
            } else {
                socket = net.connect({ host, port }, onReady);
            }
        } catch (err) {
            finish(new Error(`Redis connection failed: ${err.message}`));
            return;
        }

        socket.on('error', (err) => finish(new Error(`Redis connection failed: ${err.message}`)));
        socket.on('close', () => finish(new Error('Redis closed the connection before answering')));
        socket.on('data', (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.length > MAX_REDIS_REPLY_BYTES) {
                finish(new Error('Redis reply too large'));
                return;
            }
            let parsed;
            try {
                parsed = parseRespReplies(buffered);
            } catch (err) {
                finish(err);
                return;
            }
            replies.push(...parsed.replies);
            buffered = buffered.subarray(parsed.used);
            if (replies.length >= commands.length) finish(null, replies.slice(0, commands.length));
        });
    });
}

/**
 * Look up the jti blocklist and the client revocation key.
 * Returns [jtiBlocked, clientRevoked]. Throws when Redis is configured and
 * the answer is not a clear "exists" / "does not exist" — the caller denies.
 *
 * Redis keys: `jti:blocked:{jti}`, `jti:client:{keyId}`.
 *
 * @param {string} jti
 * @param {string} keyId
 * @returns {Promise<[boolean, boolean]>}
 */
async function checkRevocation(jti, keyId) {
    if (!process.env.REDIS_HOST) {
        if (!warnedNoRedis) {
            warnedNoRedis = true;
            console.warn('Authorizer: REDIS_HOST is not set — revoked tokens are not checked');
        }
        return [false, false];
    }
    const lookups = [];
    if (jti) lookups.push(['jti', `jti:blocked:${jti}`]);
    if (keyId) lookups.push(['client', `jti:client:${keyId}`]);
    if (lookups.length === 0) return [false, false];

    const commands = [];
    const auth = redisAuthSource();
    if (auth.configured) {
        const token = await auth.get();
        if (!token) throw new Error('Redis AUTH token is empty');
        const user = (process.env.REDIS_USERNAME || '').trim();
        commands.push(user ? ['AUTH', user, token] : ['AUTH', token]);
    }
    for (const [, key] of lookups) commands.push(['GET', key]);

    const replies = await redisCommands(commands);
    let i = 0;
    if (auth.configured) {
        const r = replies[i++];
        if (r.type !== 'simple' || r.value !== 'OK') {
            throw new Error(`Redis AUTH failed: ${r.type === 'error' ? r.value : 'unexpected reply'}`);
        }
    }
    const result = { jti: false, client: false };
    for (const [name, key] of lookups) {
        const r = replies[i++];
        if (r.type === 'nil') result[name] = false;
        else if (r.type === 'bulk') result[name] = true;
        else if (r.type === 'error') throw new Error(`Redis GET ${key.split(':').slice(0, 2).join(':')} failed: ${r.value}`);
        else throw new Error(`Redis GET returned an unexpected ${r.type} reply`);
    }
    return [result.jti, result.client];
}

/** True if the jti is blocklisted. Throws when Redis cannot answer. */
async function isJtiBlocked(jti) {
    return (await checkRevocation(jti, ''))[0];
}

/** True if every token of keyId is revoked. Throws when Redis cannot answer. */
async function isClientRevoked(keyId) {
    return (await checkRevocation('', keyId))[1];
}

// ────────────────────────────────────────────────────────────
// IAM policy builder
// ────────────────────────────────────────────────────────────

/**
 * Build an API Gateway IAM policy document.
 *
 * Allow covers the stage of the called method (`arn:...:apiId/stage/*`), not
 * the whole API: a cached Allow for one stage is not reused on another.
 * Deny covers the called method only. Keep the authorizer result TTL at 60 s
 * or less; a revoked token stays allowed for at most that long.
 *
 * @param {'Allow'|'Deny'} effect
 * @param {string} resource  — the methodArn from the authorizer event
 * @param {object} [context] — key/value pairs passed to $context.authorizer.*
 * @returns {object}  — IAM policy response
 */
function buildPolicy(effect, resource, context) {
    return {
        principalId:    (context && context.customerId) || 'aforo-user',
        policyDocument: {
            Version:   '2012-10-17',
            Statement: [{
                Action:   'execute-api:Invoke',
                Effect:   effect,
                Resource: effect === 'Allow' ? stageArn(resource) : String(resource || ''),
            }],
        },
        context: context || {},
    };
}

/**
 * `arn:aws:execute-api:region:account:apiId/stage/METHOD/path` →
 * `arn:aws:execute-api:region:account:apiId/stage/*`. Anything that does not
 * have that shape is returned unchanged (an exact, narrower resource).
 */
function stageArn(methodArn) {
    const arn = String(methodArn || '');
    const m = arn.match(/^(arn:[^:]+:execute-api:[^:]+:\d{12}:[^/]+\/[^/]+)\//);
    return m ? `${m[1]}/*` : arn;
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

    // Organization-service signs every tenant's tokens with one key, so a
    // valid signature alone would let any Aforo workspace's token in. Without
    // a configured tenant nothing can be checked: deny everything.
    const tenantId = configuredTenantId();
    if (!tenantId) {
        console.error('Authorizer: AFORO_TENANT_ID is not set — denying every request. ' +
            'Set it to your Aforo workspace id.');
        return buildPolicy('Deny', methodArn, { error: 'TENANT_NOT_CONFIGURED' });
    }

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

    if (claims.tenant_id !== tenantId) {
        console.warn(`Authorizer: TENANT_MISMATCH — token tenant_id is not '${tenantId}' — denying`);
        return buildPolicy('Deny', methodArn, { error: 'TENANT_MISMATCH' });
    }

    // Check jti blocklist and client-level revocation (one Redis round trip)
    const keyId = claims.key_id || '';
    let jtiBlocked, clientRevoked;
    try {
        [jtiBlocked, clientRevoked] = await checkRevocation(claims.jti || '', keyId);
    } catch (err) {
        console.error(`Authorizer: revocation check failed — denying (${err.message})`);
        return buildPolicy('Deny', methodArn, { error: 'REVOCATION_CHECK_FAILED' });
    }

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
        tenantId:     tenantId,
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
    checkRevocation,
    redisCommands,
    parseRespReplies,
    buildPolicy,
    stageArn,
    resolveSigningKey,
    reset() {
        jwksCache = null;
        jwksCacheExpiry = 0;
        jwksFetchErrorTime = 0;
        lastUnknownKidRefetch = 0;
        redisAuth = null;
        warnedNoRedis = false;
        warnedPlaintext = false;
        warnedIssuerDisabled = false;
    },
    jwkToPublicKey,
};
