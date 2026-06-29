/**
 * Aforo Metering Lambda — AWS API Gateway
 *
 * Subscribes to CloudWatch Logs from API Gateway access logs.
 * Parses log entries, builds usage events with W3C trace context,
 * and batch-POSTs them to the Aforo usage ingestor service.
 *
 * Environment variables:
 *   AFORO_ENDPOINT       — Aforo ingestor batch URL
 *   AFORO_API_KEY        — API key for authentication
 *   AFORO_TENANT_ID      — Tenant identifier (admin-pinned via Lambda env)
 *   METRIC_NAME_PATTERN  — Template: {method} {path} (default)
 *   QUANTITY_SOURCE       — "1" (count) or "response_size"
 *   CUSTOMER_ID_SOURCE    — "consumer" only. Sources customer identity
 *                           from the API Gateway access-log entry's
 *                           $context.identity.apiKey / $context.identity.caller
 *                           (bound to the authenticated credential by API
 *                           Gateway, not client-settable). Any other value
 *                           is IGNORED. "header" was removed 2026-04-23
 *                           (IDOR advisory hygiene — see CHANGELOG.md).
 *   FLUSH_COUNT           — Max events per batch (default 50)
 *   INCLUDE_METADATA      — "true" to include request metadata
 *   MCP_ENABLED           — "true" to enable MCP JSON-RPC detection
 *   MCP_PRODUCT_ID        — Aforo product ID for MCP metering
 *   MARGIN_GUARD_ENABLED  — "true" to enable margin guard enforcement
 *   MARGIN_GUARD_URL      — Pricing-service base URL for margin guard quick-check
 *
 * Note: Margin guard enforcement in this Lambda is informational only.
 * This Lambda processes CloudWatch Logs asynchronously and CANNOT block
 * live requests. For real-time L2/L3 enforcement, deploy the margin-guard.js
 * module as a separate API Gateway Lambda Authorizer.
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');

const AFORO_ENDPOINT = process.env.AFORO_ENDPOINT || '';
const AFORO_API_KEY = process.env.AFORO_API_KEY || '';
const AFORO_TENANT_ID = process.env.AFORO_TENANT_ID || '';
const METRIC_NAME_PATTERN = process.env.METRIC_NAME_PATTERN || '{method} {path}';
const QUANTITY_SOURCE = process.env.QUANTITY_SOURCE || '1';
const CUSTOMER_ID_SOURCE = process.env.CUSTOMER_ID_SOURCE || 'consumer';
const FLUSH_COUNT = parseInt(process.env.FLUSH_COUNT || '50', 10);
const INCLUDE_METADATA = process.env.INCLUDE_METADATA !== 'false';
const MCP_ENABLED = process.env.MCP_ENABLED === 'true';
const MCP_PRODUCT_ID = process.env.MCP_PRODUCT_ID || '';
const MARGIN_GUARD_ENABLED = process.env.MARGIN_GUARD_ENABLED === 'true';
const MARGIN_GUARD_URL = process.env.MARGIN_GUARD_URL || '';

const EXCLUDE_PATHS = ['/health', '/ready', '/metrics', '/favicon.ico'];
const EXCLUDE_STATUS_CODES = [401, 403, 429];

/**
 * Lambda handler — processes CloudWatch Logs events.
 */
exports.handler = async (event) => {
    const payload = Buffer.from(event.awslogs.data, 'base64');
    const decompressed = zlib.gunzipSync(payload);
    const logData = JSON.parse(decompressed.toString('utf8'));

    if (logData.messageType === 'CONTROL_MESSAGE') {
        console.log('Control message — skipping');
        return { statusCode: 200, body: 'Control message' };
    }

    const logEvents = logData.logEvents || [];
    if (logEvents.length === 0) {
        return { statusCode: 200, body: 'No events' };
    }

    console.log(`Processing ${logEvents.length} log events from ${logData.logGroup}`);

    const usageEvents = [];
    for (const logEvent of logEvents) {
        const parsed = parseAccessLog(logEvent.message);
        if (!parsed) continue;

        if (EXCLUDE_PATHS.some(p => parsed.path && parsed.path.startsWith(p))) continue;
        if (EXCLUDE_STATUS_CODES.includes(parsed.status)) continue;

        const metricName = METRIC_NAME_PATTERN
            .replace('{method}', parsed.method || 'UNKNOWN')
            .replace('{path}', parsed.path || '/')
            .replace('{service}', parsed.stage || '')
            .replace('{route}', parsed.resource || '');

        let quantity = 1;
        if (QUANTITY_SOURCE === 'response_size') {
            quantity = parsed.responseLength || 0;
        }

        // Customer identity is sourced EXCLUSIVELY from API Gateway's
        // $context.identity fields (apiKey / caller). These are populated
        // by API Gateway from the verified API key or IAM caller and are
        // NOT client-settable. Any legacy CUSTOMER_ID_SOURCE='header'
        // config value is ignored — the header-reading branch was
        // removed 2026-04-23 (IDOR advisory hygiene).
        let customerId = null;
        if (CUSTOMER_ID_SOURCE === 'consumer') {
            customerId = parsed.apiKey || parsed.caller || null;
        }
        // else: silently drops through with customerId=null.
        // The event will be dropped downstream by the ingestor's
        // schema validation (customerId is a required field).

        // W3C Trace Context (null when absent — fidelity, not synthetic)
        const headers = parsed.headers || {};
        const trace = {
            traceparent: headers['traceparent'] ?? null,
            tracestate: headers['tracestate'] ?? null,
            xTraceId: headers['x-trace-id'] ?? null,
            xRequestId: headers['x-request-id'] ?? null,
        };

        const usageEvent = {
            customerId,
            metricName,
            quantity,
            idempotencyKey: parsed.requestId || `${logEvent.id}`,
            occurredAt: new Date(logEvent.timestamp).toISOString(),
            endpointPath: parsed.path,
            httpMethod: parsed.method,
            statusCode: parsed.status,
            responseTimeMs: parsed.latency || 0,
            trace,
        };

        if (INCLUDE_METADATA) {
            usageEvent.metadata = {
                gateway: 'aws-api-gateway',
                method: parsed.method,
                path: parsed.path,
                status: parsed.status,
                latency: parsed.latency,
                responseLength: parsed.responseLength,
                stage: parsed.stage,
                resource: parsed.resource,
                requestId: parsed.requestId,
                endpoint_path: parsed.path,
                http_method: parsed.method,
                status_code: parsed.status,
                response_time_ms: parsed.latency,
            };
        }

        // MCP detection
        if (MCP_ENABLED && parsed.method === 'POST' && parsed.requestBody) {
            const mcpInfo = detectMcpToolCall(parsed.requestBody);
            if (mcpInfo) {
                usageEvent.metricName = 'mcp_server.tool_invocations';
                usageEvent.quantity = 1;
                usageEvent.productType = 'MCP_SERVER';
                usageEvent.toolName = mcpInfo.toolName;
                usageEvent.agentId = mcpInfo.agentId;
                usageEvent.executionStatus = parsed.status >= 200 && parsed.status < 300 ? 'SUCCESS' : 'ERROR';
                usageEvent.executionDurationMs = parsed.latency || 0;
                usageEvent.idempotencyKey = `mcp:${AFORO_TENANT_ID}:${parsed.requestId}:${mcpInfo.toolName}:${logEvent.timestamp}`;
            }
        }

        usageEvents.push(usageEvent);
    }

    if (usageEvents.length === 0) {
        console.log('No usage events after filtering');
        return { statusCode: 200, body: 'No events after filtering' };
    }

    const batches = [];
    for (let i = 0; i < usageEvents.length; i += FLUSH_COUNT) {
        batches.push(usageEvents.slice(i, i + FLUSH_COUNT));
    }

    let totalSent = 0;
    for (const batch of batches) {
        const success = await sendToAforo(batch);
        if (success) {
            totalSent += batch.length;
        }
    }

    console.log(`Sent ${totalSent}/${usageEvents.length} events to Aforo`);
    return { statusCode: 200, body: `Processed ${totalSent} events` };
};

/**
 * Parse an API Gateway access log entry.
 */
function parseAccessLog(message) {
    if (!message) return null;

    try {
        const json = JSON.parse(message);
        return {
            requestId: json.requestId || json.extendedRequestId,
            method: json.httpMethod || json.method,
            path: json.resourcePath || json.path,
            status: parseInt(json.status || json.statusCode || '0', 10),
            latency: parseInt(json.responseLatency || json.integrationLatency || '0', 10),
            responseLength: parseInt(json.responseLength || '0', 10),
            stage: json.stage || '',
            resource: json.resource || json.resourcePath || '',
            apiKey: json.apiKey || json['identity.apiKey'] || '',
            caller: json.caller || json.principalId || '',
            headers: json.requestHeaders || {},
            requestBody: json.requestBody || null,
        };
    } catch {
        // Not JSON
    }

    const clfMatch = message.match(
        /(\S+)\s+\S+\s+\S+\s+\[.*?\]\s+"(\w+)\s+(\S+)\s+\S+"\s+(\d+)\s+(\d+)/
    );
    if (clfMatch) {
        return {
            requestId: null,
            method: clfMatch[2],
            path: clfMatch[3],
            status: parseInt(clfMatch[4], 10),
            latency: 0,
            responseLength: parseInt(clfMatch[5], 10),
            stage: '',
            resource: clfMatch[3],
            apiKey: '',
            caller: clfMatch[1],
            headers: {},
            requestBody: null,
        };
    }

    return null;
}

/**
 * Detect MCP JSON-RPC tools/call in request body.
 */
function detectMcpToolCall(requestBody) {
    if (!requestBody) return null;
    try {
        const parsed = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;
        if (parsed.jsonrpc !== '2.0' || parsed.method !== 'tools/call') return null;
        const params = parsed.params || {};
        if (!params.name) return null;
        return {
            toolName: params.name,
            agentId: params._meta?.agent_id || null,
        };
    } catch {
        return null;
    }
}

/**
 * Send a batch of usage events to Aforo's ingestor.
 */
async function sendToAforo(events) {
    const body = JSON.stringify({ events });

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const statusCode = await doPost(AFORO_ENDPOINT, body);
            if (statusCode >= 200 && statusCode < 300) {
                return true;
            }
            if (statusCode >= 400 && statusCode < 500) {
                console.error(`Aforo returned ${statusCode} (client error) — not retrying`);
                return false;
            }
            console.warn(`Aforo returned ${statusCode} — attempt ${attempt}/3`);
        } catch (err) {
            console.warn(`Request failed — attempt ${attempt}/3: ${err.message}`);
        }

        if (attempt < 3) {
            await sleep(Math.pow(2, attempt - 1) * 1000);
        }
    }

    console.error('All 3 attempts failed — events dropped');
    return false;
}

function doPost(url, body) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Authorization': `Bearer ${AFORO_API_KEY}`,
                'X-Tenant-Id': AFORO_TENANT_ID,
            },
            timeout: 10000,
        };

        const transport = parsedUrl.protocol === 'https:' ? https : http;
        const req = transport.request(options, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode));
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Export for testing
module.exports = { parseAccessLog, detectMcpToolCall };
