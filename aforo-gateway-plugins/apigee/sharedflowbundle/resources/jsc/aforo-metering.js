/**
 * aforo-metering: builds the usage events of one call. Runs on the
 * environment's PostProxyFlowHook (or from a FlowCallout in the proxy's
 * DefaultFaultRule, see the user guide), after aforo-access ran on the
 * PreProxyFlowHook. Uses aforo-billing.js (IncludeURL).
 *
 * Bills only a call aforo-access let through (aforo.access.refused =
 * "false") for a verified customer (aforo.verified.customerId). Every
 * setting comes from the private.aforo.* variables aforo-access read from
 * the KVM; this flow reads no KVM itself.
 *
 * Per product type, as the Kong plugin does (trusted sources only: operator
 * config, Apigee's own values, and the upstream's RESPONSE headers, which
 * the client cannot set):
 *   API          one event; nothing extra.
 *   AGENTIC_API  traceId = upstream trace_id_header__{p} (default
 *                X-Aforo-Trace-Id), else Apigee's messageid: one call, one
 *                goal. The client's traceparent only travels in event.trace;
 *                it never names the trace and never changes the type.
 *   AI_AGENT     agentId = upstream X-Aforo-Agent-Id, else agent_id__{p},
 *                else the proxy name (when it fits the ingestor's 36
 *                characters). sessionId = upstream X-Aforo-Session-Id, else
 *                messageid. traceId = sessionId.
 *   MCP_SERVER   one event per JSON-RPC tools/call (batches too); initialize,
 *                tools/list, ping and notifications bill nothing. agentId =
 *                upstream X-Aforo-Agent-Id, else the customer. sessionId =
 *                upstream X-Aforo-Session-Id, else the upstream's
 *                Mcp-Session-Id response header.
 * An upstream header that is present but unusable (control characters, too
 * long) skips the event rather than billing a different identity.
 *
 * Every event: metricName (X-Aforo-Metric, metric_mappings__{p},
 * default_metric__{p}), quantity (quantity_header__{p}, default
 * X-Aforo-Quantity, else quantity_source, else 1), idempotencyKey (Apigee's
 * messageid, never a client header), executionStatus (shared status table,
 * status_outcomes__{p} overrides), endpointPath, httpMethod, statusCode,
 * responseTimeMs, trace (client headers, informational) and metadata.
 *
 * Output:
 *   aforo.eventPayload   {"events":[...]} when there is something to send
 *   aforo.meteringSend   "true" then
 *   aforo.meteringSendStartMs, aforo.eventCount
 *   aforo.skipReason     why nothing (or not everything) was sent
 */

var requestId = aforoStr('messageid');
var refused = aforoStr('aforo.access.refused');
var customerId = aforoTrim(aforoStr('aforo.verified.customerId'));
var productType = aforoTrim(aforoStr('aforo.verified.productType')) || 'API';
var product = aforoProductConfig();
var method = aforoStr('request.verb').toUpperCase();
var path = aforoRequestPath();
var tenantId = aforoCfg('tenantId');

// The status the client gets. In a DefaultFaultRule (upstream 4xx/5xx) the
// upstream's response is still `response`; error.status.code covers a fault
// raised before the target answered.
function clientStatus() {
    var names = ['response.status.code', 'error.status.code', 'message.status.code'];
    for (var i = 0; i < names.length; i++) {
        var n = parseInt(aforoStr(names[i]), 10);
        if (!isNaN(n) && n > 0) return n;
    }
    return 0;
}

function responseHeader(name) {
    return aforoStr('response.header.' + name);
}

// An upstream response header naming who or what is billed.
// {value} when usable, {} when absent, {bad: true} when present but unusable.
function upstreamIdentity(name, max) {
    var raw = responseHeader(name);
    if (raw === '') return {};
    var v = aforoCleanString(raw, max);
    return v === null ? { bad: true } : { value: v };
}

// Whole request as the client saw it, in ms.
function responseTimeMs() {
    var start = parseInt(aforoStr('client.received.start.timestamp'), 10);
    var now = parseInt(aforoStr('system.timestamp'), 10);
    if (isNaN(now)) now = new Date().getTime();
    if (isNaN(start) || now < start) return 0;
    return now - start;
}

function utf8Length(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
        else n += 3;
    }
    return n;
}

// Bytes of the response body: Content-Length, else the body Apigee holds
// (a chunked or SSE response has no Content-Length). With response
// streaming on, Apigee holds no body and this is 0: not billed.
function responseBytes() {
    var cl = parseInt(responseHeader('Content-Length'), 10);
    if (!isNaN(cl) && cl >= 0) return cl;
    var body = context.getVariable('response.content');
    return (body === null || body === undefined) ? 0 : utf8Length('' + body);
}

function resolveQuantity() {
    var header = responseHeader(product.quantityHeader);
    if (header !== '') {
        var n = Number(aforoTrim(header));
        if (aforoTrim(header) !== '' && isFinite(n) && n > 0) return n;
        print('[aforo-metering] ignoring unusable ' + product.quantityHeader + ' header: ' +
            JSON.stringify(header.substring(0, 40)));
    }
    var source = aforoCfg('quantitySource') || '1';
    if (source === 'response_size') return responseBytes();
    var fixed = Number(source);
    return (isFinite(fixed) && fixed > 0) ? fixed : 1;
}

function sha256Hex(s) {
    try {
        var h = crypto.getSHA256();
        h.update(s);
        return '' + h.digest();
    } catch (e) {
        return '';
    }
}

// MCP's own session header has no length limit; a value the ingestor would
// refuse is hashed rather than dropped, so the session survives.
function mcpSessionId() {
    var h = upstreamIdentity(AFORO_SESSION_ID_HEADER, AFORO_MAX.sessionId);
    if (h.bad) return { bad: AFORO_SESSION_ID_HEADER };
    if (h.value) return { value: h.value };
    var raw = responseHeader('Mcp-Session-Id');
    if (raw === '') return {};
    var clean = aforoCleanString(raw, AFORO_MAX.sessionId);
    if (clean) return { value: clean };
    var hex = sha256Hex(raw);
    return hex ? { value: 'mcp-' + hex.substring(0, 56) } : {};
}

// JSON-RPC errors in a 2xx answer, by request id ('*' for a single answer).
function jsonRpcErrors(body) {
    var out = {};
    if (body === null || body === undefined) return out;
    var text = '' + body;
    if (text.indexOf('"error"') === -1) return out;
    try {
        var parsed = JSON.parse(text);
        var list = (parsed && typeof parsed.length === 'number') ? parsed : [parsed];
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (m && m.jsonrpc === '2.0' && m.error && typeof m.error === 'object') {
                out[(m.id === null || m.id === undefined) ? '*' : String(m.id)] = true;
                if (list.length === 1) out['*'] = true;
            }
        }
    } catch (e) {
        // not JSON (an SSE stream, say): status-only classification
    }
    return out;
}

function traceContext() {
    return {
        traceparent: aforoCleanString(aforoStr('request.header.traceparent'), 128),
        tracestate: aforoCleanString(aforoStr('request.header.tracestate'), 512),
        xTraceId: aforoCleanString(aforoStr('request.header.x-trace-id'), 128),
        xRequestId: aforoCleanString(aforoStr('request.header.x-request-id'), 128)
    };
}

// ── Should this call be billed at all? ──
var skipReason = '';
var status = clientStatus();
if (refused !== 'false') {
    skipReason = 'refused by aforo-access, or aforo-access did not run';
} else if (!customerId) {
    skipReason = 'no verified customer';
} else if (aforoIsExcludedRequest(aforoExcludePaths(aforoCfg('excludePaths')))) {
    skipReason = 'excluded path';
} else if (aforoExcludeStatusCodes(aforoCfg('excludeStatusCodes')).indexOf(status) !== -1) {
    skipReason = 'excluded status code';
} else if (aforoIsCorsPreflight(method)) {
    skipReason = 'CORS preflight';
} else if (!requestId) {
    skipReason = 'no messageid';
} else if (!aforoCfg('endpoint') || !aforoCfg('apiKey')) {
    skipReason = 'KVM aforo_endpoint or api_key is not set';
}

var events = [];
var dropped = [];

if (!skipReason) {
    var headerMetric = '';
    var hm = upstreamIdentity(AFORO_METRIC_HEADER, AFORO_MAX.metricName);
    if (hm.bad) skipReason = 'unusable ' + AFORO_METRIC_HEADER + ' response header';
    else headerMetric = hm.value || '';

    var calls = [];
    try {
        var stash = JSON.parse(aforoStr('aforo.verified.mcpCalls') || '[]');
        if (stash && typeof stash.length === 'number') calls = stash;
    } catch (e) {
        calls = [];
    }
    var billable = aforoBillable(productType, productType === 'MCP_SERVER' ? { calls: calls } : null);
    var now = new Date().toISOString();
    var ms = responseTimeMs();

    if (!skipReason && billable.tools) {
        var toolMetric = aforoToolCallMetric(method, path, headerMetric, product);
        var agent = upstreamIdentity(AFORO_AGENT_ID_HEADER, AFORO_MAX.agentId);
        var session = mcpSessionId();
        if (agent.bad) skipReason = 'unusable ' + AFORO_AGENT_ID_HEADER + ' response header';
        else if (session.bad) skipReason = 'unusable ' + session.bad + ' response header';
        else {
            var rpcErrors = (status >= 200 && status < 300) ? jsonRpcErrors(context.getVariable('response.content')) : {};
            for (var c = 0; c < calls.length; c++) {
                var call = calls[c] || {};
                var tool = aforoEscapedString(call.toolName || 'unknown', AFORO_MAX.toolName) || 'unknown';
                var ev = {
                    productType: 'MCP_SERVER',
                    customerId: customerId,
                    metricName: toolMetric,
                    quantity: 1,
                    idempotencyKey: 'mcp:' + tenantId + ':' + requestId + ':' + (c + 1) + ':' + tool,
                    occurredAt: now,
                    toolName: tool,
                    agentId: agent.value || customerId,
                    executionDurationMs: ms
                };
                if (session.value) ev.sessionId = session.value;
                var callId = (call.id === null || call.id === undefined) ? null : String(call.id);
                ev.rpcError = (callId !== null && rpcErrors[callId] === true) ||
                    (calls.length === 1 && rpcErrors['*'] === true);
                events.push(ev);
            }
        }
    }

    if (!skipReason && billable.plain) {
        var plain = {
            productType: productType,
            customerId: customerId,
            metricName: aforoResolveMetric(method, path, headerMetric, product, ''),
            quantity: resolveQuantity(),
            idempotencyKey: requestId,
            occurredAt: now
        };
        if (productType === 'AI_AGENT') {
            var a = upstreamIdentity(AFORO_AGENT_ID_HEADER, AFORO_MAX.agentId);
            var s = upstreamIdentity(AFORO_SESSION_ID_HEADER, AFORO_MAX.sessionId);
            if (a.bad) skipReason = 'unusable ' + AFORO_AGENT_ID_HEADER + ' response header';
            else if (s.bad) skipReason = 'unusable ' + AFORO_SESSION_ID_HEADER + ' response header';
            else {
                plain.agentId = a.value || product.agentId ||
                    aforoCleanString(aforoStr('apiproxy.name'), AFORO_MAX.agentId) || '';
                plain.sessionId = s.value || requestId;
            }
        }
        if (!skipReason) events.push(plain);
    }
    if (!skipReason && events.length === 0) skipReason = 'nothing billable (no tools/call)';
}

// ── Common fields, then the checks the ingestor would apply ──
var outcomes = aforoParseStatusOutcomes(product.statusOutcomes);
var includeMetadata = aforoCfg('includeMetadata').toLowerCase() !== 'false';
var endpointPath = aforoEscapedString(path, AFORO_MAX.endpointPath) || '/';
var keyId = aforoTrim(aforoStr('aforo.jwt.key_id'));
var REQUIRED = {
    API: [], AGENTIC_API: ['traceId'], AI_AGENT: ['agentId', 'sessionId'], MCP_SERVER: ['toolName', 'agentId'],
    GRPC_API: ['grpcService', 'grpcMethod'], GRAPHQL_API: ['gqlOperationType'],
    WEBSOCKET_API: ['wsConnectionId'], MQTT_BROKER: ['mqttTopic']
};
var ready = [];
var trace = skipReason ? null : traceContext();
var elapsed = responseTimeMs();

for (var i = 0; i < events.length && !skipReason; i++) {
    var e = events[i];
    var rpcError = e.rpcError === true;
    delete e.rpcError;

    e.quantity = Math.round(Number(e.quantity) * 1e6) / 1e6;
    if (!(e.quantity > 0) || e.quantity >= 1e14) {
        dropped.push('quantity not > 0 or too large');
        continue;
    }
    if (e.productType === 'AGENTIC_API') {
        var t = upstreamIdentity(product.traceIdHeader, AFORO_MAX.traceId);
        if (t.bad) {
            dropped.push('unusable ' + product.traceIdHeader + ' response header');
            continue;
        }
        e.traceId = t.value || requestId;
    }
    if (e.productType === 'AI_AGENT') e.traceId = e.sessionId;

    e.endpointPath = endpointPath;
    e.httpMethod = method.substring(0, 16);
    e.statusCode = status;
    e.responseTimeMs = elapsed;
    var outcome = aforoOutcomeFromStatus(status, outcomes);
    if (rpcError && outcome === 'SUCCESS') outcome = 'ERROR';
    if (outcome) e.executionStatus = outcome;
    e.trace = trace;

    if (includeMetadata) {
        e.metadata = {
            gateway: 'apigee',
            method: method,
            path: endpointPath,
            status: status,
            endpoint_path: endpointPath,
            http_method: method,
            status_code: status,
            response_time_ms: elapsed,
            apiProxy: aforoStr('apiproxy.name'),
            apiProduct: aforoStr('aforo.verified.apiProduct')
        };
    } else {
        // Central mappings and the ingestor's metric filters read this key.
        e.metadata = { endpoint_path: endpointPath };
    }
    if (product.aforoProductId) e.metadata.productId = product.aforoProductId;
    if (keyId) e.metadata.keyId = keyId;

    var problem = '';
    for (var f in AFORO_MAX) {
        if (!Object.prototype.hasOwnProperty.call(AFORO_MAX, f) || f === 'endpointPath') continue;
        if (typeof e[f] === 'string' && (e[f].length > AFORO_MAX[f] || !aforoIsText(e[f], true))) {
            problem = f + ' is longer than ' + AFORO_MAX[f] + ' characters or not text';
            break;
        }
    }
    var required = REQUIRED[e.productType] || [];
    for (var r = 0; r < required.length && !problem; r++) {
        if (!e[required[r]]) problem = 'productType ' + e.productType + ' requires ' + required[r];
    }
    if (problem) {
        dropped.push(problem);
        continue;
    }
    ready.push(e);
}

if (!skipReason && ready.length === 0 && dropped.length > 0) skipReason = dropped.join('; ');

// WARN from the pre-flight check (fresh or cached), as Kong marks it.
var quotaDecision = aforoStr('aforo.access.quotaDecision') || aforoStr('aforo.access.cachedDecision');
if (refused === 'false' && quotaDecision === 'WARN') {
    context.setVariable('response.header.X-RateLimit-Warning', 'approaching-limit');
}

if (ready.length > 0) {
    context.setVariable('aforo.eventPayload', JSON.stringify({ events: ready }));
    context.setVariable('aforo.eventCount', String(ready.length));
    context.setVariable('aforo.meteringSend', 'true');
    context.setVariable('aforo.meteringSendStartMs', String(new Date().getTime()));
    context.setVariable('aforo.skipReason', dropped.join('; '));
    if (dropped.length > 0) print('[aforo-metering] events skipped: ' + dropped.join('; '));
} else {
    context.setVariable('aforo.meteringSend', 'false');
    context.setVariable('aforo.eventCount', '0');
    context.setVariable('aforo.skipReason', skipReason || 'no event');
    if (skipReason && skipReason.indexOf('excluded') !== 0 && skipReason !== 'CORS preflight' &&
            skipReason.indexOf('refused') !== 0) {
        print('[aforo-metering] not metered: ' + skipReason);
    }
}
