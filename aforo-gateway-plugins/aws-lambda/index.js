/**
 * Aforo Metering Lambda — AWS API Gateway
 *
 * Subscribes to CloudWatch Logs from API Gateway access logs.
 * Parses log entries, builds usage events with W3C trace context,
 * and batch-POSTs them to the Aforo usage ingestor service.
 *
 * Environment variables:
 *   AFORO_ENDPOINT       — Aforo ingestor batch URL (…/v1/ingest/batch)
 *   AFORO_API_KEY        — Aforo API key (scope usage:ingest). Sent as
 *                          X-API-Key. The tenant is derived from the key; no
 *                          tenant header is sent.
 *   METRIC_MAPPINGS      — JSON array of endpoint→metric rules, first match
 *                          wins: [{"matchType":"PREFIX","value":"/v1/sms",
 *                          "metricName":"sms_sent"}]. matchType is EXACT,
 *                          PREFIX or CONTAINS (plain string comparison, the
 *                          same semantics as catalog's gateway-mappings).
 *   DEFAULT_METRIC       — Metric for requests no mapping matches
 *                          (default "api_calls"). MUST be a metric registered
 *                          in the Aforo catalog: an unknown metric fails the
 *                          whole batch with 400.
 *   METRIC_NAME_PATTERN  — Legacy route-shaped template ({method} {path}
 *                          {service} {route}). Used ONLY when explicitly set;
 *                          every resulting name must be a catalog metric.
 *   QUANTITY_SOURCE      — "1" (count) or "response_size"
 *   FLUSH_COUNT          — Max events per batch (default 50, capped at 1000 —
 *                          the ingestor rejects larger batches with 400)
 *   INCLUDE_METADATA     — "false" to omit request metadata
 *   MCP_ENABLED          — "true" to enable MCP JSON-RPC detection
 *   MCP_PRODUCT_ID       — Aforo product ID for MCP metering
 *
 * Customer identity: the access-log entry's `customerId` field, which the
 * stage's access-log format must populate from `$context.authorizer.customerId`
 * (set by authorizer.js from the verified JWT's customer_id claim). Entries
 * without one are skipped — see README "Access-log format".
 *
 * Note: Margin guard enforcement is not possible here. This Lambda processes
 * CloudWatch Logs asynchronously and CANNOT block live requests. For
 * real-time L2/L3 enforcement, use margin-guard.js from a Lambda Authorizer.
 */

'use strict';

const https = require('https');
const http = require('http');
const zlib = require('zlib');

const AFORO_ENDPOINT = process.env.AFORO_ENDPOINT || '';
const AFORO_API_KEY = process.env.AFORO_API_KEY || '';
const DEFAULT_METRIC = process.env.DEFAULT_METRIC || 'api_calls';
// Route-shaped names ("GET /v1/users/42") are not catalog metrics, so the old
// '{method} {path}' default failed every batch. Only honoured when set.
const METRIC_NAME_PATTERN = process.env.METRIC_NAME_PATTERN || '';
const QUANTITY_SOURCE = process.env.QUANTITY_SOURCE || '1';
// The ingestor rejects a batch of more than 1000 events with 400 (the whole
// batch), so FLUSH_COUNT is clamped to that however it is configured.
const MAX_BATCH_EVENTS = 1000;
const FLUSH_COUNT = Math.min(MAX_BATCH_EVENTS,
    Math.max(1, parseInt(process.env.FLUSH_COUNT || '50', 10) || 50));
const INCLUDE_METADATA = process.env.INCLUDE_METADATA !== 'false';
const MCP_ENABLED = process.env.MCP_ENABLED === 'true';

const METRIC_MAPPINGS = parseMetricMappings(process.env.METRIC_MAPPINGS);

const EXCLUDE_PATHS = ['/health', '/ready', '/metrics', '/favicon.ico'];
const EXCLUDE_STATUS_CODES = [401, 403, 429];
const MAX_CUSTOMER_ID_LENGTH = 64;

// Per-attempt HTTP timeout, and how much of the Lambda's remaining time is
// held back so the handler can return (and report failure) before the
// platform kills it.
const REQUEST_TIMEOUT_MS = 10000;
const DEADLINE_SAFETY_MS = 1500;
const MAX_ATTEMPTS = 3;

/**
 * Parse METRIC_MAPPINGS. Invalid config is logged loudly and ignored rather
 * than crashing every invocation: events then resolve to DEFAULT_METRIC.
 */
function parseMetricMappings(raw) {
    if (!raw || !raw.trim()) return [];
    try {
        const rules = JSON.parse(raw);
        if (!Array.isArray(rules)) throw new Error('not a JSON array');
        return rules.filter((r) => {
            const ok = r && typeof r.value === 'string' && r.value !== ''
                && typeof r.metricName === 'string' && r.metricName !== ''
                && ['EXACT', 'PREFIX', 'CONTAINS'].includes(r.matchType || 'EXACT');
            if (!ok) console.error(`METRIC_MAPPINGS: ignoring invalid rule ${JSON.stringify(r)}`);
            return ok;
        });
    } catch (err) {
        console.error(`METRIC_MAPPINGS is not valid JSON (${err.message}) — all events will use DEFAULT_METRIC`);
        return [];
    }
}

function mappingMatches(path, rule) {
    if (!path) return false;
    const kind = rule.matchType || 'EXACT';
    if (kind === 'EXACT') return path === rule.value;
    if (kind === 'PREFIX') return path.startsWith(rule.value);
    if (kind === 'CONTAINS') return path.includes(rule.value);
    return false;
}

/**
 * Resolve the metric: METRIC_MAPPINGS (first match) → METRIC_NAME_PATTERN
 * (only if explicitly configured) → DEFAULT_METRIC.
 */
function resolveMetricName(parsed, mappings = METRIC_MAPPINGS,
                           pattern = METRIC_NAME_PATTERN, defaultMetric = DEFAULT_METRIC) {
    for (const rule of mappings) {
        if (mappingMatches(parsed.path, rule)) return rule.metricName;
    }
    if (pattern) {
        return pattern
            .replace('{method}', parsed.method || 'UNKNOWN')
            .replace('{path}', parsed.path || '/')
            .replace('{service}', parsed.stage || '')
            .replace('{route}', parsed.resource || '');
    }
    return defaultMetric;
}

/**
 * Build a usage event from a parsed log entry, or return { skip: reason }.
 * Exported for tests.
 */
function buildUsageEvent(parsed, logEvent) {
    if (EXCLUDE_PATHS.some(p => parsed.path && parsed.path.startsWith(p))) return { skip: 'excluded path' };
    if (EXCLUDE_STATUS_CODES.includes(parsed.status)) return { skip: 'excluded status' };

    // CORS preflights are a browser protocol detail, not a billable call, and
    // carry no Authorization header — so they can never have a customer.
    if ((parsed.method || '').toUpperCase() === 'OPTIONS') return { skip: 'OPTIONS' };

    // Customer identity comes only from the authorizer context
    // ($context.authorizer.customerId), which authorizer.js sets from the
    // verified JWT. Never the API key value (a secret) or the client IP.
    const customerId = (parsed.customerId || '').trim();
    if (!customerId) return { skip: 'no customerId' };
    if (customerId.length > MAX_CUSTOMER_ID_LENGTH) return { skip: 'customerId longer than 64 chars' };

    const headers = parsed.headers || {};
    const trace = {
        traceparent: headers['traceparent'] ?? null,
        tracestate: headers['tracestate'] ?? null,
        xTraceId: headers['x-trace-id'] ?? null,
        xRequestId: headers['x-request-id'] ?? null,
    };

    const usageEvent = {
        customerId,
        metricName: resolveMetricName(parsed),
        quantity: QUANTITY_SOURCE === 'response_size' ? (parsed.responseLength || 0) : 1,
        // requestId and the CloudWatch event id are both stable across Lambda
        // retries of the same log batch, so a re-sent event deduplicates.
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
    if (parsed.keyId) {
        // Billing-hierarchy attribution (same as the Kong plugin's metadata.keyId).
        usageEvent.metadata = usageEvent.metadata || {};
        usageEvent.metadata.keyId = parsed.keyId;
    }

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
            usageEvent.idempotencyKey = `mcp:${parsed.requestId || logEvent.id}:${mcpInfo.toolName}`;
        }
    }

    // The ingestor requires quantity > 0 and validates a batch as a whole, so
    // one zero-byte response (e.g. 204 with QUANTITY_SOURCE=response_size)
    // would fail every event batched with it.
    if (!(Number.isFinite(usageEvent.quantity) && usageEvent.quantity > 0)) return { skip: 'quantity <= 0' };

    return { event: usageEvent };
}

/**
 * Lambda handler — processes CloudWatch Logs events.
 */
async function handler(event, context) {
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
    const skipped = {};
    for (const logEvent of logEvents) {
        const parsed = parseAccessLog(logEvent.message);
        if (!parsed) { skipped['unparseable'] = (skipped['unparseable'] || 0) + 1; continue; }
        const result = buildUsageEvent(parsed, logEvent);
        if (result.skip) {
            skipped[result.skip] = (skipped[result.skip] || 0) + 1;
            continue;
        }
        usageEvents.push(result.event);
    }

    if (skipped['no customerId']) {
        console.warn(`Skipped ${skipped['no customerId']} entries with no customerId. The stage's access-log format ` +
            'must include "customerId":"$context.authorizer.customerId" and the route must use the Aforo authorizer.');
    }
    if (Object.keys(skipped).length > 0) console.log(`Skipped: ${JSON.stringify(skipped)}`);

    if (usageEvents.length === 0) {
        console.log('No usage events after filtering');
        return { statusCode: 200, body: 'No events after filtering' };
    }

    const batches = [];
    for (let i = 0; i < usageEvents.length; i += FLUSH_COUNT) {
        batches.push(usageEvents.slice(i, i + FLUSH_COUNT));
    }

    // All batches share one deadline and are sent concurrently, so a slow or
    // failing batch cannot consume the time the later ones needed.
    const remaining = context && typeof context.getRemainingTimeInMillis === 'function'
        ? context.getRemainingTimeInMillis() : 30000;
    const deadline = Date.now() + remaining - DEADLINE_SAFETY_MS;

    const results = await Promise.all(batches.map(b => sendToAforo(b, deadline)));

    let totalSent = 0;
    let dropped = 0;
    let transient = 0;
    results.forEach((r, i) => {
        if (r === 'sent') totalSent += batches[i].length;
        else if (r === 'rejected') dropped += batches[i].length;
        else transient += batches[i].length;
    });

    console.log(`Sent ${totalSent}/${usageEvents.length} events to Aforo`);

    if (transient > 0) {
        // Throw so Lambda's async-invocation retry (2 retries by default)
        // re-delivers this log batch. Every event carries a stable
        // idempotencyKey, so batches that already landed deduplicate.
        throw new Error(`${transient} event(s) not delivered after retries (transient failure) — failing the invocation so Lambda retries it`);
    }
    return { statusCode: 200, body: `Processed ${totalSent} events, dropped ${dropped} rejected` };
}

/**
 * Parse an API Gateway access log entry (JSON format required for billing;
 * the CLF fallback carries no customer identity and so never produces events).
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
            // "-" is what API Gateway logs for an unset $context variable.
            customerId: cleanContextValue(json.customerId ?? json['authorizer.customerId']),
            keyId: cleanContextValue(json.keyId ?? json['authorizer.keyId']),
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
            // CLF's first field is the client IP — never a customer id.
            customerId: '',
            keyId: '',
            headers: {},
            requestBody: null,
        };
    }

    return null;
}

function cleanContextValue(v) {
    if (v === undefined || v === null) return '';
    const s = String(v).trim();
    return s === '-' ? '' : s;
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

/** 4xx except 408/429 is a permanent rejection: retrying sends the same bytes to the same judgement. */
function isPermanentRejection(status) {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Send one batch. Returns 'sent', 'rejected' (permanent 4xx — dropped and
 * logged) or 'failed' (transient failure that outlived retries/deadline).
 */
async function sendToAforo(events, deadline) {
    const body = JSON.stringify({ events });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const timeLeft = deadline - Date.now();
        if (timeLeft <= 0) break;
        try {
            const res = await doPost(AFORO_ENDPOINT, body, Math.min(REQUEST_TIMEOUT_MS, timeLeft));
            if (res.status >= 200 && res.status < 300) {
                return 'sent';
            }
            if (isPermanentRejection(res.status)) {
                console.error(`Aforo rejected the batch with ${res.status} — dropping ${events.length} event(s). ` +
                    `Response: ${String(res.body || '').slice(0, 500)}`);
                return 'rejected';
            }
            console.warn(`Aforo returned ${res.status} — attempt ${attempt}/${MAX_ATTEMPTS}`);
        } catch (err) {
            console.warn(`Request failed — attempt ${attempt}/${MAX_ATTEMPTS}: ${err.message}`);
        }

        if (attempt < MAX_ATTEMPTS) {
            const backoff = Math.pow(2, attempt - 1) * 1000;
            if (Date.now() + backoff >= deadline) break;
            await sleep(backoff);
        }
    }

    console.error(`Batch of ${events.length} event(s) not delivered (transient failure or Lambda deadline)`);
    return 'failed';
}

function doPost(url, body, timeoutMs) {
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
                // X-API-Key ALONE. The ingestor's ApiKeyAuthFilter reads only
                // this header; an Authorization: Bearer is parsed as a JWT and
                // rejected 401 — alone or alongside. The tenant comes from the
                // key, so no X-Tenant-Id is sent.
                'X-API-Key': AFORO_API_KEY,
            },
            timeout: timeoutMs,
        };

        const transport = parsedUrl.protocol === 'https:' ? https : http;
        const req = transport.request(options, (res) => {
            let resBody = '';
            res.on('data', (chunk) => { if (resBody.length < 2000) resBody += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: resBody }));
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

// NOTE: a previous version assigned exports.handler and then replaced
// module.exports wholesale, so `index.handler` was undefined at runtime.
module.exports = {
    handler,
    parseAccessLog,
    detectMcpToolCall,
    buildUsageEvent,
    resolveMetricName,
    parseMetricMappings,
    isPermanentRejection,
    FLUSH_COUNT,
};
