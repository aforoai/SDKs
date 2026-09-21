/**
 * Aforo Metering — Apigee JavaScript Policy
 *
 * Builds a usage event from the request/response context and stores the JSON
 * payload in 'aforo.eventPayload'. Sets 'aforo.sendEvent' to "true" only when
 * the event is one the ingestor can accept; the AforoMeteringSendEvent step is
 * conditioned on it. Otherwise 'aforo.skipReason' says why.
 *
 * Supports:
 * - Standard API metering (metric from KVM mappings / default metric)
 * - MCP JSON-RPC tools/call detection
 * - W3C Trace Context capture (traceparent, tracestate, x-trace-id, x-request-id)
 *
 * Config (flow variables populated from the KVM by AforoMeteringReadConfig):
 *   aforo.metricMappings     JSON array [{matchType, value, metricName}],
 *                            EXACT | PREFIX | CONTAINS, first match wins
 *   aforo.defaultMetric      metric for unmapped requests (default api_calls)
 *   aforo.metricNamePattern  legacy "{method} {path}" template — only if set
 *   aforo.customerIdSource   optional "flow_variable:<name>" fallback
 *   aforo.excludePaths       comma-separated path prefixes
 *   aforo.excludeStatusCodes comma-separated status codes
 *   aforo.quantitySource     "1" (default) or "response_size"
 *   aforo.includeMetadata    "false" to omit metadata
 *   aforo.mcpEnabled / aforo.mcpProductId
 */

var MAX_CUSTOMER_ID_LENGTH = 64;

function str(name) {
    var v = context.getVariable(name);
    return (v === null || v === undefined) ? '' : String(v);
}

function splitList(raw) {
    if (!raw) return [];
    return String(raw).split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
}

function parseMappings(raw) {
    if (!raw) return [];
    try {
        var rules = JSON.parse(raw);
        return Array.isArray(rules) ? rules : [];
    } catch (e) {
        print('[aforo-metering] metric_mappings is not valid JSON — using default_metric');
        return [];
    }
}

function mappingMatches(path, rule) {
    if (!rule || typeof rule.value !== 'string' || rule.value === '' || !rule.metricName) return false;
    var kind = rule.matchType || 'EXACT';
    if (kind === 'EXACT') return path === rule.value;
    if (kind === 'PREFIX') return path.indexOf(rule.value) === 0;
    if (kind === 'CONTAINS') return path.indexOf(rule.value) !== -1;
    return false;
}

function resolveMetricName(method, path) {
    var rules = parseMappings(str('aforo.metricMappings'));
    for (var i = 0; i < rules.length; i++) {
        if (mappingMatches(path, rules[i])) return rules[i].metricName;
    }
    // Route-shaped names are not catalog metrics (unknown metric → whole
    // batch 400), so the pattern applies only when explicitly configured.
    var pattern = str('aforo.metricNamePattern');
    if (pattern) return pattern.replace('{method}', method).replace('{path}', path);
    return str('aforo.defaultMetric') || 'api_calls';
}

/**
 * Customer identity, verified sources only:
 *  1. aforo.customer_id — the customer_id claim VerifyJWT extracted from a
 *     signature-checked Aforo JWT (only set when JWT validation is enabled).
 *  2. customer_id_source = "flow_variable:<name>" — a flow variable the admin
 *     knows is populated by a verified policy, e.g. a developer-app custom
 *     attribute "aforo_customer_id" read after VerifyAPIKey. Request/message
 *     variables are refused: they are client-controlled.
 * No developer.app.name / developer.email: those are Apigee names, not Aforo
 * customer ids, and the ingestor rejects unknown customers.
 */
function resolveCustomerId() {
    var fromJwt = str('aforo.customer_id').trim();
    if (fromJwt) return fromJwt;
    var source = str('aforo.customerIdSource').trim();
    var prefix = 'flow_variable:';
    if (source.indexOf(prefix) === 0) {
        var varName = source.substring(prefix.length).trim();
        if (varName && !/^(request|message|response)\./i.test(varName)) {
            return str(varName).trim();
        }
        print('[aforo-metering] customer_id_source refers to a client-controlled variable — ignored');
    }
    return '';
}

var method = str('request.verb') || 'UNKNOWN';
var basepath = str('proxy.basepath');
var suffix = str('proxy.pathsuffix');
var path = ((basepath === '/' ? '' : basepath) + suffix) || '/';
var statusCode = parseInt(str('response.status.code') || '0', 10);
var latency = parseInt(str('target.latency') || '0', 10);
var requestId = str('messageid');
var customerId = resolveCustomerId();
var mcpEnabled = str('aforo.mcpEnabled') === 'true';
var mcpProductId = str('aforo.mcpProductId');
var includeMetadata = str('aforo.includeMetadata') !== 'false';

var skipReason = '';
var excludePaths = splitList(str('aforo.excludePaths'));
var excludeStatusCodes = splitList(str('aforo.excludeStatusCodes'));

if (method === 'OPTIONS') {
    // CORS preflight: a browser protocol detail, not a billable call, and it
    // never carries credentials, so it can never have a customer.
    skipReason = 'OPTIONS';
} else if (excludePaths.some(function (p) { return path.indexOf(p) === 0; })) {
    skipReason = 'excluded path';
} else if (excludeStatusCodes.indexOf(String(statusCode)) !== -1) {
    skipReason = 'excluded status code';
} else if (!customerId) {
    skipReason = 'no customerId';
} else if (customerId.length > MAX_CUSTOMER_ID_LENGTH) {
    skipReason = 'customerId longer than 64 characters';
}

// ── W3C Trace Context ──
var trace = {
    traceparent: context.getVariable('request.header.traceparent') || null,
    tracestate: context.getVariable('request.header.tracestate') || null,
    xTraceId: context.getVariable('request.header.x-trace-id') || null,
    xRequestId: context.getVariable('request.header.x-request-id') || null
};

// ── MCP Detection ──
var isMcpToolCall = false;
var toolName = '';
var agentId = '';
var sessionId = str('request.header.Mcp-Session-Id');

if (!skipReason && mcpEnabled && method === 'POST') {
    try {
        var reqBody = context.getVariable('request.content');
        if (reqBody && reqBody.indexOf('tools/call') > -1) {
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

// ── Build Event ──
var event = null;

if (!skipReason && isMcpToolCall) {
    event = {
        customerId: customerId,
        metricName: 'mcp_server.tool_invocations',
        quantity: 1,
        // Stable per request (was suffixed with Date.now(), so nothing could dedupe).
        idempotencyKey: 'mcp:apigee:' + requestId + ':' + toolName,
        occurredAt: new Date().toISOString(),
        productType: 'MCP_SERVER',
        toolName: toolName,
        // agentId: sourced EXCLUSIVELY from the JSON-RPC payload's
        // params._meta.agent_id. Never fall back to the X-Agent-Id
        // request header — it is client-settable and therefore spoofable.
        // Closed 2026-04-23 (MEDIUM IDOR advisory finding #11).
        agentId: agentId,
        sessionId: sessionId,
        executionStatus: (statusCode >= 200 && statusCode < 300) ? 'SUCCESS' : 'ERROR',
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
} else if (!skipReason) {
    var quantity = 1;
    if (str('aforo.quantitySource') === 'response_size') {
        quantity = parseInt(str('response.header.Content-Length') || '0', 10);
    }
    if (!(quantity > 0)) {
        // The ingestor requires quantity > 0 and rejects the whole batch otherwise.
        skipReason = 'quantity <= 0';
    } else {
        event = {
            customerId: customerId,
            metricName: resolveMetricName(method, path),
            quantity: quantity,
            idempotencyKey: requestId || ('apigee-' + Date.now()),
            occurredAt: new Date().toISOString(),
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
    }
}

if (event) {
    var keyId = str('aforo.key_id');
    if (keyId) {
        event.metadata = event.metadata || {};
        event.metadata.keyId = keyId;
    }
    context.setVariable('aforo.eventPayload', JSON.stringify({ events: [event] }));
    context.setVariable('aforo.sendEvent', 'true');
    context.setVariable('aforo.skipReason', '');
} else {
    context.setVariable('aforo.eventPayload', '');
    context.setVariable('aforo.sendEvent', 'false');
    context.setVariable('aforo.skipReason', skipReason);
}
