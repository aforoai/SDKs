/**
 * Aforo Metering — Apigee JavaScript Policy
 *
 * Runs in PostClientFlow. Builds a usage event from the request/response
 * context and stores the JSON payload in 'aforo.eventPayload' for the
 * ServiceCallout policy to send to the Aforo ingestor.
 *
 * Supports:
 * - Standard API metering (method + path)
 * - MCP JSON-RPC tools/call detection
 * - W3C Trace Context capture (traceparent, tracestate, x-trace-id, x-request-id)
 */

var method = context.getVariable('request.verb') || 'UNKNOWN';
var path = context.getVariable('proxy.pathsuffix') || '/';
var statusCode = parseInt(context.getVariable('response.status.code') || '0', 10);
var latency = parseInt(context.getVariable('target.latency') || '0', 10);
var requestId = context.getVariable('messageid') || '';
var customerId = context.getVariable('developer.app.name') || context.getVariable('developer.email') || '';
var mcpEnabled = context.getVariable('aforo.mcpEnabled') === 'true';
var mcpProductId = context.getVariable('aforo.mcpProductId') || '';

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
var sessionId = context.getVariable('request.header.Mcp-Session-Id') || '';

if (mcpEnabled && method === 'POST') {
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
var event;

if (isMcpToolCall) {
    event = {
        customerId: customerId,
        metricName: 'mcp_server.tool_invocations',
        quantity: 1,
        idempotencyKey: 'mcp:apigee:' + requestId + ':' + toolName + ':' + Date.now(),
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
} else {
    var metricNamePattern = context.getVariable('aforo.metricNamePattern') || '{method} {path}';
    var metricName = metricNamePattern
        .replace('{method}', method)
        .replace('{path}', path);

    event = {
        customerId: customerId,
        metricName: metricName,
        quantity: 1,
        idempotencyKey: requestId || ('apigee-' + Date.now()),
        occurredAt: new Date().toISOString(),
        endpointPath: path,
        httpMethod: method,
        statusCode: statusCode,
        responseTimeMs: latency,
        trace: trace,
        metadata: {
            gateway: 'apigee',
            method: method,
            path: path,
            status: statusCode,
            latency: latency,
            endpoint_path: path,
            http_method: method,
            status_code: statusCode,
            response_time_ms: latency
        }
    };
}

var payload = JSON.stringify({ events: [event] });
context.setVariable('aforo.eventPayload', payload);
