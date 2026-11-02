'use strict';
/**
 * Unit tests of aforo-billing.js, the rules both shared flows share: the
 * metric_mappings pattern language (Lua patterns, as Kong), metric
 * precedence, JSON-RPC parsing, exclusions, the status table and text
 * hygiene. Each test evaluates the library in a fresh sandbox with a mock
 * Apigee `context`.
 *
 * Run: node apigee/tests/unit-tests.cjs   (from aforo-gateway-plugins/)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { test, section, report } = require('./lib/harness.cjs');

const LIB = fs.readFileSync(path.resolve(__dirname, '../sharedflowbundle/resources/jsc/aforo-billing.js'), 'utf8');

function lib(vars) {
    const store = Object.assign({}, vars);
    const prints = [];
    const sandbox = {
        context: { getVariable: (n) => (n in store ? store[n] : null), setVariable: (n, v) => { store[n] = v; } },
        print: (s) => prints.push(s)
    };
    vm.createContext(sandbox);
    vm.runInContext(LIB, sandbox);
    sandbox.prints = prints;
    return sandbox;
}

function product(over) {
    return Object.assign({ type: 'API', defaultMetric: '', metricMappings: '' }, over);
}

// ─────────────────────────────────────────────────────────────────────────
section('metric_mappings: Lua patterns');

test('anchored literal prefix', () => {
    const L = lib();
    const re = L.aforoLuaPatternToRegExp('^/v1/sms');
    assert.ok(re.test('/v1/sms/send'));
    assert.ok(!re.test('/api/v1/sms'));
});

test('unanchored pattern matches anywhere (string.find)', () => {
    const re = lib().aforoLuaPatternToRegExp('/calls/');
    assert.ok(re.test('/api/v2/calls/123'));
});

test('character classes, quantifiers and the $ anchor', () => {
    const re = lib().aforoLuaPatternToRegExp('^/users/%d+$');
    assert.ok(re.test('/users/42'));
    assert.ok(!re.test('/users/42/x'));
    assert.ok(!re.test('/users/abc'));
    assert.ok(lib().aforoLuaPatternToRegExp('^/v%d/[%w_]+$').test('/v2/get_user'));
});

test('% escapes magic characters; - is the lazy quantifier, as in Lua', () => {
    const L = lib();
    assert.ok(L.aforoLuaPatternToRegExp('^/a%.b').test('/a.b'));
    assert.ok(!L.aforoLuaPatternToRegExp('^/a%.b').test('/axb'));
    assert.ok(L.aforoLuaPatternToRegExp('^/v1%-beta').test('/v1-beta'));
    // Lua: "1-" is zero-or-more "1", so "/v1-beta" does NOT match the path "/v1-beta".
    assert.ok(!L.aforoLuaPatternToRegExp('^/v1-beta$').test('/v1-beta'));
    assert.ok(L.aforoLuaPatternToRegExp('^/v1-beta$').test('/vbeta'));
});

test('. matches any character; regex-only syntax is literal', () => {
    const L = lib();
    assert.ok(L.aforoLuaPatternToRegExp('^/a.c$').test('/abc'));
    assert.ok(L.aforoLuaPatternToRegExp('^/x{2}$').test('/x{2}'));
    assert.ok(L.aforoLuaPatternToRegExp('^/a|b$').test('/a|b'));
});

test('unsupported (%b, %f, back-references) or malformed patterns are rejected', () => {
    const L = lib();
    assert.strictEqual(L.aforoLuaPatternToRegExp('%b()'), null);
    assert.strictEqual(L.aforoLuaPatternToRegExp('%f[%w]x'), null);
    assert.strictEqual(L.aforoLuaPatternToRegExp('(a)%1'), null);
    assert.strictEqual(L.aforoLuaPatternToRegExp('[abc'), null);
    assert.strictEqual(L.aforoLuaPatternToRegExp('abc%'), null);
    assert.strictEqual(L.aforoLuaPatternToRegExp(''), null);
});

// ─────────────────────────────────────────────────────────────────────────
section('Metric precedence');

const MAPPINGS = JSON.stringify([
    { pathPattern: '^/p/v1/sms', method: 'POST', metricName: 'sms_sent' },
    { pathPattern: '^/p/v1/sms', metricName: 'sms_other' },
    { pathPattern: '%b()', metricName: 'never' },
    { path_pattern: '^/p/legacy', metric_name: 'legacy_metric' }
]);

test('header metric > mappings (method-aware, in order) > default_metric > api_calls', () => {
    const L = lib();
    const p = product({ metricMappings: MAPPINGS, defaultMetric: 'calls' });
    assert.strictEqual(L.aforoResolveMetric('POST', '/p/v1/sms/x', 'hdr', p, ''), 'hdr');
    assert.strictEqual(L.aforoResolveMetric('POST', '/p/v1/sms/x', '', p, ''), 'sms_sent');
    assert.strictEqual(L.aforoResolveMetric('get', '/p/v1/sms/x', '', p, ''), 'sms_other');
    assert.strictEqual(L.aforoResolveMetric('GET', '/p/legacy/1', '', p, ''), 'legacy_metric', "Kong's snake_case accepted");
    assert.strictEqual(L.aforoResolveMetric('GET', '/p/other', '', p, ''), 'calls');
    assert.strictEqual(L.aforoResolveMetric('GET', '/p/other', '', product(), ''), 'api_calls');
    assert.ok(L.prints.some((s) => s.includes('not a supported Lua pattern')));
});

test('invalid metric_mappings JSON is ignored with a log line', () => {
    const L = lib();
    assert.strictEqual(L.aforoResolveMetric('GET', '/x', '', product({ metricMappings: '[{', defaultMetric: 'd' }), ''), 'd');
    assert.ok(L.prints.length > 0);
});

test('tool-call metric: mappings, then the MCP product default_metric, else mcp_server.tool_invocations', () => {
    const L = lib();
    assert.strictEqual(L.aforoToolCallMetric('POST', '/mcp', '', product({ type: 'MCP_SERVER', defaultMetric: 'tool_calls' })), 'tool_calls');
    assert.strictEqual(L.aforoToolCallMetric('POST', '/mcp', '', product({ type: 'MCP_SERVER', defaultMetric: 'api_calls' })), 'mcp_server.tool_invocations');
    assert.strictEqual(L.aforoToolCallMetric('POST', '/mcp', '', product({ type: 'MCP_SERVER' })), 'mcp_server.tool_invocations');
});

// ─────────────────────────────────────────────────────────────────────────
section('JSON-RPC');

test('single tools/call, batch, non-tool messages, hostile bodies', () => {
    const L = lib();
    const one = L.aforoParseJsonRpc('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"search"}}');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(one)), { calls: [{ toolName: 'search', id: 7 }], other: 0 });
    const batch = L.aforoParseJsonRpc('[{"jsonrpc":"2.0","method":"tools/call","params":{"name":"a"}},{"jsonrpc":"2.0","method":"ping"},{"jsonrpc":"2.0","method":"tools/call","params":null}]');
    assert.deepStrictEqual(Array.from(batch.calls, (c) => c.toolName), ['a', 'unknown']);
    assert.strictEqual(batch.other, 1);
    assert.strictEqual(L.aforoParseJsonRpc('1'), null);
    assert.strictEqual(L.aforoParseJsonRpc('{"jsonrpc":"1.0","method":"tools/call"}'), null);
    assert.strictEqual(L.aforoParseJsonRpc('{"method":"tools/call"}'), null);
    assert.strictEqual(L.aforoParseJsonRpc('not json'), null);
    assert.strictEqual(L.aforoParseJsonRpc(null), null);
});

test('tool names: control characters escaped, cut to 64 characters', () => {
    const L = lib();
    const r = L.aforoParseJsonRpc(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'a\nb' + 'x'.repeat(100) } }));
    assert.strictEqual(r.calls[0].toolName.indexOf('a%0Ab'), 0);
    assert.strictEqual(r.calls[0].toolName.length, 64);
});

test('billable: MCP_SERVER bills tools/call only; other types one plain event', () => {
    const L = lib();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(L.aforoBillable('MCP_SERVER', { calls: [{}], other: 0 }))), { tools: true, plain: false });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(L.aforoBillable('MCP_SERVER', { calls: [], other: 2 }))), { tools: false, plain: false });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(L.aforoBillable('MCP_SERVER', null))), { tools: false, plain: false });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(L.aforoBillable('API', null))), { tools: false, plain: true });
});

// ─────────────────────────────────────────────────────────────────────────
section('Exclusions and status table');

test('exclude_paths: segment boundaries, defaults, "none"', () => {
    const L = lib();
    const d = L.aforoExcludePaths('');
    assert.ok(L.aforoIsExcludedPath('/health', d));
    assert.ok(L.aforoIsExcludedPath('/health/live', d));
    assert.ok(!L.aforoIsExcludedPath('/healthcare/x', d));
    assert.strictEqual(L.aforoExcludePaths('none').length, 0);
    assert.deepStrictEqual(Array.from(L.aforoExcludeStatusCodes('')), [401, 403, 429]);
    assert.deepStrictEqual(Array.from(L.aforoExcludeStatusCodes('404, x, 500')), [404, 500]);
});

test('exclusion checks the full path and the proxy path suffix', () => {
    const d = lib().aforoExcludePaths('');
    assert.ok(lib({ 'proxy.basepath': '/pay', 'proxy.pathsuffix': '/health' }).aforoIsExcludedRequest(d));
    assert.ok(!lib({ 'proxy.basepath': '/pay', 'proxy.pathsuffix': '/healthcare' }).aforoIsExcludedRequest(d));
    assert.ok(lib({ 'proxy.basepath': '/', 'proxy.pathsuffix': '/metrics/x' }).aforoIsExcludedRequest(d));
});

test('status table, as every Aforo gateway plugin', () => {
    const L = lib();
    const table = { 200: 'SUCCESS', 302: 'SUCCESS', 400: 'VALIDATION_FAILED', 422: 'VALIDATION_FAILED', 401: 'BLOCKED',
        403: 'BLOCKED', 429: 'BLOCKED', 404: 'ERROR', 408: 'TIMEOUT', 504: 'TIMEOUT', 499: 'CANCELLED', 500: 'ERROR' };
    for (const [code, outcome] of Object.entries(table)) assert.strictEqual(L.aforoOutcomeFromStatus(code, {}), outcome, code);
    assert.strictEqual(L.aforoOutcomeFromStatus(0, {}), null);
    assert.strictEqual(L.aforoOutcomeFromStatus(101, {}), null);
});

test('status_outcomes: JSON object (AC2) or the older CSV; invalid entries ignored', () => {
    const L = lib();
    const j = L.aforoParseStatusOutcomes('{"404":"validation_failed","200":"nope","999":"ERROR"}');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(j)), { 404: 'VALIDATION_FAILED' });
    const c = L.aforoParseStatusOutcomes('429=ERROR, 404=PARTIAL');
    assert.strictEqual(L.aforoOutcomeFromStatus(429, c), 'ERROR');
    assert.strictEqual(L.aforoOutcomeFromStatus(404, c), 'PARTIAL');
});

// ─────────────────────────────────────────────────────────────────────────
section('Text hygiene and config');

test('clean strings: control characters, lone surrogates and over-long values are refused', () => {
    const L = lib();
    assert.strictEqual(L.aforoCleanString('ok', 10), 'ok');
    assert.strictEqual(L.aforoCleanString('café', 10), 'café');
    assert.strictEqual(L.aforoCleanString('a\tb', 10), null);
    assert.strictEqual(L.aforoCleanString('\ud800x', 10), null);
    assert.strictEqual(L.aforoCleanString('x'.repeat(11), 10), null);
    assert.strictEqual(L.aforoCleanString('', 10), null);
});

test('escaped strings never split a surrogate pair', () => {
    const L = lib();
    assert.strictEqual(L.aforoEscapedString('ab😀', 3), 'ab');
    assert.strictEqual(L.aforoEscapedString('ab😀', 4), 'ab😀');
});

test('product config: defaults, "configured" only when Aforo set something', () => {
    let L = lib({});
    let p = L.aforoProductConfig();
    assert.strictEqual(p.configured, false);
    assert.strictEqual(p.type, 'API');
    assert.strictEqual(p.quantityHeader, 'X-Aforo-Quantity');
    assert.strictEqual(p.traceIdHeader, 'X-Aforo-Trace-Id');
    L = lib({ 'private.aforo.product.type': ' mcp_server ', 'private.aforo.product.enforceQuota': 'TRUE' });
    p = L.aforoProductConfig();
    assert.strictEqual(p.configured, true);
    assert.strictEqual(p.type, 'MCP_SERVER');
    assert.strictEqual(p.enforceQuota, true);
});

test('request path: base path + suffix, "/" base path, empty -> "/"', () => {
    assert.strictEqual(lib({ 'proxy.basepath': '/pay', 'proxy.pathsuffix': '/v1' }).aforoRequestPath(), '/pay/v1');
    assert.strictEqual(lib({ 'proxy.basepath': '/', 'proxy.pathsuffix': '/v1' }).aforoRequestPath(), '/v1');
    assert.strictEqual(lib({}).aforoRequestPath(), '/');
});

report('apigee unit tests');
