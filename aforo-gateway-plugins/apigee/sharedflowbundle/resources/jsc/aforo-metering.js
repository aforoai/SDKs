/**
 * Aforo Metering — Apigee JavaScript Policy
 *
 * Runs on the response path (PostProxyFlowHook). Builds ONE usage event from
 * the request/response context and stores the JSON payload in
 * 'aforo.eventPayload' for the ServiceCallout policies to send. The payload
 * is built once; the retry re-sends the same variable.
 *
 * Supports:
 * - Standard API metering (metric from KVM mappings / pattern / default metric)
 * - MCP JSON-RPC tools/call detection
 * - AGENTIC_API detection (traceparent/x-trace-id → productType + traceId)
 * - W3C Trace Context capture (traceparent, tracestate, x-trace-id, x-request-id)
 * - Exclusions: status codes (default 401,403,429) and path prefixes
 *   (default /health,/ready,/metrics) produce no event
 * - executionStatus from the response status (KVM status_outcomes overrides)
 *
 * Config: KVM entries read by AforoMeteringReadConfig into private.aforo.*
 * (Apigee X only allows KVM values in private.* variables). Each setting is
 * also read from the non-private aforo.* name when the private one is unset,
 * so a proxy can override it with an AssignMessage.
 *   metricMappings     JSON array [{matchType, value, metricName}],
 *                      EXACT | PREFIX | CONTAINS, first match wins
 *   metricNamePattern  "{method} {path}" template, used when no mapping matches
 *   defaultMetric      used when neither applies (default api_calls)
 *   customerIdSource   "consumer" (default) or "flow_variable:<name>"
 *   excludePaths / excludeStatusCodes / statusOutcomes
 *   quantitySource     "1" (default) or "response_size"
 *   includeMetadata    "false" omits metadata on standard events
 *   mcpEnabled / mcpProductId
 *   productType        productType on every event (KVM product_type, default
 *                      API; trimmed + upper-cased)
 *
 * Output flow variables:
 *   aforo.eventPayload         the JSON batch (set only when an event exists)
 *   aforo.meteringSend         "true" when there is an event to send
 *   aforo.meteringSendStartMs  when the send starts (read by the retry gate)
 *   aforo.skip                 "true" when no event was built
 *   aforo.skipReason           why ("" when an event was built)
 *   aforo.sendEvent            same as aforo.meteringSend (2.1.0 name)
 *
 * Rhino-safe (ES5). Never throws on malformed config.
 */

var MAX_CUSTOMER_ID_LENGTH = 64;
var MAX_METRIC_NAME_LENGTH = 255;
var MAX_TOOL_NAME_LENGTH = 64;

// Fields each productType must carry. The ingestor rejects an event missing
// them, so such events are skipped here. gRPC / GraphQL / WebSocket / MQTT
// fields are not observable in this shared flow, so those types always skip.
// Unknown types pass unchecked.
var PRODUCT_TYPE_REQUIRED_FIELDS = {
    API: [],
    AGENTIC_API: [],
    AI_AGENT: ['agentId', 'sessionId'],
    MCP_SERVER: ['toolName', 'agentId'],
    GRPC_API: ['grpcService', 'grpcMethod'],
    GRAPHQL_API: ['gqlOperationType'],
    WEBSOCKET_API: ['wsConnectionId'],
    MQTT_BROKER: ['mqttTopic']
};

function trimStr(v) {
    return (v === null || v === undefined) ? '' : ('' + v).replace(/^\s+|\s+$/g, '');
}

function str(name) {
    var v = context.getVariable(name);
    return (v === null || v === undefined) ? '' : ('' + v);
}

// A setting: private.aforo.<name> (KVM), else aforo.<name> (set by the proxy).
function cfg(name) {
    var v = str('private.aforo.' + name);
    return v !== '' ? v : str('aforo.' + name);
}

// ── Metric name ──
// Precedence: first matching KVM metric_mappings rule -> KVM
// metric_name_pattern (when set) -> KVM default_metric -> "api_calls".
// A rule is matched against the full path (proxy base path + path suffix).
// Pattern placeholders: {method}, {path} (full path), {basepath},
// {pathsuffix}. The ingestor rejects an event whose metric
// name is not in the catalog; this script cannot know the catalog.
function parseMappings(raw) {
    if (!raw) return [];
    try {
        var rules = JSON.parse(raw);
        return (rules && rules.length !== undefined && typeof rules !== 'string') ? rules : [];
    } catch (e) {
        print('[aforo-metering] WARN metric_mappings is not valid JSON; ignored');
        return [];
    }
}

function mappingMatches(candidate, rule) {
    if (!candidate || !rule || typeof rule.value !== 'string' || rule.value === '' ||
            typeof rule.metricName !== 'string') return false;
    var kind = trimStr(rule.matchType).toUpperCase() || 'EXACT';
    if (kind === 'EXACT') return candidate === rule.value;
    if (kind === 'PREFIX') return candidate.indexOf(rule.value) === 0;
    if (kind === 'CONTAINS') return candidate.indexOf(rule.value) !== -1;
    return false;
}

function resolveMetricName(httpMethod, fullPath, basePath, suffixPath) {
    var rules = parseMappings(cfg('metricMappings'));
    for (var i = 0; i < rules.length; i++) {
        if (mappingMatches(fullPath, rules[i])) {
            return trimStr(rules[i].metricName);
        }
    }
    var pattern = trimStr(cfg('metricNamePattern'));
    if (pattern) {
        return trimStr(pattern.replace('{method}', httpMethod)
            .replace('{pathsuffix}', suffixPath)
            .replace('{basepath}', basePath)
            .replace('{path}', fullPath));
    }
    return trimStr(cfg('defaultMetric')) || 'api_calls';
}

// ── Customer identity ──
// Never a credential and never a client-controlled value. Sources:
//  1. aforo.customer_id: the customer_id claim VerifyJWT extracted from a
//     signature-checked Aforo JWT (set only when JWT validation ran).
//  2. By KVM customer_id_source:
//     "flow_variable:<name>"  a flow variable the admin knows a verified
//        policy populates (for example a developer-app custom attribute
//        read after VerifyAPIKey). Refused: request/message/response
//        variables (client-controlled), client IPs, and variables that
//        hold a key or secret (consumer key, client_id, client_secret,
//        apikey, access_token).
//     "jwt"  nothing beyond source 1.
//     "consumer", absent or anything else: developer.app.name, then
//        developer.email, as VerifyAPIKey / OAuthV2 resolved them for the
//        verified caller. The value must be an Aforo customer id; the
//        ingestor rejects an event for a customer it does not know.
// No identity -> no event.
var CLIENT_CONTROLLED_VAR = /^(request|message|response)\.|client\.ip$|client\.host$/i;
var SECRET_VAR_LAST_SEGMENT = /^(consumer_?key|client_?id|client_?secret|api_?key|access_?token|refresh_?token|password|secret|authorization)$/i;

function isUnsafeIdentityVar(name) {
    if (CLIENT_CONTROLLED_VAR.test(name)) return true;
    var segments = name.split('.');
    return SECRET_VAR_LAST_SEGMENT.test(segments[segments.length - 1]);
}

function resolveCustomerId() {
    var fromJwt = trimStr(str('aforo.customer_id'));
    if (fromJwt) return fromJwt;
    var source = trimStr(cfg('customerIdSource'));
    var prefix = 'flow_variable:';
    if (source.toLowerCase().indexOf(prefix) === 0) {
        var varName = trimStr(source.substring(prefix.length));
        if (varName && !isUnsafeIdentityVar(varName)) return trimStr(str(varName));
        print('[aforo-metering] WARN customer_id_source names a client-controlled or secret variable; ignored');
        return '';
    }
    if (source.toLowerCase() === 'jwt') return '';
    return trimStr(str('developer.app.name')) || trimStr(str('developer.email'));
}

var method = str('request.verb') || 'UNKNOWN';
// path = proxy base path + path suffix (the same value with a "/" base
// path). The base path matters: one flow hook covers every proxy in the
// environment, and the suffix alone does not tell them apart.
var pathSuffix = str('proxy.pathsuffix');
var basepath = str('proxy.basepath');
var path = ((basepath === '/' ? '' : basepath) + pathSuffix) || '/';
var statusCode = parseInt(str('response.status.code') || '0', 10);
var latency = parseInt(str('target.latency') || '0', 10);
var requestId = str('messageid');
var customerId = resolveCustomerId();
var mcpEnabled = cfg('mcpEnabled') === 'true';
var mcpProductId = cfg('mcpProductId');
var includeMetadata = cfg('includeMetadata') !== 'false';
var configuredProductType = trimStr(cfg('productType')).toUpperCase() || 'API';

// ── Exclusions (requests that are NOT metered at all) ──
// Same behaviour as Kong (`exclude_status_codes` / `exclude_paths`) and
// AWS Lambda (`EXCLUDE_STATUS_CODES`): an excluded request produces NO
// event and NO outbound call. This script sets 'aforo.skip' and leaves
// 'aforo.eventPayload' unset; sharedflows/default.xml gates the send and
// retry steps on it.
//   KVM `exclude_status_codes` — CSV of HTTP codes. Absent or blank ->
//     the default 401,403,429. A value replaces the default. "none"
//     excludes nothing (a KVM entry can't be stored empty). Entries that
//     aren't whole numbers 100-599 are ignored.
//   KVM `exclude_paths` — CSV of path prefixes. Absent or blank -> the
//     default /health,/ready,/metrics (Kong's default). A value replaces
//     the default; "none" excludes nothing. A path is excluded when it
//     equals an entry or starts with it (Kong / AWS Lambda matching),
//     checked against the proxy path suffix, base path + suffix, and
//     the full request path.
// Rhino-safe (ES5). Never throws on malformed config.
var DEFAULT_EXCLUDE_STATUS_CODES = [401, 403, 429];
var DEFAULT_EXCLUDE_PATHS = ['/health', '/ready', '/metrics'];

function splitCsv(raw) {
    var out = [];
    if (raw === null || raw === undefined) return out;
    var parts = ('' + raw).split(',');
    for (var i = 0; i < parts.length; i++) {
        var entry = parts[i].replace(/^\s+|\s+$/g, '');
        if (entry.length > 0) out.push(entry);
    }
    return out;
}

function isExcludeNothing(entries) {
    return entries.length === 1 && entries[0].toLowerCase() === 'none';
}

function parseExcludeStatusCodes(raw) {
    var entries = splitCsv(raw);
    if (entries.length === 0) return DEFAULT_EXCLUDE_STATUS_CODES;
    if (isExcludeNothing(entries)) return [];
    var codes = [];
    for (var i = 0; i < entries.length; i++) {
        if (!/^\d{3}$/.test(entries[i])) continue;
        var n = parseInt(entries[i], 10);
        if (n >= 100 && n <= 599) codes.push(n);
    }
    return codes;
}

function parseExcludePaths(raw) {
    var entries = splitCsv(raw);
    if (entries.length === 0) return DEFAULT_EXCLUDE_PATHS;
    if (isExcludeNothing(entries)) return [];
    return entries;
}

function isExcludedStatus(status, codes) {
    for (var i = 0; i < codes.length; i++) {
        if (status === codes[i]) return true;
    }
    return false;
}

function isExcludedPath(candidate, prefixes) {
    if (!candidate) return false;
    var c = '' + candidate;
    for (var i = 0; i < prefixes.length; i++) {
        if (c === prefixes[i] || c.indexOf(prefixes[i]) === 0) return true;
    }
    return false;
}

var excludeStatusCodes = parseExcludeStatusCodes(cfg('excludeStatusCodes'));
var excludePaths = parseExcludePaths(cfg('excludePaths'));

// ── Skip decision (no event, no outbound call) ──
var skipReason = '';
if (method === 'OPTIONS') {
    // CORS preflight: not a billable call.
    skipReason = 'OPTIONS';
} else if (isExcludedStatus(statusCode, excludeStatusCodes)) {
    skipReason = 'excluded status code';
} else if (isExcludedPath(path, excludePaths) || isExcludedPath(pathSuffix, excludePaths) ||
        isExcludedPath(context.getVariable('request.path'), excludePaths)) {
    skipReason = 'excluded path';
} else if (!customerId) {
    skipReason = 'no customerId';
} else if (customerId.length > MAX_CUSTOMER_ID_LENGTH) {
    skipReason = 'customerId longer than 64 characters';
}

// ── Outcome classification (OUTCOME_BASED pricing) ──
// Maps the upstream HTTP status to the server's executionStatus value
// space. OUTCOME_BASED rate plans bill each event at a per-status weight;
// every other pricing model ignores the field. Shared rule — identical in
// all five gateway plugins (README "Execution status mapping"). Default
// table (policy locked 2026-09-30):
//   2xx/3xx -> SUCCESS, 408/504 -> TIMEOUT, 499 -> CANCELLED,
//   400/422 -> VALIDATION_FAILED, 401/403/429 -> BLOCKED,
//   every other 4xx and 5xx (404 included) -> ERROR,
//   unknown / 0 / missing / non-numeric / 1xx / out of range -> null.
// Overrides come from the KVM key `status_outcomes`
// ("404=VALIDATION_FAILED,429=ERROR"); exact codes 200-599 win over the
// default, invalid entries are ignored.
// A null result means "omit the field" — never send null or ''.
// Rhino-safe (ES5, function declarations).
var OUTCOME_STATUSES = {
    SUCCESS: true, PARTIAL: true, TIMEOUT: true, ERROR: true,
    VALIDATION_FAILED: true, FAILED: true, FAILURE: true, CANCELLED: true,
    PENDING: true, BLOCKED: true, HITL_REQUIRED: true
};

function parseStatusOutcomes(raw) {
    var map = {};
    if (!raw) return map;
    var parts = ('' + raw).split(',');
    for (var i = 0; i < parts.length; i++) {
        var entry = parts[i].replace(/^\s+|\s+$/g, '');
        var eq = entry.indexOf('=');
        if (eq <= 0) continue;
        var code = entry.substring(0, eq).replace(/^\s+|\s+$/g, '');
        var outcome = entry.substring(eq + 1).replace(/^\s+|\s+$/g, '').toUpperCase();
        if (/^[2-5]\d\d$/.test(code) && OUTCOME_STATUSES[outcome] === true) {
            map[code] = outcome;
        }
    }
    return map;
}

var statusOutcomes = parseStatusOutcomes(cfg('statusOutcomes'));

function outcomeFromStatus(status, overrides) {
    var s = Number(status);
    if (!isFinite(s) || s < 200 || s > 599) return null;
    s = Math.floor(s);
    var o = overrides && overrides[String(s)];
    if (typeof o === 'string' && OUTCOME_STATUSES[o.toUpperCase()] === true) {
        return o.toUpperCase();
    }
    if (s < 400) return 'SUCCESS';
    if (s === 408 || s === 504) return 'TIMEOUT';
    if (s === 499) return 'CANCELLED';
    if (s === 400 || s === 422) return 'VALIDATION_FAILED';
    if (s === 401 || s === 403 || s === 429) return 'BLOCKED';
    return 'ERROR';
}

// JSON-RPC 2.0 error inside a 2xx response: the transport succeeded but
// the tool call failed. Apigee holds the (non-streamed) response in
// 'response.content' on the response path, so this reads an existing flow
// variable — no extra buffering. With response streaming enabled the
// variable is empty and this returns false (status-only classification).
function isJsonRpcErrorResponse(body) {
    if (!body || ('' + body).indexOf('"error"') === -1) return false;
    try {
        var rpc = JSON.parse(body);
        return !!(rpc && rpc.jsonrpc === '2.0' && rpc.error &&
                  typeof rpc.error === 'object');
    } catch (e) {
        return false;  // non-JSON body — fall back to status-only
    }
}

// ── W3C Trace Context ──
var trace = {
    traceparent: context.getVariable('request.header.traceparent') || null,
    tracestate: context.getVariable('request.header.tracestate') || null,
    xTraceId: context.getVariable('request.header.x-trace-id') || null,
    xRequestId: context.getVariable('request.header.x-request-id') || null
};

// ── AGENTIC_API Detection ──
// Per descriptor eventSchema.inferenceRule = HAS_TRACE (agentic_api.json),
// an event with a resolvable trace id is classified as AGENTIC_API.
// Preferred source is the W3C traceparent header (parsed for its 32-hex
// trace_id field); fallback is x-trace-id for non-OTel callers per
// descriptor tracing.allowFallback = true. MCP JSON-RPC still wins the
// productType when both signals are present — the MCP branch below runs
// first and this variable is only consulted in the else branch.
// Malformed traceparent → fall through to x-trace-id → fall through to
// null (standard API). Never invent a productType from an unparseable
// header.
var agenticTraceId = null;
if (trace.traceparent) {
    // W3C format: version-trace_id-parent_id-flags (hex widths 2-32-16-2).
    // Invalid per spec: version=="ff", trace_id all zeros, parent_id all zeros.
    var tpParts = ('' + trace.traceparent).split('-');
    if (tpParts.length === 4 &&
        /^[0-9a-f]{2}$/i.test(tpParts[0]) && tpParts[0].toLowerCase() !== 'ff' &&
        /^[0-9a-f]{32}$/i.test(tpParts[1]) && !/^0+$/.test(tpParts[1]) &&
        /^[0-9a-f]{16}$/i.test(tpParts[2]) && !/^0+$/.test(tpParts[2]) &&
        /^[0-9a-f]{2}$/i.test(tpParts[3])) {
        agenticTraceId = tpParts[1].toLowerCase();
    }
}
if (!agenticTraceId && trace.xTraceId) {
    // Non-OTel fallback. Descriptor types trace_id as String, not UUID —
    // no shape check beyond non-empty after trim.
    var xt = ('' + trace.xTraceId).replace(/^\s+|\s+$/g, '');
    if (xt.length > 0) {
        agenticTraceId = xt;
    }
}

// ── MCP Detection ──
var isMcpToolCall = false;
var toolName = '';
var agentId = '';
var sessionId = str('request.header.Mcp-Session-Id');

if (!skipReason && mcpEnabled && method === 'POST') {
    try {
        var reqBody = context.getVariable('request.content');
        if (reqBody && ('' + reqBody).indexOf('tools/call') > -1) {
            var parsed = JSON.parse(reqBody);
            if (parsed.jsonrpc === '2.0' && parsed.method === 'tools/call') {
                isMcpToolCall = true;
                var params = parsed.params || {};
                toolName = params.name || 'unknown';
                if (params._meta && params._meta.agent_id) {
                    agentId = params._meta.agent_id;
                }
            }
        }
    } catch (e) {
        // Not a JSON body — treat as standard request
    }
}

// ── Idempotency key (FROZEN — computed exactly once per transaction) ──
// Dedup-safety basis (A+ delivery-guarantee prompt 4): this script runs
// once per transaction and materializes the payload into the flow
// variable 'aforo.eventPayload'. Every delivery attempt (the primary
// ServiceCallout and its bounded retry steps) re-sends that same frozen
// variable, so all attempts carry a byte-identical idempotencyKey and
// the ingestor dedups redelivery instead of double-billing.
// NEVER put a clock component (Date.now()) back into the key: a
// per-evaluation clock makes every replay look like a new event, which
// is exactly the double-billing this program exists to prevent.
// Identity preference: Apigee 'messageid' (platform-generated, unique
// and stable per transaction) > client 'x-request-id' header > one-time
// random fallback (dedup opt-out for that single event; random rather
// than clock so two same-millisecond keyless events cannot collide into
// a false dedup — same rationale as usage-ingestor V31).
var requestIdentity = requestId || trace.xRequestId ||
    ('apigee-norid-' + Math.floor(Math.random() * 0xFFFFFFFF).toString(16) +
     '-' + Math.floor(Math.random() * 0xFFFFFFFF).toString(16));

var idempotencyKey = isMcpToolCall
    ? 'mcp:apigee:' + requestIdentity + ':' + toolName
    : requestIdentity;

// ── Build Event ──
var event = null;

if (!skipReason && isMcpToolCall) {
    event = {
        customerId: customerId,
        metricName: 'mcp_server.tool_invocations',
        quantity: 1,
        idempotencyKey: idempotencyKey,
        occurredAt: new Date().toISOString(),
        // MCP_SERVER requires toolName AND agentId. Without an agentId the
        // configured productType is kept: the ingestor rejects an MCP_SERVER
        // event that has no agent.
        productType: (toolName && agentId) ? 'MCP_SERVER' : configuredProductType,
        toolName: toolName,
        // agentId: sourced EXCLUSIVELY from the JSON-RPC payload's
        // params._meta.agent_id. Never fall back to the X-Agent-Id
        // request header — it is client-settable and therefore spoofable.
        // Closed 2026-04-23 (MEDIUM IDOR advisory finding #11).
        agentId: agentId,
        sessionId: sessionId,
        executionDurationMs: latency,
        endpointPath: path,
        httpMethod: method,
        statusCode: statusCode,
        responseTimeMs: latency,
        trace: trace,
        metadata: {
            gateway: 'apigee',
            productId: mcpProductId,
            status: statusCode,
            latency: latency,
            path: path,
            endpoint_path: path,
            http_method: method,
            status_code: statusCode,
            response_time_ms: latency
        }
    };
    if (('' + toolName).length > MAX_TOOL_NAME_LENGTH) {
        skipReason = 'toolName longer than 64 characters';
        event = null;
    }
} else if (!skipReason) {
    var quantity = 1;
    if (trimStr(cfg('quantitySource')) === 'response_size') {
        quantity = parseInt(str('response.header.Content-Length') || '0', 10);
    }
    var metricName = resolveMetricName(method, path, basepath, pathSuffix || '/');
    if (!(quantity > 0)) {
        // The ingestor requires quantity > 0.
        skipReason = 'quantity <= 0';
    } else if (!metricName || metricName.length > MAX_METRIC_NAME_LENGTH) {
        skipReason = 'metric name empty or longer than 255 characters';
        print('[aforo-metering] WARN no usable metric name for ' + method + ' ' + path +
            '; event dropped. Check metric_mappings / metric_name_pattern / default_metric.');
    } else {
        event = {
            customerId: customerId,
            metricName: metricName,
            quantity: quantity,
            idempotencyKey: idempotencyKey,
            occurredAt: new Date().toISOString(),
            productType: configuredProductType,
            endpointPath: path,
            httpMethod: method,
            statusCode: statusCode,
            responseTimeMs: latency,
            trace: trace
        };
        if (includeMetadata) {
            event.metadata = {
                gateway: 'apigee',
                method: method,
                path: path,
                status: statusCode,
                latency: latency,
                endpoint_path: path,
                http_method: method,
                status_code: statusCode,
                response_time_ms: latency
            };
        }
        // AGENTIC_API classification — stamped only when a trace id is
        // resolvable (per descriptor eventSchema.inferenceRule = HAS_TRACE)
        // and the configured productType is the default API: an operator who
        // set another type keeps it. Fields go top-level so
        // SchemaBasedEventValidator.getTopLevelField reads them.
        if (agenticTraceId && configuredProductType === 'API') {
            event.productType = 'AGENTIC_API';
            event.traceId = agenticTraceId;
        }
        if (event.productType === 'AI_AGENT' && sessionId) {
            // agentId has no trusted source outside an MCP payload (X-Agent-Id
            // is client-settable), so AI_AGENT events are skipped below.
            event.sessionId = sessionId;
        }
    }
}

if (event) {
    var required = PRODUCT_TYPE_REQUIRED_FIELDS[event.productType] || [];
    var missing = [];
    for (var r = 0; r < required.length; r++) {
        if (!event[required[r]]) missing.push(required[r]);
    }
    if (missing.length > 0) {
        skipReason = 'productType ' + event.productType + ' missing ' + missing.join('+');
        event = null;
    }
}

if (event) {
    // ── executionStatus (all event paths: standard API, AGENTIC_API, MCP) ──
    // Omitted entirely when the status is not determinable.
    var executionStatus = outcomeFromStatus(statusCode, statusOutcomes);
    if (isMcpToolCall && executionStatus === 'SUCCESS' && statusCode < 300 &&
            isJsonRpcErrorResponse(context.getVariable('response.content'))) {
        executionStatus = 'ERROR';
    }
    if (executionStatus) {
        event.executionStatus = executionStatus;
    }
    // key_id claim of the verified Aforo JWT, when JWT validation ran.
    var keyId = trimStr(str('aforo.key_id'));
    if (keyId && (includeMetadata || event.metadata)) {
        event.metadata = event.metadata || {};
        event.metadata.keyId = keyId;
    }

    context.setVariable('aforo.eventPayload', JSON.stringify({ events: [event] }));
    // When the send starts. aforo-metering-retry-gate.js reads it to decide
    // whether a failed first attempt was quick enough to retry inside the
    // delay budget. Not part of the payload or the idempotency key.
    context.setVariable('aforo.meteringSend', 'true');
    context.setVariable('aforo.meteringSendStartMs', String(new Date().getTime()));
    context.setVariable('aforo.skip', 'false');
    context.setVariable('aforo.skipReason', '');
    context.setVariable('aforo.sendEvent', 'true');
} else {
    // No event: 'aforo.eventPayload' stays unset, and the send, retry and
    // failure-log steps in sharedflows/default.xml do not run.
    if (skipReason !== 'OPTIONS' && skipReason.indexOf('excluded') !== 0) {
        print('[aforo-metering] no event: ' + skipReason);
    }
    context.setVariable('aforo.skip', 'true');
    context.setVariable('aforo.skipReason', skipReason || 'no event');
    context.setVariable('aforo.sendEvent', 'false');
}
