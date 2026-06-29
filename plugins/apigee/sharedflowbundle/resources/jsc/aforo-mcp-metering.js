/**
 * Aforo MCP Metering — Apigee JavaScript Policy
 *
 * Extends the standard metering JS with MCP JSON-RPC detection.
 * When a POST request contains a JSON-RPC tools/call payload,
 * extracts tool_name and agent_id for MCP-specific billing.
 *
 * Runs in PostClientFlow. Stores payload in 'aforo.eventPayload'.
 */

var method = context.getVariable('request.verb') || 'UNKNOWN';
var path = context.getVariable('proxy.pathsuffix') || '/';
var statusCode = parseInt(context.getVariable('response.status.code') || '0', 10);
var latency = parseInt(context.getVariable('target.latency') || '0', 10);
var requestId = context.getVariable('messageid') || '';
var customerId = context.getVariable('developer.app.name') || context.getVariable('developer.email') || '';
var mcpEnabled = context.getVariable('aforo.mcpEnabled') === 'true';
var mcpProductId = context.getVariable('aforo.mcpProductId') || '';

// Check if this is an MCP tools/call request
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

// Build the event payload
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
        // Closed 2026-04-23 (advisory finding #11).
        agentId: agentId,
        sessionId: sessionId,
        executionStatus: (statusCode >= 200 && statusCode < 300) ? 'SUCCESS' : 'ERROR',
        executionDurationMs: latency,
        metadata: {
            gateway: 'apigee',
            productId: mcpProductId,
            status: statusCode,
            latency: latency,
            path: path
        }
    };
} else {
    // Standard metering (fallback to existing aforo-metering.js logic)
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
        metadata: {
            gateway: 'apigee',
            method: method,
            path: path,
            status: statusCode,
            latency: latency
        }
    };
}

var payload = JSON.stringify({ events: [event] });
context.setVariable('aforo.eventPayload', payload);
