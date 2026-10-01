/**
 * Aforo Compound Metering for Apigee (JavaScript Callout)
 *
 * Extracts multiple metric measurements from the API response body via JSONPath
 * and buffers compound usage events for batch flush to the Aforo ingestor.
 *
 * Config via KVM (Key/Value Map):
 *   compound_metering_enabled: "true" | "false"
 *   response_extraction_paths: JSON string mapping JSONPath → metric name
 *   response_extraction_dimensions: JSON string mapping JSONPath → dimension key
 */

// ── JSONPath-lite resolution ──────────────────────────────

function resolveJsonPath(obj, path) {
    if (!obj || !path) return undefined;
    var clean = path.indexOf('$.') === 0 ? path.substring(2) : path;
    var current = obj;
    var segments = clean.split('.');
    for (var i = 0; i < segments.length; i++) {
        if (current == null) return undefined;
        var arrMatch = segments[i].match(/^(.+)\[(\d+)\]$/);
        if (arrMatch) {
            current = current[arrMatch[1]];
            if (Array.isArray(current)) current = current[parseInt(arrMatch[2])];
            else return undefined;
        } else {
            current = current[segments[i]];
        }
    }
    return current;
}

// ── Extract measurements ─────────────────────────────────

function extractMeasurements(responseBody, extractionPaths, dimensionPaths) {
    if (!responseBody) return null;
    var parsed;
    try { parsed = JSON.parse(responseBody); } catch (e) { return null; }

    var measurements = [];
    var paths = JSON.parse(extractionPaths || '{}');
    var dims = dimensionPaths ? JSON.parse(dimensionPaths) : {};

    for (var jsonPath in paths) {
        var value = resolveJsonPath(parsed, jsonPath);
        if (typeof value === 'number' && value > 0) {
            var m = { metricName: paths[jsonPath], quantity: value };
            for (var dimPath in dims) {
                var dimVal = resolveJsonPath(parsed, dimPath);
                if (typeof dimVal === 'string' && dimVal) { m.dimensionKey = dimVal; break; }
            }
            measurements.push(m);
        }
    }
    return measurements.length > 0 ? measurements : null;
}

// ── Minimal MD5 (pure JS, ES5/Rhino-safe) ─────────────────
// Embedded because Apigee's sandboxed Rhino has neither java.* interop
// (the pre-freeze java.util.UUID fallback would have thrown a
// ReferenceError at runtime) nor Node's crypto. Public-domain
// implementation (Joseph Myers), verified byte-for-byte against
// node:crypto in tests/unit-tests.cjs. Inputs here are ASCII
// (Apigee messageids / request ids).

function md5cycle(x, k) {
    var a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
}

function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
}
function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
function add32(a, b) { return (a + b) & 0xFFFFFFFF; }

function md5blk(s) {
    var blks = [], i;
    for (i = 0; i < 64; i += 4) {
        blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) +
                       (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    }
    return blks;
}

function md5hex(s) {
    var n = s.length,
        state = [1732584193, -271733879, -1732584194, 271733878],
        i;
    for (i = 64; i <= s.length; i += 64) {
        md5cycle(state, md5blk(s.substring(i - 64, i)));
    }
    s = s.substring(i - 64);
    var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < s.length; i++) {
        tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    }
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
        md5cycle(state, tail);
        for (i = 0; i < 16; i++) tail[i] = 0;
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    var hexChr = '0123456789abcdef', out = '', j, k;
    for (j = 0; j < 4; j++) {
        for (k = 0; k < 4; k++) {
            out += hexChr.charAt((state[j] >> (k * 8 + 4)) & 0x0F) +
                   hexChr.charAt((state[j] >> (k * 8)) & 0x0F);
        }
    }
    return out;
}

// ── Deterministic correlationId (FROZEN — A+ compound-key freeze, 2026-07-05) ──
//
// Dedup-safety basis: the Aforo ingestor types correlationId as a UUID
// and derives EVERY per-metric dedup key from it —
//   correlationId:metricName[:dimensionKey]:index
// (CompoundEventDecomposer) — so the correlationId is the dedup ROOT for
// the whole compound event. This script runs once per transaction and
// materializes the event into 'aforo.compound_event'; every delivery
// attempt (a ServiceCallout and any bounded retry steps, prompt-4 style)
// re-sends that same frozen variable, so all attempts carry a
// byte-identical correlationId and the ingestor dedups redelivery
// instead of double-billing.
// Two pre-freeze bugs closed here: (1) the raw 'messageid' is NOT
// UUID-shaped (e.g. "rrt-...") — the ingestor's UUID-typed field
// rejected it with a 400, silently dropping the event; hashing it into
// a v3-style UUID keeps it deterministic AND parseable. (2) the
// java.util.UUID fallback does not exist in Apigee's sandboxed Rhino.
// Identity preference mirrors aforo-metering.js's frozen standard key:
// 'messageid' (platform-generated, unique + stable per transaction) >
// client 'x-request-id' header > one-time random LAST RESORT (dedup
// opt-out for that single event; effectively unreachable — messageid is
// always set). NEVER put a clock component back into this derivation.

function formatUuidV3(hex) {
    var hexChr = '0123456789abcdef';
    var variant = hexChr.charAt((parseInt(hex.charAt(16), 16) % 4) + 8);
    return hex.substring(0, 8) + '-' + hex.substring(8, 12) +
           '-3' + hex.substring(13, 16) +
           '-' + variant + hex.substring(17, 20) +
           '-' + hex.substring(20, 32);
}

function deriveCorrelationId(seed) {
    return formatUuidV3(md5hex('aforo-compound:' + seed));
}

function randomUuidV4() {
    // Last-resort only (no stable identity at all): random rather than
    // clock so two same-millisecond keyless events cannot collide into a
    // false dedup — same rationale as the standard key's fallback.
    var hexChr = '0123456789abcdef', s = '', i;
    for (i = 0; i < 32; i++) {
        s += hexChr.charAt(Math.floor(Math.random() * 16));
    }
    return s.substring(0, 8) + '-' + s.substring(8, 12) +
           '-4' + s.substring(13, 16) +
           '-' + hexChr.charAt((parseInt(s.charAt(16), 16) % 4) + 8) + s.substring(17, 20) +
           '-' + s.substring(20, 32);
}

// ── Main: PostClientFlow execution ───────────────────────

var enabled = context.getVariable('aforo.compound_metering_enabled');
if (enabled !== 'true') {
    // Compound metering disabled — skip
} else {
    var responseBody = context.getVariable('response.content');
    var extractionPaths = context.getVariable('aforo.response_extraction_paths');
    var dimensionPaths = context.getVariable('aforo.response_extraction_dimensions');

    var measurements = extractMeasurements(responseBody, extractionPaths, dimensionPaths);
    if (measurements) {
        // Verified identity only: the customer_id claim of the verified JWT,
        // else the developer app VerifyAPIKey resolved. Never
        // apiproxy.consumerkey: that is the caller's API key (a credential).
        var customerId = context.getVariable('aforo.customer_id') ||
                         context.getVariable('developer.app.name') ||
                         context.getVariable('developer.email') || '';
        var seedIdentity = context.getVariable('messageid') ||
                           context.getVariable('request.header.x-request-id');
        var correlationId = seedIdentity ?
            deriveCorrelationId(seedIdentity) : randomUuidV4();

        var compoundEvent = {
            correlationId: correlationId,
            customerId: customerId,
            productType: ('' + (context.getVariable('private.aforo.productType') ||
                context.getVariable('aforo.productType') || '')).replace(/^\s+|\s+$/g, '').toUpperCase() || 'API',
            occurredAt: new Date().toISOString(),
            metadata: {
                gateway: 'apigee',
                proxyName: context.getVariable('apiproxy.name'),
                environment: context.getVariable('environment.name'),
                statusCode: context.getVariable('response.status.code')
            },
            measurements: measurements
        };

        // Buffer in KVM for batch flush (ServiceCallout handles async POST)
        context.setVariable('aforo.compound_event', JSON.stringify(compoundEvent));
        // No customer → the ingestor rejects the event; don't send it.
        context.setVariable('aforo.compound_event_ready', customerId ? 'true' : 'false');
    }
}
