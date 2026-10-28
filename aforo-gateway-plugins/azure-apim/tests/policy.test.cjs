/**
 * Azure APIM policy tests — run with `node azure-apim/tests/policy.test.cjs`.
 *
 * There is no local APIM runtime, so this does three things:
 *   1. Checks outbound-policy.xml is well formed once the APIM policy
 *      expressions (@{...} / @(...), which legally contain raw < and ")
 *      are masked. Uses a built-in tag check, plus xmllint when installed.
 *   2. RUNS the decision expressions from the shipped files — "aforo-skip"
 *      (exclusions), "aforo-execution-status" (outcome table),
 *      "aforo-event-customer", "aforo-event-metric", "aforo-mcp-call",
 *      "aforo-event-product-type", and the four variables of
 *      context-policy-fragment.xml — against a mock APIM `context`. The C# is written in a
 *      subset that becomes JavaScript with two textual substitutions
 *      (foreach -> for..of, drop the <string> type argument); every .NET
 *      member it calls is shimmed below with the same semantics.
 *   3. Source locks: the send is gated on aforo-skip, both send bodies
 *      carry executionStatus and an ISO-8601 occurredAt, and the frozen
 *      idempotency key (Rule #21) is untouched.
 *
 * What this cannot prove: that APIM's expression compiler accepts the
 * file, or that IUrl.Path has the shape assumed here. Import the policy
 * into an APIM instance before a release.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const POLICY = path.join(__dirname, '..', 'outbound-policy.xml');
const src = fs.readFileSync(POLICY, 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL: ' + name + (detail !== undefined ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
    check(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

// ── Expression scanner ────────────────────────────────────────────────
// Returns the index just past the bracket that closes the one at `open`,
// skipping C# strings, char literals and // comments.
function closeOf(text, open) {
    const openCh = text[open];
    const closeCh = openCh === '{' ? '}' : ')';
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (c === '"') {
            i++;
            while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
            continue;
        }
        if (c === "'") {
            const m = /^'(\\.|[^'\\])'/.exec(text.slice(i, i + 4));
            if (m) { i += m[0].length - 1; }
            continue;
        }
        if (c === openCh) depth++;
        else if (c === closeCh) { depth--; if (depth === 0) return i + 1; }
    }
    throw new Error('unbalanced expression starting at offset ' + open);
}

// All policy expressions, in file order: { start, end, body, multi }.
function findExpressions(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
        // Skip XML comments so an example inside a comment isn't parsed.
        if (text.startsWith('<!--', i)) { i = text.indexOf('-->', i) + 3; continue; }
        if (text[i] === '@' && (text[i + 1] === '{' || text[i + 1] === '(')) {
            const end = closeOf(text, i + 1);
            out.push({ start: i, end: end, body: text.slice(i + 2, end - 1), multi: text[i + 1] === '{' });
            i = end;
            continue;
        }
        i++;
    }
    return out;
}

const expressions = findExpressions(src);
check('policy contains expressions', expressions.length >= 6, String(expressions.length));

// ── 1. Well-formedness ───────────────────────────────────────────────
let masked = '';
{
    let last = 0;
    expressions.forEach(function (e, n) {
        masked += src.slice(last, e.start) + 'EXPR' + n;
        last = e.end;
    });
    masked += src.slice(last);
}

function tagCheck(xml) {
    const stack = [];
    const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)((?:\s+[\w-]+=(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        if (m[0].startsWith('<!--')) {
            if (m[0].slice(4, -3).indexOf('--') !== -1) return 'comment contains "--" at ' + m.index;
            continue;
        }
        if (m[0] === '<') return 'stray "<" at offset ' + m.index;
        if (m[0] === '&') return 'bare "&" at offset ' + m.index;
        if (m[1]) {
            const top = stack.pop();
            if (top !== m[1]) return 'closing </' + m[1] + '> does not match <' + top + '>';
        } else if (m[4] !== '/') {
            stack.push(m[2]);
        }
    }
    return stack.length ? 'unclosed <' + stack.join('>, <') + '>' : null;
}
eq('well formed (built-in tag check)', tagCheck(masked), null);
eq('tag check rejects a broken document', tagCheck('<a><b></a>') !== null, true);

const lint = spawnSync('xmllint', ['--noout', '-'], { input: masked, encoding: 'utf8' });
if (lint.error) {
    console.log('note: xmllint not installed — skipped (built-in tag check still ran)');
} else {
    eq('well formed (xmllint)', lint.status, 0);
    if (lint.status !== 0) console.error(lint.stderr);
}

// ── 2. Run the decision expressions ──────────────────────────────────
function variableExpression(name, text) {
    const marker = '<set-variable name="' + name + '" value="';
    const source = text === undefined ? src : text;
    const at = source.indexOf(marker);
    if (at === -1) throw new Error('set-variable ' + name + ' not found');
    const found = (text === undefined ? expressions : findExpressions(source))
        .filter(function (e) { return e.start === at + marker.length; })[0];
    if (!found || !found.multi) throw new Error(name + ' is not a multi-statement expression');
    return found.body;
}

// .NET members used by the two expressions, with .NET semantics.
function define(proto, name, fn) {
    Object.defineProperty(proto, name, { value: fn, configurable: true, writable: true });
}
Object.defineProperty(String.prototype, 'Length', { get: function () { return this.length; }, configurable: true });
Object.defineProperty(Array.prototype, 'Length', { get: function () { return this.length; }, configurable: true });
define(String.prototype, 'Split', function () {
    const seps = Array.prototype.slice.call(arguments);
    if (seps.length === 1) return this.split(seps[0]);
    let parts = [String(this)];
    seps.forEach(function (sep) {
        parts = parts.reduce(function (acc, p) { return acc.concat(p.split(sep)); }, []);
    });
    return parts;
});
define(String.prototype, 'IndexOf', function (s) { return this.indexOf(s); });
define(String.prototype, 'Substring', function (start, len) {
    return len === undefined ? this.substring(start) : this.substring(start, start + len);
});
define(String.prototype, 'Replace', function (a, b) { return this.split(a).join(b); });
define(String.prototype, 'EndsWith', function (s) { return this.endsWith(s); });
define(String.prototype, 'Trim', function () { return this.trim(); });
define(String.prototype, 'ToLowerInvariant', function () { return this.toLowerCase(); });
define(String.prototype, 'ToUpperInvariant', function () { return this.toUpperCase(); });
define(String.prototype, 'Contains', function (s) { return this.indexOf(s) !== -1; });
define(String.prototype, 'StartsWith', function (s) { return this.startsWith(s); });
define(Number.prototype, 'ToString', function () { return String(this); });

function toJs(csharp) {
    return csharp
        .replace(/foreach\s*\(\s*var\s+(\w+)\s+in\s+/g, 'for (var $1 of ')
        .replace(/GetValueOrDefault<\w+>\(/g, 'GetValueOrDefault(')
        // The verified-JWT payload is a JObject in APIM and a plain object here.
        .replace(/ as JObject;/g, ';')
        .replace(/\.As<string>\(preserveContent: true\)/g, '.AsString()');
}

// Named Values are substituted into the policy text before APIM compiles it.
function compile(name, text, namedValues) {
    let body = toJs(variableExpression(name, text));
    Object.keys(namedValues || {}).forEach(function (k) {
        body = body.split('{{' + k + '}}').join(namedValues[k]);
    });
    check(name + ' has no unsubstituted Named Value', !/\{\{[^}]*\}\}/.test(body));
    // Anything outside the supported subset would silently change meaning.
    ['=>', '(string)', '(int)', ' is ', ' as ', 'new ', '?.', '??', '$"'].forEach(function (token) {
        check(name + ' stays inside the runnable C# subset (no "' + token.trim() + '")',
            body.replace(/\/\/.*$/gm, '').replace(/"(\\.|[^"\\])*"/g, '""').indexOf(token) === -1);
    });
    return new Function('context', 'Convert', 'System', 'StringComparison', 'string', 'JObject', body);
}

// Convert.ToString(string null) is null, Convert.ToString(object null) is "".
// The expressions guard for null wherever it matters, so null covers both.
const Convert = {
    ToString: function (v) { return v === null || v === undefined ? null : String(v); },
    ToBase64String: function (b) { return Buffer.from(b).toString('base64'); },
};
const JObjectShim = { Parse: function (s) {
    const v = JSON.parse(s);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
    return v;
} };
const SystemShim = {
    Text: {
        RegularExpressions: { Regex: { IsMatch: function (s, re) { return new RegExp(re).test(s); } } },
        Encoding: { UTF8: { GetBytes: function (s) { return Buffer.from(String(s), 'utf8'); } } },
    },
    Security: { Cryptography: { SHA256: { Create: function () {
        return { ComputeHash: function (b) { return require('crypto').createHash('sha256').update(b).digest(); } };
    } } } },
};
const stringShim = { IsNullOrEmpty: function (s) { return s === null || s === undefined || s === ''; } };

function makeContext(o) {
    const vars = Object.create({
        ContainsKey: function (k) { return Object.prototype.hasOwnProperty.call(this, k); },
        GetValueOrDefault: function (k, d) { return this.ContainsKey(k) ? this[k] : d; },
    });
    Object.assign(vars, o.vars || {});
    return {
        Response: o.noResponse ? null : { StatusCode: o.status === undefined ? 200 : o.status },
        Request: {
            Url: o.noUrl ? null : { Path: o.path === undefined ? '/v1/accounts' : o.path },
            OriginalUrl: o.originalPath === undefined ? null : { Path: o.originalPath },
            Method: o.method === undefined ? 'GET' : o.method,
            Body: o.body === undefined ? null : { AsString: function () {
                if (o.bodyThrows) throw new Error('body is not available');
                return o.body;
            } },
        },
        Subscription: o.subscription === undefined ? null : { Id: o.subscription, Key: 'SECRET-SUBSCRIPTION-KEY' },
        Operation: o.template === undefined ? null : { UrlTemplate: o.template },
        Variables: vars,
    };
}

const skipFn = compile('aforo-skip');
function skip(o) {
    return skipFn(makeContext(o), Convert, SystemShim, { Ordinal: 4 }, stringShim);
}
const CODES = 'aforo-exclude-status-codes';
const PATHS = 'aforo-exclude-paths';
function withVar(name, value, extra) {
    const o = Object.assign({}, extra || {});
    o.vars = {};
    o.vars[name] = value;
    return o;
}

// Defaults: 401 / 403 / 429 and /health, /ready, /metrics.
[401, 403, 429].forEach(function (s) { eq('default: ' + s + ' is not metered', skip({ status: s }), 'true'); });
[200, 201, 301, 400, 404, 408, 422, 499, 500, 503, 504].forEach(function (s) {
    eq('default: ' + s + ' is metered', skip({ status: s }), 'false');
});
['/health', '/ready', '/metrics', '/health/live', '/healthz', '/metrics/prometheus'].forEach(function (p) {
    eq('default: path ' + p + ' is not metered', skip({ path: p }), 'true');
});
['/v1/health', '/', '/v1/accounts', '/readiness-not', '/api/metrics'].forEach(function (p) {
    eq('default: path ' + p + ' is metered', skip({ path: p }), 'false');
});

// Blank values mean "use the default".
['', '   ', ',', ' , , '].forEach(function (v) {
    eq('blank codes ' + JSON.stringify(v) + ' -> default (401 skipped)', skip(withVar(CODES, v, { status: 401 })), 'true');
    eq('blank codes ' + JSON.stringify(v) + ' -> default (404 metered)', skip(withVar(CODES, v, { status: 404 })), 'false');
    eq('blank paths ' + JSON.stringify(v) + ' -> default', skip(withVar(PATHS, v, { path: '/health' })), 'true');
});

// A value REPLACES the default.
eq('codes 404,500: 404 skipped', skip(withVar(CODES, '404,500', { status: 404 })), 'true');
eq('codes 404,500: 500 skipped', skip(withVar(CODES, ' 404 , 500 ', { status: 500 })), 'true');
eq('codes 404,500: 401 now metered', skip(withVar(CODES, '404,500', { status: 401 })), 'false');
eq('codes 404,500: 429 now metered', skip(withVar(CODES, '404,500', { status: 429 })), 'false');
eq('paths /internal: /internal/x skipped', skip(withVar(PATHS, '/internal', { path: '/internal/x' })), 'true');
eq('paths /internal: /health now metered', skip(withVar(PATHS, '/internal', { path: '/health' })), 'false');
eq('paths list with spaces', skip(withVar(PATHS, ' /a , /b ', { path: '/b/c' })), 'true');

// "none" excludes nothing.
['none', 'NONE', ' None '].forEach(function (v) {
    [401, 403, 429].forEach(function (s) {
        eq('codes ' + JSON.stringify(v) + ': ' + s + ' metered', skip(withVar(CODES, v, { status: s })), 'false');
    });
    eq('paths ' + JSON.stringify(v) + ': /health metered', skip(withVar(PATHS, v, { path: '/health' })), 'false');
});
eq('codes none does not switch off path exclusion', skip(withVar(CODES, 'none', { status: 401, path: '/health' })), 'true');
eq('paths none does not switch off status exclusion', skip(withVar(PATHS, 'none', { status: 401, path: '/health' })), 'true');

// Junk is ignored and never throws.
eq('junk-only codes exclude nothing (401)', skip(withVar(CODES, 'abc', { status: 401 })), 'false');
eq('junk + valid: valid still applies', skip(withVar(CODES, 'abc,404,,9999,40x', { status: 404 })), 'true');
eq('junk + valid: 401 metered', skip(withVar(CODES, 'abc,404', { status: 401 })), 'false');
eq('out-of-range 600 ignored', skip(withVar(CODES, '600,099,0', { status: 600 })), 'false');
eq('four digits ignored', skip(withVar(CODES, '4010', { status: 401 })), 'false');
eq('none mixed with a code is junk, the code applies', skip(withVar(CODES, 'none,404', { status: 404 })), 'true');
eq('none mixed with a code: 401 metered', skip(withVar(CODES, 'none,404', { status: 401 })), 'false');
eq('integer variable is read, not thrown on', skip(withVar(CODES, 404, { status: 404 })), 'true');
eq('null variable -> default', skip(withVar(CODES, null, { status: 403 })), 'true');
eq('boolean variable is junk', skip(withVar(CODES, true, { status: 401 })), 'false');
eq('object variable is junk', skip(withVar(PATHS, { a: 1 }, { path: '/health' })), 'false');

// Missing pieces of the APIM context.
eq('no response object: status 0 is metered', skip({ noResponse: true }), 'false');
eq('no Url object', skip({ noUrl: true }), 'false');
eq('null path', skip({ path: null }), 'false');
eq('path without leading slash', skip({ path: 'health' }), 'true');

// Path candidates: current path, original (client-facing) path, URL template.
eq('original path matches', skip({ path: '/backend/x', originalPath: '/health' }), 'true');
eq('operation template matches behind an API suffix',
    skip({ path: '/orders-api/health', originalPath: '/orders-api/health', template: '/health' }), 'true');
eq('entry written with the API suffix matches',
    skip(withVar(PATHS, '/orders-api/health', { path: '/orders-api/health', template: '/health' })), 'true');
eq('no candidate matches', skip({ path: '/orders-api/orders', originalPath: '/orders-api/orders', template: '/orders' }), 'false');

// Outcome table (same expression file; overrides and default).
const outcomeFn = compile('aforo-execution-status');
function outcome(status, overrides) {
    const o = { status: status };
    if (overrides !== undefined) o.vars = { 'aforo-status-outcomes': overrides };
    return outcomeFn(makeContext(o), Convert, SystemShim, { Ordinal: 4 }, stringShim);
}
[[200, 'SUCCESS'], [204, 'SUCCESS'], [302, 'SUCCESS'], [400, 'VALIDATION_FAILED'], [422, 'VALIDATION_FAILED'],
 [401, 'BLOCKED'], [403, 'BLOCKED'], [429, 'BLOCKED'], [404, 'ERROR'], [408, 'TIMEOUT'], [504, 'TIMEOUT'],
 [499, 'CANCELLED'], [500, 'ERROR'], [503, 'ERROR'], [0, ''], [101, ''], [600, '']].forEach(function (row) {
    eq('outcome ' + row[0], outcome(row[0]), row[1]);
});
eq('override applies', outcome(404, '404=VALIDATION_FAILED,429=ERROR'), 'VALIDATION_FAILED');
eq('override is case-insensitive and trimmed', outcome(429, ' 429 = error '), 'ERROR');
eq('last valid override wins', outcome(404, '404=FAILED,404=PARTIAL'), 'PARTIAL');
eq('invalid override ignored', outcome(404, '404=NOPE,abc,=,404'), 'ERROR');
eq('override cannot make an undeterminable status billable', outcome(0, '0=SUCCESS'), '');


// ── 2b. Identity, metric, MCP detection, product type ────────────────
function run(fn, o) { return fn(makeContext(o), Convert, SystemShim, { Ordinal: 4, OrdinalIgnoreCase: 5 }, stringShim, JObjectShim); }

// Customer: aforo-customer-id when the variable exists, else the APIM
// subscription id. Never the subscription key; nothing -> "" -> no event.
const customerFn = compile('aforo-event-customer');
eq('customer: subscription id when no variable', run(customerFn, { subscription: 'acme-prod' }), 'acme-prod');
eq('customer: variable wins over the subscription', run(customerFn, { subscription: 'acme-prod', vars: { 'aforo-customer-id': ' cust_123 ' } }), 'cust_123');
eq('customer: an EMPTY variable means "none resolved", not the subscription',
    run(customerFn, { subscription: 'acme-prod', vars: { 'aforo-customer-id': '' } }), '');
eq('customer: null variable -> none', run(customerFn, { subscription: 'acme-prod', vars: { 'aforo-customer-id': null } }), '');
eq('customer: no subscription and no variable -> none', run(customerFn, {}), '');
eq('customer: 64 characters accepted', run(customerFn, { subscription: 'c'.repeat(64) }), 'c'.repeat(64));
eq('customer: 65 characters -> none', run(customerFn, { subscription: 'c'.repeat(65) }), '');
check('customer: the subscription key is never read', variableExpression('aforo-event-customer').indexOf('.Key') === -1);
check('no fragment reads Subscription.Key or sends a placeholder customer',
    fs.readdirSync(path.join(__dirname, '..')).filter(function (f) { return f.endsWith('.xml'); }).every(function (f) {
        const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        const code = t.slice(t.indexOf('\n<fragment>'));
        return !/Subscription\??\.Key/.test(code) && !/"unknown"\s*\)\s*,\s*new JProperty\("metricName"/.test(code)
            && code.indexOf('X-Customer-Id", ""') === -1;
    }));

// Metric: mapping match -> default metric -> "METHOD path".
const metricFn = compile('aforo-event-metric');
const MAP = 'aforo-metric-mappings';
const DEF = 'aforo-default-metric';
function metric(o, vars) { return run(metricFn, Object.assign({ vars: vars || {} }, o)); }
const RULES = 'PREFIX|/sms/v1/send|sms_sent; exact | /otp/v1/verify | otp_verified ;CONTAINS|/reports/|report_runs';
eq('metric: no settings -> METHOD path', metric({ path: '/v1/accounts' }), 'GET /v1/accounts');
eq('metric: default metric', metric({ path: '/v1/accounts' }, { [DEF]: ' api_calls ' }), 'api_calls');
eq('metric: default "none" -> METHOD path', metric({ path: '/x', method: 'POST' }, { [DEF]: 'None' }), 'POST /x');
eq('metric: PREFIX', metric({ originalPath: '/sms/v1/send/bulk' }, { [MAP]: RULES, [DEF]: 'api_calls' }), 'sms_sent');
eq('metric: EXACT (kind is case-insensitive, parts trimmed)', metric({ originalPath: '/otp/v1/verify' }, { [MAP]: RULES, [DEF]: 'api_calls' }), 'otp_verified');
eq('metric: EXACT does not match a longer path', metric({ originalPath: '/otp/v1/verify/x' }, { [MAP]: RULES, [DEF]: 'api_calls' }), 'api_calls');
eq('metric: CONTAINS', metric({ originalPath: '/v2/reports/run' }, { [MAP]: RULES, [DEF]: 'api_calls' }), 'report_runs');
eq('metric: first match wins', metric({ originalPath: '/a' }, { [MAP]: 'PREFIX|/a|first;PREFIX|/a|second' }), 'first');
eq('metric: rules split on a newline too', metric({ originalPath: '/b' }, { [MAP]: 'PREFIX|/a|first\nPREFIX|/b|second' }), 'second');
eq('metric: mapping matches the client-facing path, not the rewritten one',
    metric({ path: '/backend/send', originalPath: '/sms/v1/send' }, { [MAP]: RULES, [DEF]: 'api_calls' }), 'sms_sent');
eq('metric: falls back to the current path when there is no original URL', metric({ path: '/sms/v1/send' }, { [MAP]: RULES }), 'sms_sent');
eq('metric: unmapped with mappings but no default -> METHOD path', metric({ path: '/v1/x', originalPath: '/v1/x' }, { [MAP]: RULES }), 'GET /v1/x');
['none', '', 'junk', 'PREFIX|/a', 'PREFIX||m', 'PREFIX|/v1|', 'REGEX|/v1|m', '|||'].forEach(function (bad) {
    eq('metric: malformed mappings ' + JSON.stringify(bad) + ' are ignored', metric({ originalPath: '/v1/x', path: '/v1/x' }, { [MAP]: bad, [DEF]: 'api_calls' }), 'api_calls');
});
eq('metric: non-string variables do not throw', metric({ path: '/v1/x' }, { [MAP]: 42, [DEF]: null }), 'GET /v1/x');
eq('metric: 255 characters accepted', metric({}, { [DEF]: 'm'.repeat(255) }), 'm'.repeat(255));
eq('metric: over 255 characters -> "" (event is not sent)', metric({}, { [DEF]: 'm'.repeat(256) }), '');
eq('metric: a mapped name over 255 characters -> ""', metric({ originalPath: '/a' }, { [MAP]: 'PREFIX|/a|' + 'm'.repeat(256), [DEF]: 'api_calls' }), '');

// MCP detection: "" or "<agentId>\n<toolName>".
function mcpFn(enabled) { return compile('aforo-mcp-call', undefined, { 'aforo-mcp-enabled': enabled }); }
const mcpOn = mcpFn('true');
const CALL = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_docs","_meta":{"agent_id":"agent-7"}}}';
const CALL_NO_AGENT = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_docs"}}';
eq('mcp: tools/call from the body captured in inbound', run(mcpOn, { method: 'POST', vars: { 'aforo-mcp-body': CALL } }), 'agent-7\nsearch_docs');
eq('mcp: tools/call read from the request when nothing was captured', run(mcpOn, { method: 'POST', body: CALL }), 'agent-7\nsearch_docs');
eq('mcp: no agent id', run(mcpOn, { method: 'POST', body: CALL_NO_AGENT }), '\nsearch_docs');
eq('mcp: no params -> tool "unknown"', run(mcpOn, { method: 'POST', body: '{"method":"tools/call"}' }), '\nunknown');
eq('mcp: detection off', run(mcpFn('false'), { method: 'POST', body: CALL }), '');
eq('mcp: GET is never an MCP call', run(mcpOn, { method: 'GET', body: CALL }), '');
eq('mcp: another JSON-RPC method', run(mcpOn, { method: 'POST', body: '{"method":"tools/list","note":"tools/call"}' }), '');
eq('mcp: not JSON -> standard call, no throw', run(mcpOn, { method: 'POST', body: 'tools/call <<<' }), '');
eq('mcp: JSON array -> standard call', run(mcpOn, { method: 'POST', body: '["tools/call"]' }), '');
eq('mcp: params is not an object -> standard call or unknown tool, no throw',
    typeof run(mcpOn, { method: 'POST', body: '{"method":"tools/call","params":null}' }), 'string');
eq('mcp: unreadable body -> standard call, no throw', run(mcpOn, { method: 'POST', body: CALL, bodyThrows: true }), '');
eq('mcp: no body', run(mcpOn, { method: 'POST' }), '');
eq('mcp: a newline in the agent id cannot shift the billed tool name',
    run(mcpOn, { method: 'POST', body: '{"method":"tools/call","params":{"name":"expensive_tool","_meta":{"agent_id":"a\\ncheap_tool"}}}' }),
    'acheap_tool\nexpensive_tool');

// Product type: one setting (aforo-product-type), trimmed + upper-cased, default API.
const typeFn = compile('aforo-event-product-type');
function ptype(call, configured) {
    const vars = { 'aforo-mcp-call': call };
    if (configured !== undefined) vars['aforo-product-type'] = configured;
    return run(typeFn, { vars: vars });
}
eq('productType: default API', ptype(''), 'API');
eq('productType: blank -> API', ptype('', '  '), 'API');
eq('productType: "none" -> API', ptype('', 'none'), 'API');
eq('productType: trimmed and upper-cased', ptype('', ' agentic_api '), 'AGENTIC_API');
eq('productType: unknown values pass through', ptype('', 'custom_type'), 'CUSTOM_TYPE');
['AI_AGENT', 'MCP_SERVER', 'GRPC_API', 'GRAPHQL_API', 'WEBSOCKET_API', 'MQTT_BROKER', 'mcp_server'].forEach(function (t) {
    eq('productType: configured ' + t + ' cannot be supplied by a gateway -> "" (not sent)', ptype('', t), '');
});
eq('productType: MCP call with tool and agent -> MCP_SERVER', ptype('agent-7\nsearch_docs'), 'MCP_SERVER');
eq('productType: MCP call wins over an unsuppliable configured type', ptype('agent-7\nsearch_docs', 'GRPC_API'), 'MCP_SERVER');
eq('productType: MCP call without an agent id keeps the configured type', ptype('\nsearch_docs', 'api'), 'API');
eq('productType: MCP call without a tool name keeps the configured type', ptype('agent-7\nunknown'), 'API');
eq('productType: non-string variable does not throw', ptype('', 7), '7');

// ── 2c. context-policy-fragment.xml (aforo-context) ──────────────────
const ctxSrc = fs.readFileSync(path.join(__dirname, '..', 'context-policy-fragment.xml'), 'utf8');
const NV = {
    'aforo-subscription-customer-map': 'acme-prod=cust_123; globex = cust_456 ;broken;=x',
    'aforo-product-type': 'none',
    'aforo-metric-mappings': 'PREFIX|/sms|sms_sent',
    'aforo-default-metric': 'api_calls',
    'aforo-mcp-enabled': 'true',
};
const ctxCustomer = compile('aforo-customer-id', ctxSrc, NV);
eq('context: verified JWT customer_id claim', run(ctxCustomer, { subscription: 'acme-prod', vars: { 'aforo-jwt-payload': { customer_id: ' cust_jwt ' } } }), 'cust_jwt');
eq('context: no claim -> subscription map', run(ctxCustomer, { subscription: 'acme-prod', vars: { 'aforo-jwt-payload': { sub: 'someone' } } }), 'cust_123');
eq('context: map entry with spaces', run(ctxCustomer, { subscription: 'globex' }), 'cust_456');
eq('context: subscription not in the map -> "" (not metered)', run(ctxCustomer, { subscription: 'initech' }), '');
eq('context: no JWT and no subscription -> ""', run(ctxCustomer, {}), '');
eq('context: a customer set before the fragment wins', run(ctxCustomer, { subscription: 'acme-prod', vars: { 'aforo-customer-id': 'cust_explicit', 'aforo-jwt-payload': { customer_id: 'cust_jwt' } } }), 'cust_explicit');
eq('context: map from a context variable wins over the Named Value', run(ctxCustomer, { subscription: 'acme-prod', vars: { 'aforo-subscription-customer-map': 'acme-prod=cust_var' } }), 'cust_var');
eq('context: map "none"', run(compile('aforo-customer-id', ctxSrc, Object.assign({}, NV, { 'aforo-subscription-customer-map': 'none' })), { subscription: 'acme-prod' }), '');
check('context: customer is never the subscription key or a request header',
    !/\.Key|Request\.Headers/.test(variableExpression('aforo-customer-id', ctxSrc)));
const ctxType = compile('aforo-product-type', ctxSrc, NV);
eq('context: product type Named Value "none" -> API', run(ctxType, {}), 'API');
eq('context: per-API set-variable wins', run(ctxType, { vars: { 'aforo-product-type': ' agentic_api ' } }), 'AGENTIC_API');
eq('context: product type from the Named Value', run(compile('aforo-product-type', ctxSrc, Object.assign({}, NV, { 'aforo-product-type': 'api' })), {}), 'API');
const ctxMap = compile('aforo-metric-mappings', ctxSrc, NV);
eq('context: mappings from the Named Value', run(ctxMap, {}), 'PREFIX|/sms|sms_sent');
eq('context: mappings variable wins', run(ctxMap, { vars: { 'aforo-metric-mappings': 'EXACT|/a|b' } }), 'EXACT|/a|b');
const ctxDefault = compile('aforo-default-metric', ctxSrc, NV);
eq('context: default metric from the Named Value', run(ctxDefault, {}), 'api_calls');
eq('context: default metric variable wins', run(ctxDefault, { vars: { 'aforo-default-metric': 'calls' } }), 'calls');
// End to end: what aforo-context resolves is what aforo-metering bills.
{
    const vars = {};
    vars['aforo-customer-id'] = run(ctxCustomer, { subscription: 'acme-prod' });
    vars['aforo-metric-mappings'] = run(ctxMap, {});
    vars['aforo-default-metric'] = run(ctxDefault, {});
    eq('2.1.0 install: customer from the map', run(customerFn, { subscription: 'acme-prod', vars: vars }), 'cust_123');
    eq('2.1.0 install: mapped metric', run(metricFn, { originalPath: '/sms/send', vars: vars }), 'sms_sent');
    eq('2.1.0 install: default metric', run(metricFn, { originalPath: '/other', path: '/other', vars: vars }), 'api_calls');
    const unmapped = { 'aforo-customer-id': run(ctxCustomer, { subscription: 'initech' }) };
    eq('2.1.0 install: unmapped subscription is not billed to its subscription id',
        run(customerFn, { subscription: 'initech', vars: unmapped }), '');
}
{
    const ctxRefs = Array.from(new Set(ctxSrc.match(/\{\{[^}]*\}\}/g) || [])).sort();
    eq('context fragment references exactly its five documented Named Values', ctxRefs.join(' '),
        '{{aforo-default-metric}} {{aforo-mcp-enabled}} {{aforo-metric-mappings}} {{aforo-product-type}} {{aforo-subscription-customer-map}}');
    check('context fragment captures the MCP body with preserveContent',
        ctxSrc.indexOf('<set-variable name="aforo-mcp-body" value="@(context.Request.Body.As<string>(preserveContent: true))" />') !== -1);
}

// ── 3. Source locks ──────────────────────────────────────────────────
check('send is gated on aforo-skip',
    /<when condition="@\(Convert\.ToString\(context\.Variables\["aforo-skip"\]\) != "true"\)">\s*<choose>/.test(src));
// 2.3.0 (G348): both event bodies are built into aforo-event-batch inside the
// gate; ONE send after the gate posts it (direct mode) and nothing else
// does. The batch is cleared at the top, so only a body built inside the
// gate can reach the send.
eq('exactly one outbound send', (src.match(/<send-one-way-request /g) || []).length, 1);
{
    const gateAt = src.indexOf('context.Variables["aforo-skip"]) != "true"');
    const bodyAts = [];
    let at = -1;
    while ((at = src.indexOf('<set-variable name="aforo-event-batch" value="@{', at + 1)) !== -1) bodyAts.push(at);
    const gateEnd = src.indexOf('<send-one-way-request ');
    check('both event bodies are built inside the gate', bodyAts.length === 2 && gateAt !== -1 && bodyAts.every(function (b) { return b > gateAt && b < gateEnd; }));
    check('aforo-skip is computed before the gate', src.indexOf('<set-variable name="aforo-skip"') < gateAt);
}
eq('executionStatus added in both send bodies', (src.match(/Add\("executionStatus"/g) || []).length, 2);
eq('occurredAt is ISO-8601 in both send bodies',
    (src.match(/new JProperty\("occurredAt", DateTime\.UtcNow\.ToString\("o"\)\)/g) || []).length, 2);
check('idempotency key base is the request id (Rule #21)',
    src.indexOf('<set-variable name="aforo-idempotency-key-base" value="@(context.RequestId.ToString())" />') !== -1);
eq('idempotency key base computed once', (src.match(/name="aforo-idempotency-key-base"/g) || []).length, 1);
{
    const keys = src.match(/new JProperty\("idempotencyKey",[\s\S]*?\),\s*new JProperty\("occurredAt"/g) || [];
    eq('two idempotency keys', keys.length, 2);
    check('no clock or random in an idempotency key',
        keys.every(function (k) { return !/UtcNow|NewGuid|Random|Ticks/.test(k.replace(/new JProperty\("occurredAt"$/, '')); }));
    check('both keys derive from the frozen base',
        keys.every(function (k) { return k.indexOf('"aforo-idempotency-key-base"') !== -1; }));
}
{
    // APIM substitutes {{name}} in the policy text and refuses to save a
    // policy that names a missing Named Value. Whether it skips comments is
    // not something this repo can verify, so the file — comments included —
    // may mention only the five Named Values it documents as prerequisites.
    // The four are the ones a working-repo install (and org-service's
    // one-click deploy) already has. A Named Value that only release 2.1.0
    // created (aforo-metric-mappings, ...) must not appear here: it would
    // stop the policy from saving on every other install. Those are read
    // by context-policy-fragment.xml and arrive as context variables.
    const referenced = Array.from(new Set((src.match(/\{\{[^}]*\}\}/g) || []))).sort();
    eq('only the documented Named Values are referenced (comments included)', referenced.join(' '),
        '{{aforo-api-key}} {{aforo-endpoint}} {{aforo-mcp-enabled}} {{aforo-mcp-product-id}}');
}
{
    // Gate order inside the aforo-skip gate: OPTIONS, no customer, product
    // type that can't be sent, MCP send, unusable metric, standard send.
    const order = [
        '<when condition="@(context.Request.Method == "OPTIONS")">',
        '<when condition="@(Convert.ToString(context.Variables["aforo-event-customer"]).Length == 0)">',
        '<when condition="@(Convert.ToString(context.Variables["aforo-event-product-type"]).Length == 0)">',
        '<when condition="@(Convert.ToString(context.Variables["aforo-mcp-call"]).Length > 0)">',
        '<when condition="@(Convert.ToString(context.Variables["aforo-event-metric"]).Length == 0)">',
        '<otherwise>',
    ].map(function (m) { return src.indexOf(m); });
    check('every not-metered gate is present', order.every(function (i) { return i !== -1; }), order.join(','));
    check('gates run in order', order.every(function (i, n) { return n === 0 || order[n - 1] < i; }), order.join(','));
    const firstBody = src.indexOf('<set-variable name="aforo-event-batch" value="@{');
    check('OPTIONS, no-customer and product-type gates come before the first body',
        order[0] < firstBody && order[1] < firstBody && order[2] < firstBody);
    const sends = src.split('<set-variable name="aforo-event-batch" value="@{').slice(1).map(function (s) { return s.slice(0, s.indexOf('}" />')); });
    check('MCP body sits in the MCP branch, standard body in <otherwise>',
        firstBody > order[3] && firstBody < order[4]
        && src.lastIndexOf('<set-variable name="aforo-event-batch" value="@{') > order[5]);
    sends.forEach(function (s, n) {
        check('body ' + n + ': customerId is the resolved customer',
            s.indexOf('new JProperty("customerId", Convert.ToString(context.Variables["aforo-event-customer"]))') !== -1);
        check('body ' + n + ': top-level productType', /new JProperty\("productType",/.test(s));
        check('body ' + n + ': no subscription key', !/Subscription\??\.Key/.test(s));
    });
    {
        const send = src.slice(src.indexOf('<send-one-way-request '), src.indexOf('</send-one-way-request>'));
        check('send: X-API-Key only', send.indexOf('<set-header name="X-API-Key"') !== -1
            && send.indexOf('X-Tenant-Id') === -1 && send.indexOf('Authorization') === -1);
    }
    check('standard send uses the resolved metric',
        sends[1].indexOf('new JProperty("metricName", Convert.ToString(context.Variables["aforo-event-metric"]))') !== -1);
    check('MCP send keeps the MCP metric', sends[0].indexOf('new JProperty("metricName", "mcp_server.tool_invocations")') !== -1);
    check('MCP key is the frozen base plus the tool name',
        /"mcp:" \+ context\.Variables\.GetValueOrDefault\("aforo-idempotency-key-base", ""\) \+\s*":" \+ toolName\)/.test(sends[0]));
    check('traceparent still classifies AGENTIC_API', sends[1].indexOf('? "AGENTIC_API" : Convert.ToString(context.Variables["aforo-event-product-type"])') !== -1);
}
{
    // The optional fragments: same identity rule, no secret as customer,
    // nothing to the ingestor but X-API-Key, OPTIONS skipped.
    ['compound-metering-policy-fragment.xml', 'preflight-quota-policy-fragment.xml'].forEach(function (f) {
        const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        const code = t.slice(t.indexOf('\n<fragment>'));
        check(f + ': skips OPTIONS', code.indexOf('context.Request.Method != "OPTIONS"') !== -1);
        check(f + ': sends X-API-Key and no X-Tenant-Id', code.indexOf('<set-header name="X-API-Key"') !== -1 && code.indexOf('X-Tenant-Id') === -1);
        check(f + ': customer never from Subscription.Key or User.Id', !/Subscription\??\.Key|User\??\.Id/.test(code));
        const refs = Array.from(new Set(code.match(/\{\{[^}]*\}\}/g) || []));
        eq(f + ': the only Named Value referenced is the API key', refs.join(' '), '{{aforo-api-key}}');
        const marker = code.match(/<set-variable name="(aforo-(?:compound|preflight)-customer)" value="/)[1];
        const fn = compile(marker, t);
        eq(f + ': customer = variable', run(fn, { subscription: 's', vars: { 'aforo-customer-id': 'cust_1' } }), 'cust_1');
        eq(f + ': customer = subscription id', run(fn, { subscription: 'sub-1' }), 'sub-1');
        eq(f + ': empty variable -> none', run(fn, { subscription: 'sub-1', vars: { 'aforo-customer-id': '' } }), '');
        eq(f + ': nothing -> none', run(fn, {}), '');
        eq(f + ': over 64 characters -> none', run(fn, { subscription: 'c'.repeat(65) }), '');
    });
    const compound = fs.readFileSync(path.join(__dirname, '..', 'compound-metering-policy-fragment.xml'), 'utf8');
    check('compound correlationId is the request id (Rule #21)',
        compound.indexOf('evt["correlationId"] = context.RequestId.ToString();') !== -1 && !/NewGuid|Ticks|Random/.test(compound.slice(compound.indexOf('\n<fragment>'))));
    check('compound extraction keeps the parenthesised null check',
        compound.indexOf('if (token != null && (token.Type == JTokenType.Integer || token.Type == JTokenType.Float))') !== -1);
    check('compound carries productType', compound.indexOf('evt["productType"] = productType;') !== -1);
    check('compound occurredAt is ISO-8601', compound.indexOf('evt["occurredAt"] = DateTime.UtcNow.ToString("o");') !== -1);
    const preflight = fs.readFileSync(path.join(__dirname, '..', 'preflight-quota-policy-fragment.xml'), 'utf8');
    check('preflight reads the decision from the data envelope', preflight.indexOf('var data = body["data"] ?? body;') !== -1);
    const mg = fs.readFileSync(path.join(__dirname, '..', 'margin-guard-policy-fragment.xml'), 'utf8');
    const mgCode = mg.slice(mg.indexOf('\n<fragment>'));
    // 2.3.0: the call carries the Aforo API key (G350), so aforo-api-key is the one Named Value.
    check('margin guard references no Named Value but the API key', (mgCode.match(/\{\{[^}]*\}\}/g) || []).every(function (r) { return r === '{{aforo-api-key}}'; }));
    check('margin guard does not index a variable that may be absent', mgCode.indexOf('context.Variables["aforo-margin-guard-url"]') === -1);
    check('margin guard escapes the customer id in the URL', (mgCode.match(/Uri\.EscapeDataString/g) || []).length === 1);
    check('margin guard calls the public key-authenticated check', mgCode.indexOf('"/api/v1/margin-guard/quick-check?scopeType=CUSTOMER&scopeId="') !== -1);
    check('margin guard never calls the internal path', mgCode.indexOf('/internal/') === -1);
    check('margin guard sends no tenant id (pricing takes it from the key)', !/tenantId=|name="X-Tenant-Id"/.test(mgCode));
    check('margin guard never reads identity from request headers', !/Request\.Headers/.test(mgCode));
    const jwt = fs.readFileSync(path.join(__dirname, '..', 'jwt-validation-policy.xml'), 'utf8');
    const jwtCode = jwt.slice(jwt.indexOf('\n<fragment>'));
    check('jwt: no hardcoded compose hostname', jwtCode.indexOf('org-service:8086') === -1);
    check('jwt: the Jwt output variable is not cast to string', !/\(string\)context\.Variables\.GetValueOrDefault\(\s*"aforo-jwt"/.test(jwtCode));
    check('jwt: expiry and signature are required',
        jwtCode.indexOf('require-expiration-time="true"') !== -1 && jwtCode.indexOf('require-signed-tokens="true"') !== -1);
    check('jwt: payload is decoded after validate-jwt', jwtCode.indexOf('</validate-jwt>') < jwtCode.indexOf('name="aforo-jwt-payload"'));
}
check('stale secondary fragment is gone',
    !fs.existsSync(path.join(__dirname, '..', 'policy-fragment.xml')));


// ── 4. APIM fragment rules ───────────────────────────────────────────
// https://learn.microsoft.com/azure/api-management/policy-fragments :
//   "A policy fragment can't include a policy section identifier
//    (<inbound>, <outbound>, for example) or the <base/> element."
//   "Currently, a policy fragment can't nest another policy fragment."
// Every file here is uploaded with format "rawxml" (the expressions hold
// raw quotes and <), so an XML entity inside an expression would reach the
// C# compiler as literal text.
// 16 KiB is the Consumption tier's policy document limit
// (api-management-gateways-overview, "Gateway runtime limits"); the
// fragment limit itself is 512 KB.
const CONSUMPTION_POLICY_LIMIT = 16 * 1024;
fs.readdirSync(path.join(__dirname, '..')).filter(function (f) { return f.endsWith('.xml'); }).forEach(function (f) {
    const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const at = text.indexOf('\n<fragment>');
    check(f + ': has a <fragment> root', at !== -1);
    if (at === -1) return;
    const uploaded = text.slice(at + 1);
    check(f + ': nothing after </fragment>', uploaded.trimEnd().endsWith('</fragment>'));
    eq(f + ': one <fragment> element', (uploaded.match(/<fragment>/g) || []).length, 1);
    const code = uploaded.replace(/<!--[\s\S]*?-->/g, '');
    ['inbound', 'backend', 'outbound', 'on-error', 'policies', 'base'].forEach(function (el) {
        check(f + ': no <' + el + '> inside the fragment', !new RegExp('<' + el + '[\\s/>]').test(code));
    });
    check(f + ': does not include another fragment', code.indexOf('<include-fragment') === -1);
    {
        // Well formed once the expressions are masked (same check as section 1).
        let m = '';
        let last = 0;
        findExpressions(text).forEach(function (e, n) { m += text.slice(last, e.start) + 'EXPR' + n; last = e.end; });
        m += text.slice(last);
        eq(f + ': well formed', tagCheck(m), null);
        const x = spawnSync('xmllint', ['--noout', '-'], { input: m });
        if (!x.error) eq(f + ': well formed (xmllint)', x.status, 0);
    }
    findExpressions(uploaded).forEach(function (e, n) {
        check(f + ': expression ' + n + ' has no XML entity (rawxml upload)',
            !/&(amp|lt|gt|quot|apos);/.test(e.body.replace(/\/\/.*$/gm, '')));
    });
    // An XML parser turns the line breaks inside an attribute value into
    // spaces, so a C# line comment there would swallow the rest of the
    // expression. Block comments only.
    (uploaded.match(/(?:value|condition)="@\{[\s\S]*?\}"/g) || []).forEach(function (attr, n) {
        check(f + ': attribute expression ' + n + ' has no // line comment',
            !attr.split('\n').some(function (line) { return /(^|\s)\/\//.test(line); }));
    });
    check(f + ': uploaded body fits the Consumption tier (16 KiB), is ' + Buffer.byteLength(uploaded),
        Buffer.byteLength(uploaded) <= CONSUMPTION_POLICY_LIMIT);
});
check('nested legacy fragment is gone', !fs.existsSync(path.join(__dirname, '..', 'mcp-policy-fragment.xml')));
{
    // The explanatory header is not uploaded, so it must end right before <fragment>.
    const at = src.indexOf('<fragment>');
    check('header comment closes directly before <fragment>', /-->\s*$/.test(src.slice(0, at)));
    check('header comment has no "--"', src.slice(4, src.indexOf('-->')).indexOf('--') === -1);
}


// ── 5. Wave 6 W6.3 (G348, G350, G351, G352, G353) ────────────────────
// Each block runs on its own so a missing variable fails that block, not
// the whole file.
function section(name, fn) {
    try { fn(); } catch (e) { check(name + ' (block threw)', false, e && e.message); }
}
const readPolicy = function (f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); };
const codeOf = function (t) { return t.slice(t.indexOf('\n<fragment>')); };
// Convert.ToInt32 / ToInt64 throw on anything that is not a whole number, as in .NET.
Convert.ToInt32 = Convert.ToInt64 = function (v) {
    const t = String(v).trim();
    if (!/^-?[0-9]+$/.test(t)) throw new Error('FormatException: ' + JSON.stringify(v));
    return Number(t);
};
define(String.prototype, 'LastIndexOf', function (s) { return this.lastIndexOf(s); });

section('G348 delivery mode', function () {
    const deliveryFn = compile('aforo-delivery');
    eq('delivery: default is direct', run(deliveryFn, {}), 'direct');
    eq('delivery: eventhub (trimmed, any case)', run(deliveryFn, { vars: { 'aforo-delivery-mode': ' EventHub ' } }), 'eventhub');
    eq('delivery: unknown value -> direct', run(deliveryFn, { vars: { 'aforo-delivery-mode': 'kafka' } }), 'direct');
    eq('delivery: non-string -> direct', run(deliveryFn, { vars: { 'aforo-delivery-mode': 7 } }), 'direct');
    eq('delivery: null -> direct', run(deliveryFn, { vars: { 'aforo-delivery-mode': null } }), 'direct');

    eq('one outbound send, shared by both event shapes', (src.match(/<send-one-way-request /g) || []).length, 1);
    eq('both event bodies are built into aforo-event-batch', (src.match(/<set-variable name="aforo-event-batch" value="@\{/g) || []).length, 2);
    const sendAt = src.indexOf('<send-one-way-request ');
    const sendBlock = src.slice(src.lastIndexOf('<when', sendAt), src.indexOf('</send-one-way-request>') + 23);
    check('the send is skipped in eventhub mode',
        sendBlock.indexOf('Convert.ToString(context.Variables["aforo-delivery"]) == "direct"') !== -1, sendBlock.slice(0, 200));
    check('the send only fires when a batch was built',
        sendBlock.indexOf('Convert.ToString(context.Variables["aforo-event-batch"]).Length > 0') !== -1);
    check('the send body is the built batch', sendBlock.indexOf('<set-body>@(Convert.ToString(context.Variables["aforo-event-batch"]))</set-body>') !== -1);
    check('the batch is cleared first, so a value from inbound is never sent',
        src.indexOf('<set-variable name="aforo-event-batch" value="@(string.Empty)" />') !== -1
        && src.indexOf('<set-variable name="aforo-event-batch" value="@(string.Empty)" />') < src.indexOf('<set-variable name="aforo-event-batch" value="@{'));
    check('outbound policy does not reference a logger (it must save on installs without Event Hub)', codeOf(src).indexOf('log-to-eventhub') === -1);

    const eh = readPolicy('eventhub-delivery-policy-fragment.xml');
    const ehCode = codeOf(eh);
    eq('eventhub fragment: two log-to-eventhub statements (usage + compound)', (ehCode.match(/<log-to-eventhub /g) || []).length, 2);
    check('eventhub fragment: fixed logger id aforo-metering-logger', (ehCode.match(/logger-id="aforo-metering-logger"/g) || []).length === 2);
    check('eventhub fragment: partition key is the customer', ehCode.indexOf('partition-key="@(') !== -1);
    check('eventhub fragment: references no Named Value', !/\{\{/.test(ehCode));
    check('eventhub fragment: logs only in eventhub mode', (ehCode.match(/== "eventhub"/g) || []).length >= 2);
    check('eventhub fragment: never carries the API key', ehCode.indexOf('aforo-api-key') === -1 && ehCode.indexOf('X-API-Key') === -1);

    const compound = readPolicy('compound-metering-policy-fragment.xml');
    const cCode = codeOf(compound);
    check('compound: event built into aforo-compound-event', cCode.indexOf('<set-variable name="aforo-compound-event" value="@{') !== -1);
    check('compound: direct send skipped in eventhub mode', /<when condition="@\([^"]*aforo-compound-event[\s\S]*?"eventhub"/.test(cCode) || cCode.indexOf('!= "eventhub"') !== -1);
    eq('compound: one send', (cCode.match(/<send-one-way-request /g) || []).length, 1);
    check('compound: no logger here either', cCode.indexOf('log-to-eventhub') === -1);
});

section('G350 auth on outbound calls', function () {
    const jwt = codeOf(readPolicy('jwt-validation-policy.xml'));
    check('jwt: X-Internal-Call is gone', jwt.indexOf('X-Internal-Call') === -1);
    const jtiCall = jwt.slice(jwt.indexOf('<send-request'), jwt.indexOf('</send-request>'));
    check('jwt: revocation call sends X-API-Key', jtiCall.indexOf('<set-header name="X-API-Key"') !== -1);
    check('jwt: revocation call goes to org-service token-status', jtiCall.indexOf('{{aforo-org-service-url}}/api/v1/public/gateway/token-status?jti={0}&keyId={1}&clientId={2}') !== -1);
    check('jwt: revocation call never uses the old internal path', jwt.indexOf('/internal/v1/auth/token-check') === -1);
    check('jwt: key from aforo-api-key (variable, else Named Value)',
        jtiCall.indexOf('context.Variables.ContainsKey("aforo-api-key") ? Convert.ToString(context.Variables["aforo-api-key"]) : "{{aforo-api-key}}"') !== -1);
    const mg = codeOf(readPolicy('margin-guard-policy-fragment.xml'));
    const mgCall = mg.slice(mg.indexOf('<send-request'), mg.indexOf('</send-request>'));
    check('margin guard: call sends X-API-Key', mgCall.indexOf('<set-header name="X-API-Key"') !== -1);
    eq('margin guard: the only Named Value is the API key', Array.from(new Set(mg.match(/\{\{[^}]*\}\}/g) || [])).join(' '), '{{aforo-api-key}}');
});

// The breaker state machine shared by the three synchronous checks.
// cached value -> call? ; answer -> next state "value|ttl"
section('G351 preflight cache + breaker', function () {
    const t = readPolicy('preflight-quota-policy-fragment.xml');
    const limitsFn = compile('aforo-preflight-limits', t);
    eq('preflight limits: defaults', run(limitsFn, {}), '5,3,30');
    eq('preflight limits: overrides', run(limitsFn, { vars: { 'aforo-preflight-cache-seconds': '0', 'aforo-preflight-breaker-failures': ' 5 ', 'aforo-preflight-breaker-seconds': '120' } }), '0,5,120');
    eq('preflight limits: junk -> defaults', run(limitsFn, { vars: { 'aforo-preflight-cache-seconds': '-1', 'aforo-preflight-breaker-failures': '0', 'aforo-preflight-breaker-seconds': 'x' } }), '5,3,30');
    const L = { 'aforo-preflight-limits': '5,3,30' };
    const callFn = compile('aforo-preflight-call', t);
    const call = function (cached) {
        const v = Object.assign({}, L);
        if (cached !== undefined) v['aforo-preflight-cached'] = cached;
        return run(callFn, { vars: v });
    };
    eq('preflight call: nothing cached -> call', call(), 'true');
    eq('preflight call: cached ALLOW -> no call', call('D:ALLOW'), 'false');
    eq('preflight call: cached DENY -> no call', call('D:DENY:1900000000'), 'false');
    eq('preflight call: one failure so far -> call', call('F:1'), 'true');
    eq('preflight call: failures at the limit would have opened -> F:3 does not call', call('F:3'), 'false');
    eq('preflight call: breaker open -> no call', call('OPEN'), 'false');
    eq('preflight call: corrupt cache entry -> call', call('F:x'), 'true');

    const stateFn = compile('aforo-preflight-state', t);
    const state = function (answer, cached, limits) {
        const v = { 'aforo-preflight-limits': limits || '5,3,30', 'aforo-preflight-call': 'true', 'aforo-preflight-answer': answer, 'aforo-preflight-now': '1000' };
        if (cached !== undefined) v['aforo-preflight-cached'] = cached;
        return run(stateFn, { vars: v });
    };
    eq('preflight state: ALLOW cached for the cache window', state('ALLOW'), 'D:ALLOW|5');
    eq('preflight state: WARN cached for the cache window', state('WARN'), 'D:WARN|5');
    eq('preflight state: cache 0 -> ALLOW not cached', state('ALLOW', undefined, '0,3,30'), '');
    eq('preflight state: DENY cached until Retry-After', state('DENY|90'), 'D:DENY:1090|90');
    eq('preflight state: DENY cached even with cache 0', state('DENY|90', undefined, '0,3,30'), 'D:DENY:1090|90');
    eq('preflight state: first failure counts', state('UNAVAILABLE'), 'F:1|30');
    eq('preflight state: second failure counts', state('UNAVAILABLE', 'F:1'), 'F:2|30');
    eq('preflight state: third failure opens the breaker', state('UNAVAILABLE', 'F:2'), 'OPEN|30');
    eq('preflight state: success after failures resets', state('ALLOW', 'F:2'), 'D:ALLOW|5');
    eq('preflight state: no call -> nothing stored', run(stateFn, { vars: Object.assign({ 'aforo-preflight-call': 'false', 'aforo-preflight-answer': '' }, L) }), '');

    const decisionFn = compile('preflightDecision', t);
    const decide = function (o) {
        const v = Object.assign({}, L, o);
        return run(decisionFn, { vars: v });
    };
    eq('preflight decision: answer ALLOW', decide({ 'aforo-preflight-call': 'true', 'aforo-preflight-answer': 'ALLOW' }), 'ALLOW');
    eq('preflight decision: answer DENY', decide({ 'aforo-preflight-call': 'true', 'aforo-preflight-answer': 'DENY|60' }), 'DENY');
    eq('preflight decision: unavailable -> fallback ALLOW', decide({ 'aforo-preflight-call': 'true', 'aforo-preflight-answer': 'UNAVAILABLE' }), 'ALLOW');
    eq('preflight decision: unavailable -> fallback DENY when set', decide({ 'aforo-preflight-call': 'true', 'aforo-preflight-answer': 'UNAVAILABLE', 'aforo-preflight-fallback': ' deny ' }), 'DENY');
    eq('preflight decision: cached DENY', decide({ 'aforo-preflight-call': 'false', 'aforo-preflight-answer': '', 'aforo-preflight-cached': 'D:DENY:1900000000' }), 'DENY');
    eq('preflight decision: cached WARN', decide({ 'aforo-preflight-call': 'false', 'aforo-preflight-answer': '', 'aforo-preflight-cached': 'D:WARN' }), 'WARN');
    eq('preflight decision: breaker open -> fallback', decide({ 'aforo-preflight-call': 'false', 'aforo-preflight-answer': '', 'aforo-preflight-cached': 'OPEN', 'aforo-preflight-fallback': 'DENY' }), 'DENY');

    const retryFn = compile('aforo-preflight-retry-after', t);
    eq('preflight Retry-After: from the answer', run(retryFn, { vars: { 'aforo-preflight-answer': 'DENY|90', 'aforo-preflight-now': '1000' } }), '90');
    eq('preflight Retry-After: time left on a cached DENY', run(retryFn, { vars: { 'aforo-preflight-answer': '', 'aforo-preflight-cached': 'D:DENY:1042', 'aforo-preflight-now': '1000' } }), '42');
    eq('preflight Retry-After: expired cached DENY -> 1', run(retryFn, { vars: { 'aforo-preflight-answer': '', 'aforo-preflight-cached': 'D:DENY:900', 'aforo-preflight-now': '1000' } }), '1');
    eq('preflight Retry-After: otherwise 60', run(retryFn, { vars: { 'aforo-preflight-answer': '' } }), '60');

    const code = codeOf(t);
    eq('preflight: one cache lookup', (code.match(/<cache-lookup-value /g) || []).length, 1);
    eq('preflight: one cache store', (code.match(/<cache-store-value /g) || []).length, 1);
    check('preflight: the call happens only when the breaker allows it',
        code.indexOf('<when condition="@(Convert.ToString(context.Variables["aforo-preflight-call"]) == "true")">') !== -1
        && code.indexOf('aforo-preflight-call') < code.indexOf('<send-request'));
    check('preflight: the 429 carries the computed Retry-After',
        code.indexOf('<value>@(Convert.ToString(context.Variables["aforo-preflight-retry-after"]))</value>') !== -1);
    check('preflight: the cache key names the key scope and the customer', code.indexOf('key="@("aforo:pf:" + Convert.ToString(context.Variables["aforo-preflight-scope"]) + ":" + Convert.ToString(context.Variables["aforo-preflight-customer"]))"') !== -1);
});

section('G351 revocation cache + breaker', function () {
    const t = readPolicy('jwt-validation-policy.xml');
    const keyFn = compile('aforo-jti-key', t);
    eq('jti key: jti and key id', run(keyFn, { vars: { 'aforo-jwt-payload': { jti: 'j1', key_id: 'k1' } } }), 'aforo:jti:j1:k1');
    eq('jti key: no jti and no key id -> no check', run(keyFn, { vars: { 'aforo-jwt-payload': { sub: 's' } } }), '');
    eq('jti key: no payload -> no check', run(keyFn, {}), '');
    eq('jti key: switched off', run(keyFn, { vars: { 'aforo-jwt-payload': { jti: 'j1' }, 'aforo-jti-check-enabled': 'false' } }), '');
    const limitsFn = compile('aforo-jti-limits', t);
    eq('jti limits: defaults', run(limitsFn, {}), '30,3,30');
    const callFn = compile('aforo-jti-call', t);
    const call = function (key, cached) {
        const v = { 'aforo-jti-key': key, 'aforo-jti-limits': '30,3,30' };
        if (cached !== undefined) v['aforo-jti-cached'] = cached;
        return run(callFn, { vars: v });
    };
    eq('jti call: nothing cached', call('aforo:jti:j1:'), 'true');
    eq('jti call: no key -> no call', call(''), 'false');
    eq('jti call: cached OK', call('aforo:jti:j1:', 'OK'), 'false');
    eq('jti call: cached REVOKED', call('aforo:jti:j1:', 'REVOKED'), 'false');
    eq('jti call: breaker open', call('aforo:jti:j1:', 'OPEN'), 'false');
    eq('jti call: below the failure limit', call('aforo:jti:j1:', 'F:2'), 'true');
    const stateFn = compile('aforo-jti-state', t);
    const state = function (answer, cached) {
        const v = { 'aforo-jti-limits': '30,3,30', 'aforo-jti-call': 'true', 'aforo-jti-answer': answer };
        if (cached !== undefined) v['aforo-jti-cached'] = cached;
        return run(stateFn, { vars: v });
    };
    eq('jti state: not revoked cached for the cache window', state('OK'), 'OK|30');
    eq('jti state: revoked cached for the token lifetime', state('REVOKED|1200'), 'REVOKED|1200');
    eq('jti state: failures open the breaker', state('UNAVAILABLE', 'F:2'), 'OPEN|30');
    eq('jti state: first failure', state('UNAVAILABLE'), 'F:1|30');
    const verdictFn = compile('aforo-jti-verdict', t);
    const verdict = function (o) { return run(verdictFn, { vars: o }); };
    eq('jti verdict: revoked answer', verdict({ 'aforo-jti-call': 'true', 'aforo-jti-answer': 'REVOKED|5' }), 'revoked');
    eq('jti verdict: cached revoked', verdict({ 'aforo-jti-call': 'false', 'aforo-jti-answer': '', 'aforo-jti-cached': 'REVOKED' }), 'revoked');
    eq('jti verdict: ok', verdict({ 'aforo-jti-call': 'true', 'aforo-jti-answer': 'OK' }), 'ok');
    eq('jti verdict: unavailable fails open by default (2.2.0 behaviour)', verdict({ 'aforo-jti-call': 'true', 'aforo-jti-answer': 'UNAVAILABLE' }), 'ok');
    eq('jti verdict: unavailable with fallback DENY', verdict({ 'aforo-jti-call': 'true', 'aforo-jti-answer': 'UNAVAILABLE', 'aforo-jti-check-fallback': 'DENY' }), 'unavailable');
    eq('jti verdict: breaker open with fallback DENY', verdict({ 'aforo-jti-call': 'false', 'aforo-jti-answer': '', 'aforo-jti-cached': 'OPEN', 'aforo-jti-check-fallback': 'DENY' }), 'unavailable');
    eq('jti verdict: no check at all', verdict({ 'aforo-jti-call': 'false', 'aforo-jti-answer': '' }), 'ok');
    const code = codeOf(t);
    eq('jti: one cache lookup', (code.match(/<cache-lookup-value /g) || []).length, 1);
    eq('jti: one cache store', (code.match(/<cache-store-value /g) || []).length, 1);
    check('jti: unavailable + DENY answers 503', code.indexOf('<set-status code="503"') !== -1);
});

section('G351 margin guard breaker', function () {
    const t = readPolicy('margin-guard-policy-fragment.xml');
    const callFn = compile('mgCall', t);
    const call = function (cached) {
        const v = { 'mgLimits': '30,3,30' };
        if (cached !== undefined) v['mgCached'] = cached;
        return run(callFn, { vars: v });
    };
    eq('mg call: nothing cached', call(), 'true');
    eq('mg call: cached result', call('R:{"verdict":"BLOCK"}'), 'false');
    eq('mg call: breaker open', call('OPEN'), 'false');
    eq('mg call: one failure', call('F:1'), 'true');
    const stateFn = compile('mgState', t);
    const state = function (answer, cached) {
        const v = { 'mgLimits': '30,3,30', 'mgCall': 'true', 'mgAnswer': answer };
        if (cached !== undefined) v['mgCached'] = cached;
        return run(stateFn, { vars: v });
    };
    eq('mg state: BLOCK cached (even with a | inside)', state('{"verdict":"BLOCK","message":"x|y"}'), 'R:{"verdict":"BLOCK","message":"x|y"}|30');
    eq('mg state: plain ALLOW cached', state('{"verdict":"ALLOW","currentLevel":"NONE"}'), 'R:{"verdict":"ALLOW","currentLevel":"NONE"}|30');
    eq('mg state: enveloped BLOCK cached', state('{"success":true,"data":{"verdict":"BLOCK"}}'), 'R:{"success":true,"data":{"verdict":"BLOCK"}}|30');
    eq('mg state: THROTTLE never cached', state('{"verdict":"THROTTLE","currentLevel":"L2_THROTTLE"}'), '');
    eq('mg state: ALLOW while a throttle is active not cached', state('{"verdict":"ALLOW","currentLevel":"L2_THROTTLE"}'), '');
    eq('mg state: WARN not cached', state('{"verdict":"WARN","currentLevel":"L1_WARNING"}'), '');
    eq('mg state: an answer not kept resets the failure count', state('{"verdict":"THROTTLE"}', 'F:2'), 'F:0|30');
    eq('mg state: an answer without verdict is not cached', state('{"allowed":false,"level":"L3_BLOCK"}'), '');
    eq('mg state: failure', state('UNAVAILABLE', 'F:2'), 'OPEN|30');
    eq('mg state: first failure', state('UNAVAILABLE'), 'F:1|30');
    const resultFn = compile('mgResult', t);
    eq('mg result: fresh answer', run(resultFn, { vars: { mgCall: 'true', mgAnswer: '{"verdict":"BLOCK"}' } }), '{"verdict":"BLOCK"}');
    eq('mg result: cached answer', run(resultFn, { vars: { mgCall: 'false', mgAnswer: '', mgCached: 'R:{"verdict":"BLOCK"}' } }), '{"verdict":"BLOCK"}');
    eq('mg result: breaker open fails open', run(resultFn, { vars: { mgCall: 'false', mgAnswer: '', mgCached: 'OPEN' } }), '{"verdict":"ALLOW","currentLevel":"NONE"}');
    eq('mg result: unavailable fails open', run(resultFn, { vars: { mgCall: 'true', mgAnswer: 'UNAVAILABLE' } }), '{"verdict":"ALLOW","currentLevel":"NONE"}');
    const verdictFn = compile('mgVerdict', t);
    const verdict = function (result) { return run(verdictFn, { vars: { mgResult: result } }); };
    eq('mg verdict: BLOCK', verdict('{"verdict":"BLOCK","currentLevel":"L3_BLOCK"}'), 'BLOCK');
    eq('mg verdict: THROTTLE', verdict('{"verdict":"THROTTLE"}'), 'THROTTLE');
    eq('mg verdict: WARN', verdict('{"verdict":"WARN"}'), 'WARN');
    eq('mg verdict: lower case', verdict('{"verdict":"block"}'), 'BLOCK');
    eq('mg verdict: enveloped', verdict('{"success":true,"data":{"verdict":"THROTTLE"}}'), 'THROTTLE');
    eq('mg verdict: the old allowed/level shape is not a block', verdict('{"allowed":false,"level":"L3_BLOCK"}'), 'ALLOW');
    eq('mg verdict: unknown value', verdict('{"verdict":"MAYBE"}'), 'ALLOW');
    eq('mg verdict: not JSON', verdict('nope'), 'ALLOW');
    const messageFn = compile('mgMessage', t);
    eq('mg message: from the answer', run(messageFn, { vars: { mgResult: '{"verdict":"BLOCK","message":"low"}' } }), 'low');
    eq('mg message: absent', run(messageFn, { vars: { mgResult: '{"verdict":"BLOCK"}' } }), '');
    const code = codeOf(t);
    eq('mg: one cache lookup', (code.match(/<cache-lookup-value /g) || []).length, 1);
    eq('mg: one cache store', (code.match(/<cache-store-value /g) || []).length, 1);
});

section('G352 compound skips streaming responses', function () {
    const t = readPolicy('compound-metering-policy-fragment.xml');
    const fn = compile('aforo-compound-streaming', t);
    const headers = function (h) {
        const ctx = makeContext({});
        ctx.Response.Headers = { GetValueOrDefault: function (k, d) {
            const hit = Object.keys(h).filter(function (x) { return x.toLowerCase() === k.toLowerCase(); })[0];
            return hit === undefined ? d : h[hit];
        } };
        return fn(ctx, Convert, SystemShim, { Ordinal: 4, OrdinalIgnoreCase: 5 }, stringShim, JObjectShim);
    };
    eq('compound: JSON with a length is read', headers({ 'Content-Type': 'application/json', 'Content-Length': '512' }), '');
    eq('compound: SSE is never buffered', headers({ 'Content-Type': 'text/event-stream; charset=utf-8' }), 'text/event-stream');
    eq('compound: NDJSON stream is never buffered', headers({ 'Content-Type': 'application/x-ndjson' }), 'stream');
    eq('compound: chunked non-JSON is never buffered', headers({ 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' }), 'chunked');
    eq('compound: chunked JSON is read', headers({ 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }), '');
    eq('compound: body over the cap is not read', headers({ 'Content-Type': 'application/json', 'Content-Length': '2000000' }), 'too-large');
    eq('compound: no response headers object -> read', headers({}), '');
    const code = codeOf(t);
    check('compound: the body is read only when not streaming',
        code.indexOf('Convert.ToString(context.Variables["aforo-compound-streaming"]).Length == 0') !== -1
        && code.indexOf('aforo-compound-streaming') < code.indexOf('Body.As<JObject>(preserveContent: true)'));
    check('compound: a skipped stream is traced', code.indexOf('<trace source="aforo-compound-metering"') !== -1);
});

section('G353 subscription map lookup is cached', function () {
    const srcFn = compile('aforo-customer-source', ctxSrc, NV);
    eq('source: preset variable', run(srcFn, { subscription: 's', vars: { 'aforo-customer-id': 'c' } }), 'preset');
    eq('source: JWT claim', run(srcFn, { subscription: 's', vars: { 'aforo-jwt-payload': { customer_id: 'c' } } }), 'jwt');
    eq('source: subscription map', run(srcFn, { subscription: 's' }), 'map');
    eq('source: nothing', run(srcFn, {}), 'none');
    const keyFn = compile('aforo-customer-map-key', ctxSrc, NV);
    const mapLen = NV['aforo-subscription-customer-map'].length;
    eq('map key: version, map length and subscription', run(keyFn, { subscription: 'acme-prod', vars: { 'aforo-customer-source': 'map' } }), 'aforo:cust:1:' + mapLen + ':acme-prod');
    eq('map key: version from the variable', run(keyFn, { subscription: 'acme-prod', vars: { 'aforo-customer-source': 'map', 'aforo-customer-map-version': ' 7 ' } }), 'aforo:cust:7:' + mapLen + ':acme-prod');
    eq('map key: caching off', run(keyFn, { subscription: 'acme-prod', vars: { 'aforo-customer-source': 'map', 'aforo-customer-map-cache-seconds': '0' } }), '');
    eq('map key: not a map lookup', run(keyFn, { subscription: 'acme-prod', vars: { 'aforo-customer-source': 'jwt' } }), '');
    eq('map key: a map from a variable changes the key', run(keyFn, { subscription: 'acme-prod', vars: { 'aforo-customer-source': 'map', 'aforo-subscription-customer-map': 'a=b' } }), 'aforo:cust:1:3:acme-prod');
    eq('customer: a cache hit is used without parsing', run(ctxCustomer, { subscription: 'acme-prod', vars: { 'aforo-customer-map-cached': 'cust_cached' } }), 'cust_cached');
    eq('customer: a cached miss stays a miss', run(ctxCustomer, { subscription: 'acme-prod', vars: { 'aforo-customer-map-cached': '~' } }), '');
    eq('customer: a JWT claim still wins over the cache', run(ctxCustomer, { subscription: 'acme-prod', vars: { 'aforo-customer-map-cached': 'cust_cached', 'aforo-jwt-payload': { customer_id: 'cust_jwt' } } }), 'cust_jwt');
    const code = codeOf(ctxSrc);
    eq('context: one cache lookup', (code.match(/<cache-lookup-value /g) || []).length, 1);
    eq('context: one cache store', (code.match(/<cache-store-value /g) || []).length, 1);
    check('context: a miss is stored as "~"', code.indexOf('"~"') !== -1);
});


section('W6.3 review: JWT tenant binding', function () {
    const t = readPolicy('jwt-validation-policy.xml');
    const NVT = { 'aforo-tenant-id': 'tenant_b' };
    const tenantFn = compile('aforo-jwt-tenant', t, NVT);
    eq('jwt tenant: the Named Value', run(tenantFn, {}), 'tenant_b');
    eq('jwt tenant: the context variable wins, trimmed', run(tenantFn, { vars: { 'aforo-tenant-id': ' tenant_c ' } }), 'tenant_c');
    eq('jwt tenant: an empty variable is no tenant', run(tenantFn, { vars: { 'aforo-tenant-id': null } }), '');
    const matchFn = compile('aforo-jwt-tenant-match', t);
    const match = function (claims, configured) {
        const v = { 'aforo-jwt-tenant': configured === undefined ? 'tenant_b' : configured };
        if (claims !== undefined) v['aforo-jwt-payload'] = claims;
        return run(matchFn, { vars: v });
    };
    eq('tenant match: same tenant', match({ tenant_id: 'tenant_b' }), 'true');
    eq('tenant match: another tenant\'s token is refused', match({ tenant_id: 'tenant_a' }), 'false');
    eq('tenant match: no tenant_id claim is refused', match({ sub: 'x' }), 'false');
    eq('tenant match: no payload is refused', match(undefined), 'false');
    eq('tenant match: no configured tenant is refused (fail closed)', match({ tenant_id: '' }, ''), 'false');
    eq('tenant match: case matters', match({ tenant_id: 'Tenant_B' }), 'false');
    const code = codeOf(t);
    const reject = code.indexOf('<when condition="@(Convert.ToString(context.Variables["aforo-jwt-tenant-match"]) != "true")">');
    check('jwt: a tenant mismatch returns 401 TENANT_MISMATCH',
        reject !== -1 && code.indexOf('"error_description": "TENANT_MISMATCH"', reject) !== -1 && code.indexOf('<set-status code="401"', reject) !== -1);
    check('jwt: the tenant is checked before any header is set or any call is made',
        reject !== -1 && reject < code.indexOf('<set-header name="X-Customer-Id"') && reject < code.indexOf('<send-request'));
    const tenantHeader = code.slice(code.indexOf('<set-header name="X-Tenant-Id"'), code.indexOf('</set-header>', code.indexOf('<set-header name="X-Tenant-Id"')));
    check('jwt: X-Tenant-Id upstream is the configured tenant, never the claim',
        tenantHeader.indexOf('context.Variables["aforo-jwt-tenant"]') !== -1 && tenantHeader.indexOf('tenant_id') === -1);
    check('jwt: references the Named Value aforo-tenant-id', code.indexOf('"{{aforo-tenant-id}}"') !== -1);
});

section('W6.3 review: cache keys are scoped to the API key', function () {
    const pf = readPolicy('preflight-quota-policy-fragment.xml');
    const mg = readPolicy('margin-guard-policy-fragment.xml');
    const NVK = { 'aforo-api-key': 'sk_live_tenant_b' };
    const pfScope = compile('aforo-preflight-scope', pf, NVK);
    const mgScope = compile('mgScope', mg, NVK);
    const expected = require('crypto').createHash('sha256').update('sk_live_tenant_b').digest('base64').substring(0, 22);
    eq('preflight scope: hash of the Named Value key', run(pfScope, {}), expected);
    eq('margin guard scope: the same hash', run(mgScope, {}), expected);
    check('preflight scope: another key, another scope', run(pfScope, { vars: { 'aforo-api-key': 'sk_live_tenant_a' } }) !== expected);
    check('preflight scope: never the key itself', run(pfScope, {}).indexOf('sk_live') === -1);
    const pfCode = codeOf(pf);
    const pfKey = 'key="@("aforo:pf:" + Convert.ToString(context.Variables["aforo-preflight-scope"]) + ":" + Convert.ToString(context.Variables["aforo-preflight-customer"]))"';
    eq('preflight: lookup and store use the scoped key', pfCode.split(pfKey).length - 1, 2);
    const mgCode = codeOf(mg);
    const mgKey = 'key="@("mg:" + Convert.ToString(context.Variables["mgScope"]) + ":" + Convert.ToString(context.Variables["mgCustomerId"]))"';
    eq('margin guard: lookup and store use the scoped key', mgCode.split(mgKey).length - 1, 2);
    check('margin guard: the JWT tenant claim no longer keys the cache', mgCode.indexOf('tenant_id') === -1 && mgCode.indexOf('mgTenantId') === -1);
});

section('W6.3 review: pre-flight DENY cache window', function () {
    const code = codeOf(readPolicy('preflight-quota-policy-fragment.xml'));
    check('preflight: no retryAfterMs -> 5 s', code.indexOf('long ms = raw != null && raw.Type == JTokenType.Integer ? (long)raw : 5000;') !== -1);
    check('preflight: DENY capped at 60 s', code.indexOf('if (seconds > 60) { seconds = 60; }') !== -1 && code.indexOf('3600') === -1);
});

console.log('\nAzure APIM policy tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
