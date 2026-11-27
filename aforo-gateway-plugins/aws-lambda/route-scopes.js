/**
 * Route scopes and the Allow policy resource, shared by authorizer.js and
 * key-authorizer.js (2.7.0). Node.js built-ins only.
 *
 * AFORO_ROUTE_SCOPES      JSON object: "METHOD /path" → one scope or an array
 *                         of scopes, all required. See AUTHORIZER.md.
 * AFORO_POLICY_RESOURCE   "method" (default since 2.7.0): an Allow names the
 *                         called method ARN only. "stage": an Allow names the
 *                         whole stage (arn:…:apiId/stage/*), the behaviour
 *                         before 2.7.0; honoured only while AFORO_ROUTE_SCOPES
 *                         is unset. Any other value is read as "method".
 *
 * Why "method" by default (G341): with a stage-wide Allow, one cached answer
 * opens every route on the stage for the whole authorizer result TTL. A
 * per-method Allow opens only the route that was checked. It does not shorten
 * how long a revoked token keeps working on that route: that is the API
 * Gateway authorizer result TTL, which template.yaml sets to 60 s or less
 * when it creates the authorizer.
 */

'use strict';

// ────────────────────────────────────────────────────────────
// Route scopes (AFORO_ROUTE_SCOPES)
// ────────────────────────────────────────────────────────────

const ROUTE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// Parsed once per container and per value of the variable.
let routeScopesCache = { raw: null, config: null };

/**
 * The route → scope map.
 *   { configured: false }                       variable unset or blank
 *   { configured: true, routes, fallback }      valid
 *   { configured: true, error }                 not valid — the caller denies
 * A value that does not parse is logged once, when it is first read.
 */
function routeScopeConfig(label = 'Authorizer') {
    const raw = process.env.AFORO_ROUTE_SCOPES;
    if (routeScopesCache.config && routeScopesCache.raw === raw) return routeScopesCache.config;
    let config;
    if (raw === undefined || String(raw).trim() === '') {
        config = { configured: false };
    } else {
        try {
            config = { configured: true, ...parseRouteScopes(raw) };
        } catch (err) {
            config = { configured: true, error: err.message };
            console.error(`${label}: AFORO_ROUTE_SCOPES is not valid — denying every request until it is fixed. ${err.message}`);
        }
    }
    routeScopesCache = { raw, config };
    return config;
}

/**
 * Parse AFORO_ROUTE_SCOPES. Throws on anything that is not a JSON object of
 * "METHOD /path" (or "*") → scope | scope[].
 *
 * @param {string} raw
 * @returns {{ routes: object[], fallback: string[] | null }}
 */
function parseRouteScopes(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`It is not JSON (${err.message}).`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('It must be a JSON object such as {"GET /v1/items/{id}": "items:read"}.');
    }
    const routes = [];
    const seen = new Set();
    let fallback = null;
    for (const [key, value] of Object.entries(parsed)) {
        const scopes = parseRequiredScopes(key, value);
        if (key.trim() === '*') {
            fallback = scopes;
            continue;
        }
        const m = key.trim().match(/^(\S+)\s+(\/\S*)$/);
        if (!m) throw new Error(`Entry "${key}": expected "METHOD /path" or "*".`);
        let method = m[1].toUpperCase();
        if (method === 'ANY') method = '*';
        if (method !== '*' && !ROUTE_METHODS.has(method)) {
            throw new Error(`Entry "${key}": unknown method "${m[1]}".`);
        }
        const segments = m[2].split('/').filter(Boolean).map((seg, i, all) => {
            if (seg === '**' || /^\{[^{}+]+\+\}$/.test(seg)) {
                if (i !== all.length - 1) throw new Error(`Entry "${key}": "${seg}" is allowed only as the last segment.`);
                return { kind: 'rest' };
            }
            if (seg === '*' || /^\{[^{}+]+\}$/.test(seg)) return { kind: 'one' };
            if (/[{}*]/.test(seg)) throw new Error(`Entry "${key}": segment "${seg}" mixes text with a wildcard.`);
            return { kind: 'literal', value: seg };
        });
        const canonical = `${method} /${segments.map((s) => (s.kind === 'literal' ? s.value : s.kind === 'one' ? '{}' : '{+}')).join('/')}`;
        if (seen.has(canonical)) throw new Error(`Entry "${key}" matches the same routes as another entry.`);
        seen.add(canonical);
        routes.push({ pattern: canonical, method, segments, scopes });
    }
    return { routes, fallback };
}

/** A scope string (space-separated, like the claim) or an array of scopes. [] = no scope needed. */
function parseRequiredScopes(key, value) {
    if (typeof value === 'string') {
        const scopes = value.split(/\s+/).filter(Boolean);
        if (scopes.length === 0) throw new Error(`Entry "${key}": the scope is empty. Use [] for a route that needs no scope.`);
        return scopes;
    }
    if (Array.isArray(value) && value.every((s) => typeof s === 'string' && s.trim() !== '' && !/\s/.test(s.trim()))) {
        return value.map((s) => s.trim());
    }
    throw new Error(`Entry "${key}": the value must be a scope or an array of scopes.`);
}

/**
 * `arn:aws:execute-api:region:account:apiId/stage/METHOD/path` →
 * { method, segments }. The path is the one the client called (path parameters
 * hold their real values). Empty segments are dropped, so `/a//b/` is `/a/b`.
 * Returns null for anything else, and for a path with a `.` / `..` segment or
 * an encoded slash: the backend might read such a path as another route.
 */
function parseMethodArn(methodArn) {
    const parts = String(methodArn || '').split('/');
    if (parts.length < 3 || !parts[0].startsWith('arn:') || !parts[1] || !parts[2]) return null;
    const segments = [];
    for (const rawSeg of parts.slice(3)) {
        if (rawSeg === '') continue;
        let seg = rawSeg;
        try {
            seg = decodeURIComponent(rawSeg);
        } catch {
            return null;
        }
        if (seg === '.' || seg === '..' || /[/\\]/.test(seg)) return null;
        segments.push(seg);
    }
    return { method: parts[2].toUpperCase(), segments };
}

function routeMatches(route, method, segments) {
    if (route.method !== '*' && route.method !== method) return false;
    const pat = route.segments;
    const rest = pat.length > 0 && pat[pat.length - 1].kind === 'rest';
    const fixed = rest ? pat.length - 1 : pat.length;
    if (rest ? segments.length < fixed : segments.length !== fixed) return false;
    for (let i = 0; i < fixed; i++) {
        if (pat[i].kind === 'literal' && pat[i].value !== segments[i]) return false;
    }
    return true;
}

// Higher is more specific: no more segments > literal > one segment > the rest.
function segmentRank(seg) {
    if (!seg) return 3;
    return seg.kind === 'literal' ? 2 : seg.kind === 'one' ? 1 : 0;
}

/** > 0 when route a is more specific than route b. */
function compareSpecificity(a, b) {
    const n = Math.max(a.segments.length, b.segments.length);
    for (let i = 0; i < n; i++) {
        const d = segmentRank(a.segments[i]) - segmentRank(b.segments[i]);
        if (d !== 0) return d;
    }
    return (a.method === '*' ? 0 : 1) - (b.method === '*' ? 0 : 1);
}

/**
 * The scopes the called route needs.
 * Returns { pattern, scopes } — scopes [] when no entry (and no "*" default)
 * covers the route — or null when the method ARN cannot be read.
 *
 * @param {{ routes: object[], fallback: string[] | null }} config
 * @param {string} methodArn
 */
function requiredScopesFor(config, methodArn) {
    const called = parseMethodArn(methodArn);
    if (!called) return null;
    let best = null;
    for (const route of config.routes) {
        if (!routeMatches(route, called.method, called.segments)) continue;
        if (!best || compareSpecificity(route, best) > 0) best = route;
    }
    if (best) return { pattern: best.pattern, scopes: best.scopes };
    if (config.fallback) return { pattern: '*', scopes: config.fallback };
    return { pattern: '', scopes: [] };
}

/** The scopes claim as a list: a space-separated string or an array. */
function tokenScopes(claims) {
    if (Array.isArray(claims.scopes)) return claims.scopes.filter((s) => typeof s === 'string' && s !== '');
    if (typeof claims.scopes === 'string') return claims.scopes.split(/\s+/).filter(Boolean);
    return [];
}


// ────────────────────────────────────────────────────────────
// Allow policy resource (AFORO_POLICY_RESOURCE)
// ────────────────────────────────────────────────────────────

let warnedStagePolicy = false;

/**
 * "method" or "stage". "stage" only when AFORO_POLICY_RESOURCE says so and no
 * route map is set (a route map always needs per-method Allows).
 *
 * @param {{ configured: boolean }} routeScopes  routeScopeConfig()
 * @param {string} [label]
 */
function policyResourceMode(routeScopes, label = 'Authorizer') {
    const raw = String(process.env.AFORO_POLICY_RESOURCE || '').trim().toLowerCase();
    if (raw !== 'stage' || (routeScopes && routeScopes.configured)) return 'method';
    if (!warnedStagePolicy) {
        warnedStagePolicy = true;
        console.warn(`${label}: AFORO_POLICY_RESOURCE=stage — an Allow covers every route on the stage. ` +
            'Keep the API Gateway authorizer result TTL at 60 s or less.');
    }
    return 'stage';
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

/** The Allow resource for the called method ARN in the given mode. */
function allowResource(methodArn, mode) {
    return mode === 'stage' ? stageArn(methodArn) : String(methodArn || '');
}

module.exports = {
    routeScopeConfig,
    parseRouteScopes,
    parseMethodArn,
    requiredScopesFor,
    tokenScopes,
    policyResourceMode,
    stageArn,
    allowResource,
    _reset() {
        routeScopesCache = { raw: null, config: null };
        warnedStagePolicy = false;
    },
};
