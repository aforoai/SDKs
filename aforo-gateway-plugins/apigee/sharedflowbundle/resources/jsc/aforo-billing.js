/**
 * Aforo billing rules shared by the aforo-access and aforo-metering shared
 * flows. Loaded with <IncludeURL>jsc://aforo-billing.js</IncludeURL> ahead of
 * each flow's own script.
 *
 * ONE SOURCE, TWO COPIES. Apigee resolves jsc:// inside the bundle, so both
 * bundles carry this file:
 *   sharedflowbundle/resources/jsc/aforo-billing.js               (aforo-metering)
 *   aforo-access/sharedflowbundle/resources/jsc/aforo-billing.js  (aforo-access)
 * They must stay byte-identical; tests/static-check.cjs fails otherwise. The
 * access flow decides which metric a call bills to (for the pre-flight quota
 * check) with exactly the code the metering flow bills it with.
 *
 * The behaviour mirrors the Kong plugin (aforo-gateway-plugins/kong), the
 * proven reference: the same status table, the same MCP rules, the same
 * metric precedence and the same metric_mappings pattern language.
 *
 * Rhino (ES5): no let/const, arrow functions, template strings or classes.
 * Nothing here throws on bad config or a hostile request body.
 */

var AFORO_MAX = {
    customerId: 64, metricName: 255, idempotencyKey: 255, agentId: 36,
    sessionId: 64, productType: 20, traceId: 128, toolName: 64, endpointPath: 512
};
var AFORO_MCP_TOOL_METRIC = 'mcp_server.tool_invocations';
var AFORO_SCHEMA_DEFAULT_METRIC = 'api_calls';
var AFORO_DEFAULT_QUANTITY_HEADER = 'X-Aforo-Quantity';
var AFORO_DEFAULT_TRACE_ID_HEADER = 'X-Aforo-Trace-Id';
var AFORO_AGENT_ID_HEADER = 'X-Aforo-Agent-Id';
var AFORO_SESSION_ID_HEADER = 'X-Aforo-Session-Id';
var AFORO_METRIC_HEADER = 'X-Aforo-Metric';
var AFORO_TRANSIENT_EVENT_ERROR = 'The event could not be stored';
var AFORO_DEFAULT_EXCLUDE_PATHS = ['/health', '/ready', '/metrics'];
var AFORO_DEFAULT_EXCLUDE_STATUS_CODES = [401, 403, 429];
var AFORO_HTTP_METHODS = {
    GET: true, POST: true, PUT: true, PATCH: true, DELETE: true, HEAD: true, OPTIONS: true
};

// ── Flow variables ──────────────────────────────────────────

function aforoTrim(v) {
    return (v === null || v === undefined) ? '' : ('' + v).replace(/^\s+|\s+$/g, '');
}

function aforoStr(name) {
    var v = context.getVariable(name);
    return (v === null || v === undefined) ? '' : ('' + v);
}

// A KVM setting: read into private.aforo.<name> by the access flow.
function aforoCfg(name) {
    return aforoTrim(aforoStr('private.aforo.' + name));
}

function aforoFlag(name, dflt) {
    var v = aforoCfg(name).toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    return dflt;
}

// The request path as the client sent it: proxy base path + path suffix.
// Both flows use this, never request.path, which a TargetEndpoint may rewrite
// before the response flow runs.
function aforoRequestPath() {
    var base = aforoStr('proxy.basepath');
    var suffix = aforoStr('proxy.pathsuffix');
    return ((base === '/' ? '' : base) + suffix) || '/';
}

// ── Text hygiene ────────────────────────────────────────────
// Lengths are UTF-16 code units, as the ingestor's @Size counts them; a
// JavaScript string already is UTF-16, so .length is the count. A lone
// surrogate cannot be encoded as UTF-8 and would make the batch unreadable.

function aforoHasLoneSurrogate(s) {
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) {
            var n = s.charCodeAt(i + 1);
            if (!(n >= 0xDC00 && n <= 0xDFFF)) return true;
            i++;
        } else if (c >= 0xDC00 && c <= 0xDFFF) {
            return true;
        }
    }
    return false;
}

function aforoIsText(s, allowControl) {
    if (!allowControl && /[\u0000-\u001f\u007f]/.test(s)) return false;
    return !aforoHasLoneSurrogate(s);
}

// A header or body value copied into an event: kept only when it is text
// without control characters and at most max characters, else null.
function aforoCleanString(v, max) {
    if (v === null || v === undefined) return null;
    var s = '' + v;
    if (s === '' || s.length > max || !aforoIsText(s, false)) return null;
    return s;
}

// A value that must stay on the event whatever the client sent (the path, an
// MCP tool name): control characters and lone surrogates are percent-encoded,
// then it is cut to max characters without splitting a surrogate pair.
function aforoEscapedString(v, max) {
    if (v === null || v === undefined) return '';
    var s = '' + v;
    var out = '';
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        var piece;
        if (c >= 0xD800 && c <= 0xDBFF && s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) {
            piece = s.substring(i, i + 2);
            i++;
        } else if (c < 0x20 || c === 0x7f || (c >= 0xD800 && c <= 0xDFFF)) {
            piece = '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
        } else {
            piece = s.charAt(i);
        }
        if (out.length + piece.length > max) break;
        out += piece;
    }
    return out;
}

// ── Product configuration (AC2) ─────────────────────────────

function aforoNormalizeProductType(v) {
    var t = aforoTrim(v).toUpperCase();
    return t === '' ? 'API' : t;
}

// The API product's Aforo settings, as AforoAccessReadProductConfig read them
// from the KVM keys <setting>__<apiproduct.name>.
function aforoProductConfig() {
    var raw = {
        type: aforoCfg('product.type'),
        defaultMetric: aforoCfg('product.defaultMetric'),
        metricMappings: aforoCfg('product.metricMappings'),
        agentId: aforoCfg('product.agentId'),
        quantityHeader: aforoCfg('product.quantityHeader'),
        traceIdHeader: aforoCfg('product.traceIdHeader'),
        enforceQuota: aforoCfg('product.enforceQuota'),
        aforoProductId: aforoCfg('product.aforoProductId'),
        statusOutcomes: aforoCfg('product.statusOutcomes')
    };
    return {
        // An API product Aforo has not configured: none of its keys is set.
        configured: raw.type !== '' || raw.defaultMetric !== '' || raw.metricMappings !== '',
        type: aforoNormalizeProductType(raw.type),
        defaultMetric: raw.defaultMetric,
        metricMappings: raw.metricMappings,
        agentId: raw.agentId,
        quantityHeader: raw.quantityHeader || AFORO_DEFAULT_QUANTITY_HEADER,
        traceIdHeader: raw.traceIdHeader || AFORO_DEFAULT_TRACE_ID_HEADER,
        enforceQuota: raw.enforceQuota.toLowerCase() === 'true',
        aforoProductId: raw.aforoProductId,
        statusOutcomes: raw.statusOutcomes
    };
}

// ── metric_mappings: Lua patterns, as in Kong ───────────────
// metric_mappings__<product> is [{pathPattern, method, metricName}], the same
// rules org-service writes into Kong's plugin config. pathPattern is a Lua
// pattern (string.find semantics, unanchored unless it starts with ^), so a
// rule means the same thing on both gateways. It is translated to a
// JavaScript RegExp. Unsupported: %b, %f and back-references (%1-%9); a rule
// using them is skipped with a log line, as Kong skips an invalid pattern.

var AFORO_LUA_CLASSES = {
    a: 'A-Za-z', d: '0-9', l: 'a-z', u: 'A-Z', w: 'A-Za-z0-9', x: '0-9A-Fa-f',
    s: ' \\t\\n\\r\\f\\v', c: '\\x00-\\x1f\\x7f',
    p: '!-\\/:-@\\[-`{-~', g: '!-~'
};

function aforoRegexEscape(ch) {
    return /[\\^$.|?*+()\[\]{}\/\-]/.test(ch) ? '\\' + ch : ch;
}

// %x inside or outside a set. Returns {inner, outer} or null (unsupported).
function aforoLuaClass(ch) {
    var lower = ch.toLowerCase();
    var cls = AFORO_LUA_CLASSES[lower];
    if (cls === undefined) {
        if (/[A-Za-z0-9]/.test(ch)) return null;  // %b %f %1.. and unknown letters
        return { inner: aforoRegexEscape(ch), outer: aforoRegexEscape(ch) };
    }
    if (ch === lower) return { inner: cls, outer: '[' + cls + ']' };
    return { inner: null, outer: '[^' + cls + ']' };  // complement: not inside a set
}

function aforoLuaPatternToRegExp(pattern) {
    if (typeof pattern !== 'string' || pattern === '' || pattern.length > 512) return null;
    var p = pattern;
    var out = '';
    var i = 0;
    if (p.charAt(0) === '^') { out = '^'; i = 1; }
    while (i < p.length) {
        var ch = p.charAt(i);
        var item;
        if (ch === '%') {
            if (i + 1 >= p.length) return null;
            var cls = aforoLuaClass(p.charAt(i + 1));
            if (!cls) return null;
            item = cls.outer;
            i += 2;
        } else if (ch === '[') {
            var j = i + 1;
            var set = '[';
            if (p.charAt(j) === '^') { set += '^'; j++; }
            var first = true;
            var closed = false;
            while (j < p.length) {
                var c = p.charAt(j);
                if (c === ']' && !first) { closed = true; j++; break; }
                if (c === '%') {
                    if (j + 1 >= p.length) return null;
                    var inner = aforoLuaClass(p.charAt(j + 1));
                    if (!inner || inner.inner === null) return null;
                    set += inner.inner;
                    j += 2;
                } else if (c === '-' && !first && p.charAt(j + 1) !== ']' && j + 1 < p.length) {
                    set += '-';
                    j++;
                } else {
                    set += (c === '\\' || c === ']' || c === '[' || c === '^' || c === '-') ? '\\' + c : c;
                    j++;
                }
                first = false;
            }
            if (!closed) return null;
            item = set + ']';
            i = j;
        } else if (ch === '.') {
            item = '[\\s\\S]';
            i++;
        } else if (ch === '$' && i === p.length - 1) {
            out += '$';
            i++;
            continue;
        } else if (ch === '(' || ch === ')') {
            out += ch;  // captures do not change what string.find matches
            i++;
            continue;
        } else {
            item = aforoRegexEscape(ch);
            i++;
        }
        var q = p.charAt(i);
        if (q === '*' || q === '+' || q === '?') { item += q; i++; }
        else if (q === '-') { item += '*?'; i++; }
        out += item;
    }
    try {
        return new RegExp(out);
    } catch (e) {
        return null;
    }
}

function aforoParseMappings(raw) {
    var rules = [];
    if (!raw) return rules;
    var parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        print('[aforo] metric_mappings is not valid JSON; ignored');
        return rules;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.length !== 'number') return rules;
    for (var i = 0; i < parsed.length; i++) {
        var r = parsed[i];
        if (!r || typeof r !== 'object') continue;
        // camelCase per AC2; Kong's snake_case spelling is accepted too.
        var metric = aforoTrim(r.metricName !== undefined ? r.metricName : r.metric_name);
        var pattern = r.pathPattern !== undefined ? r.pathPattern : r.path_pattern;
        if (!metric) continue;
        var re = aforoLuaPatternToRegExp(pattern);
        if (!re) {
            print('[aforo] metric_mappings: pathPattern ' + JSON.stringify(pattern) +
                ' is not a supported Lua pattern; rule skipped');
            continue;
        }
        rules.push({ re: re, method: aforoTrim(r.method).toUpperCase(), metricName: metric });
    }
    return rules;
}

// The metric a request bills to. First match wins:
//   1. the upstream's X-Aforo-Metric RESPONSE header (headerMetric; the
//      access flow cannot know it and passes '')
//   2. metric_mappings__<product>, in order
//   3. mcpFallback (an MCP tool call stops here)
//   4. default_metric__<product>, else api_calls
function aforoResolveMetric(method, path, headerMetric, product, mcpFallback) {
    if (headerMetric) return headerMetric;
    var rules = aforoParseMappings(product.metricMappings);
    var m = ('' + (method || '')).toUpperCase();
    for (var i = 0; i < rules.length; i++) {
        if (rules[i].method && rules[i].method !== m) continue;
        if (rules[i].re.test(path || '')) return rules[i].metricName;
    }
    if (mcpFallback) return mcpFallback;
    return product.defaultMetric || AFORO_SCHEMA_DEFAULT_METRIC;
}

// The metric a tools/call bills to: header, mappings, then on an MCP_SERVER
// product its default_metric (unless it is still api_calls), else
// mcp_server.tool_invocations.
function aforoToolCallMetric(method, path, headerMetric, product) {
    var fallback = AFORO_MCP_TOOL_METRIC;
    if (product.type === 'MCP_SERVER' && product.defaultMetric &&
            product.defaultMetric !== AFORO_SCHEMA_DEFAULT_METRIC) {
        fallback = product.defaultMetric;
    }
    return aforoResolveMetric(method, path, headerMetric, product, fallback);
}

// ── MCP (JSON-RPC 2.0) ──────────────────────────────────────
// null when the body is not JSON-RPC, else
//   { calls: [{toolName, id}], other: <messages that are not tools/call> }
// One entry per tools/call, inside a batch (array) too. The body is the
// client's: every level is type-checked. A tools/call without a usable name
// is still billed, as "unknown". params._meta.agent_id is never read.
function aforoParseJsonRpc(body) {
    if (body === null || body === undefined) return null;
    var text = '' + body;
    if (text === '' || text.length > 1048576) return null;
    var parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    var messages;
    if (typeof parsed.length === 'number') {
        messages = parsed;
    } else if (parsed.jsonrpc !== undefined) {
        messages = [parsed];
    } else {
        return null;
    }
    var calls = [];
    var other = 0;
    var jsonrpc = false;
    for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') continue;
        jsonrpc = true;
        if (msg.method !== 'tools/call') {
            other++;
            continue;
        }
        var params = (msg.params && typeof msg.params === 'object') ? msg.params : {};
        var name = typeof params.name === 'string' ? aforoEscapedString(params.name, AFORO_MAX.toolName) : '';
        var id = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
        calls.push({ toolName: name || 'unknown', id: id });
    }
    if (!jsonrpc) return null;
    return { calls: calls, other: other };
}

// What a request bills: tool-call events, a plain event, both or neither.
// Decided once (by the access flow) for both flows, so the pre-flight check
// asks about exactly the events the metering flow creates.
//   MCP_SERVER: one event per tools/call, never a plain event; initialize,
//     tools/list, ping and notifications are protocol traffic, never billed
//     and never refused.
//   everything else: one plain event per request.
function aforoBillable(productType, jsonrpc) {
    if (productType === 'MCP_SERVER') {
        return { tools: !!(jsonrpc && jsonrpc.calls.length > 0), plain: false };
    }
    return { tools: false, plain: true };
}

// ── Exclusions ──────────────────────────────────────────────

function aforoSplitCsv(raw) {
    var out = [];
    var parts = ('' + (raw || '')).split(',');
    for (var i = 0; i < parts.length; i++) {
        var e = aforoTrim(parts[i]);
        if (e) out.push(e);
    }
    return out;
}

// KVM exclude_paths: CSV; absent -> /health,/ready,/metrics; "none" -> nothing.
function aforoExcludePaths(raw) {
    var e = aforoSplitCsv(raw);
    if (e.length === 0) return AFORO_DEFAULT_EXCLUDE_PATHS;
    if (e.length === 1 && e[0].toLowerCase() === 'none') return [];
    return e;
}

// KVM exclude_status_codes: CSV; absent -> 401,403,429; "none" -> nothing.
function aforoExcludeStatusCodes(raw) {
    var e = aforoSplitCsv(raw);
    if (e.length === 0) return AFORO_DEFAULT_EXCLUDE_STATUS_CODES;
    if (e.length === 1 && e[0].toLowerCase() === 'none') return [];
    var codes = [];
    for (var i = 0; i < e.length; i++) {
        if (/^\d{3}$/.test(e[i])) codes.push(parseInt(e[i], 10));
    }
    return codes;
}

// An entry matches the path itself and the paths below it: "/health" excludes
// "/health" and "/health/live", not "/healthcare".
function aforoIsExcludedPath(path, entries) {
    if (typeof path !== 'string') return false;
    for (var i = 0; i < entries.length; i++) {
        var x = entries[i];
        if (!x) continue;
        if (path === x) return true;
        if (path.indexOf(x) === 0 &&
                (x.charAt(x.length - 1) === '/' || path.charAt(x.length) === '/')) return true;
    }
    return false;
}

// The request is excluded when its full path (base path + suffix) or its
// path suffix matches: "/health" excludes "/payments/health" too, since every
// Apigee proxy has a base path.
function aforoIsExcludedRequest(entries) {
    return aforoIsExcludedPath(aforoRequestPath(), entries) ||
        aforoIsExcludedPath(aforoStr('proxy.pathsuffix') || '/', entries);
}

// A CORS preflight is a browser protocol detail, never a billable call.
function aforoIsCorsPreflight(method) {
    return method === 'OPTIONS' && aforoStr('request.header.Access-Control-Request-Method') !== '';
}

// ── executionStatus (shared status table) ───────────────────
// 2xx/3xx SUCCESS, 408/504 TIMEOUT, 499 CANCELLED, 400/422 VALIDATION_FAILED,
// 401/403/429 BLOCKED, every other 4xx/5xx ERROR, anything else: omitted.
// status_outcomes__<product> overrides exact codes: a JSON object
// {"404":"VALIDATION_FAILED"} (or the older CSV "404=VALIDATION_FAILED").
var AFORO_OUTCOMES = {
    SUCCESS: true, PARTIAL: true, TIMEOUT: true, ERROR: true, VALIDATION_FAILED: true,
    FAILED: true, FAILURE: true, CANCELLED: true, PENDING: true, BLOCKED: true, HITL_REQUIRED: true
};

function aforoParseStatusOutcomes(raw) {
    var map = {};
    var text = aforoTrim(raw);
    if (!text) return map;
    var pairs = [];
    if (text.charAt(0) === '{') {
        try {
            var obj = JSON.parse(text);
            for (var k in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, k)) pairs.push([k, obj[k]]);
            }
        } catch (e) {
            print('[aforo] status_outcomes is not valid JSON; ignored');
        }
    } else {
        var parts = text.split(',');
        for (var i = 0; i < parts.length; i++) {
            var eq = parts[i].indexOf('=');
            if (eq > 0) pairs.push([parts[i].substring(0, eq), parts[i].substring(eq + 1)]);
        }
    }
    for (var j = 0; j < pairs.length; j++) {
        var code = aforoTrim(pairs[j][0]);
        var outcome = aforoTrim(pairs[j][1]).toUpperCase();
        if (/^[2-5]\d\d$/.test(code) && AFORO_OUTCOMES[outcome] === true) map[code] = outcome;
    }
    return map;
}

function aforoOutcomeFromStatus(status, overrides) {
    var s = Number(status);
    if (!isFinite(s) || s < 200 || s > 599) return null;
    s = Math.floor(s);
    var o = overrides && overrides[String(s)];
    if (o) return o;
    if (s < 400) return 'SUCCESS';
    if (s === 408 || s === 504) return 'TIMEOUT';
    if (s === 499) return 'CANCELLED';
    if (s === 400 || s === 422) return 'VALIDATION_FAILED';
    if (s === 401 || s === 403 || s === 429) return 'BLOCKED';
    return 'ERROR';
}
