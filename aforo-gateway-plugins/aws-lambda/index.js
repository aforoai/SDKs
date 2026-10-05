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
 *   METRIC_NAME_PATTERN  — Route-shaped template ({method} {path} {service}
 *                          {route}). Used ONLY when explicitly set, for
 *                          requests no mapping matches; every resulting name
 *                          must be a catalog metric.
 *   DEFAULT_METRIC       — Metric for requests neither of the above names
 *                          (default "api_calls"). The ingestor rejects an
 *                          event whose metric is not in the Aforo catalog;
 *                          the Lambda cannot know the catalog.
 *   QUANTITY_SOURCE      — "1" (count) or "response_size"
 *   FLUSH_COUNT          — Max events per batch (default 50, capped at 1000 —
 *                          the ingestor rejects larger batches with 400)
 *   INCLUDE_METADATA     — "false" to omit request metadata
 *   MCP_ENABLED          — "true" to enable MCP JSON-RPC detection
 *   PRODUCT_TYPE         — productType sent on every event (default "API";
 *                          trimmed + upper-cased, unknown values passed
 *                          through). MCP tools/call with both toolName and
 *                          agentId is sent as MCP_SERVER; with PRODUCT_TYPE
 *                          = API, a request carrying a valid W3C traceparent
 *                          (or x-trace-id) is sent as AGENTIC_API.
 *   EXCLUDE_STATUS_CODES — Status codes that are NOT metered (default
 *                          "401,403,429"). A configured list replaces the
 *                          default; "" or "none" meters every status.
 *   STATUS_OUTCOMES      — Optional executionStatus overrides, e.g.
 *                          "404=VALIDATION_FAILED,429=ERROR". Exact HTTP codes
 *                          200-599 -> canonical outcome; invalid entries are
 *                          skipped with a warning; last duplicate wins. See
 *                          README "Execution status mapping".
 *   CUSTOMER_ID_SOURCE   — "consumer" (default): the authorizer's customerId,
 *                          then the IAM caller ($context.identity.caller).
 *                          "authorizer": the authorizer's customerId only.
 *   AFORO_TENANT_ID      — Optional. Never sent to the ingestor. Part of the
 *                          MCP idempotency key (kept so keys do not change
 *                          shape across an upgrade) and a property on the
 *                          EMF metrics.
 *
 * Customer identity: the access-log entry's `customerId` field, which the
 * stage's access-log format populates from `$context.authorizer.customerId`
 * (set by authorizer.js from the verified JWT's customer_id claim), or — for
 * IAM-authorized routes — `caller` from `$context.identity.caller`. Both are
 * set by API Gateway from a verified credential. The API key VALUE
 * ($context.identity.apiKey) is a secret and the client IP is not an
 * identity: neither is ever used. Entries without an identity are skipped —
 * see README "Access-log format".
 *
 * Delivery: a transient failure (network, 5xx, 408, 429) that outlives the
 * in-handler retries makes the handler THROW, so Lambda's async retry
 * redelivers the same log payload; idempotency keys are derived from log
 * data only, so the ingestor deduplicates. A permanent 4xx is dropped (logged
 * + EMF metric) without throwing — a redelivery would be rejected again.
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
// Never sent to the ingestor (the tenant comes from the API key). Kept only
// because it is part of the frozen MCP idempotency-key shape and an EMF
// property; unset is fine.
const AFORO_TENANT_ID = process.env.AFORO_TENANT_ID || '';
const DEFAULT_METRIC = process.env.DEFAULT_METRIC || 'api_calls';
// Route-shaped names ("GET /v1/users/42") are not catalog metrics, so the old
// '{method} {path}' default produced events the ingestor rejects. Only
// honoured when set.
const METRIC_NAME_PATTERN = process.env.METRIC_NAME_PATTERN || '';
const QUANTITY_SOURCE = process.env.QUANTITY_SOURCE || '1';
// The ingestor rejects a batch of more than 1000 events with 400 (the whole
// batch), so FLUSH_COUNT is clamped to that however it is configured.
const MAX_BATCH_EVENTS = 1000;
const FLUSH_COUNT = Math.min(MAX_BATCH_EVENTS,
    Math.max(1, parseInt(process.env.FLUSH_COUNT || '50', 10) || 50));
const INCLUDE_METADATA = process.env.INCLUDE_METADATA !== 'false';
const MCP_ENABLED = process.env.MCP_ENABLED === 'true';
const PRODUCT_TYPE = normalizeProductType(process.env.PRODUCT_TYPE);
const CUSTOMER_ID_SOURCE = normalizeCustomerIdSource(process.env.CUSTOMER_ID_SOURCE);

// Fields each productType must carry. An event missing them is rejected by
// the ingestor, so it is skipped here instead. An AI_AGENT agentId
// (X-Agent-Id is client-settable, never trusted) and gRPC / GraphQL /
// WebSocket / MQTT fields are not in an API Gateway access log, so those types
// are listed only so the check refuses them. Unknown types pass unchecked.
const PRODUCT_TYPE_REQUIRED_FIELDS = {
    API: [],
    AGENTIC_API: [],
    AI_AGENT: ['agentId', 'sessionId'],
    MCP_SERVER: ['toolName', 'agentId'],
    GRPC_API: ['grpcService', 'grpcMethod'],
    GRAPHQL_API: ['gqlOperationType'],
    WEBSOCKET_API: ['wsConnectionId'],
    MQTT_BROKER: ['mqttTopic'],
};
// Longest Retry-After (ms) honoured on a 429 before the next attempt.
const MAX_RETRY_AFTER_MS = 30000;

const METRIC_MAPPINGS = parseMetricMappings(process.env.METRIC_MAPPINGS);
const MAX_METRIC_NAME_LENGTH = 255;

const EXCLUDE_PATHS = ['/health', '/ready', '/metrics', '/favicon.ico'];

/**
 * Parse a comma-separated list of HTTP status codes ("401,403,429").
 * Unset -> the default. A configured list REPLACES the default; an empty
 * value ("") or "none" meters everything. Non-numeric entries are skipped.
 */
function parseStatusCodeList(raw, fallback) {
    if (raw === undefined || raw === null) return fallback;
    return String(raw).split(',')
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);
}

// Not metered by default (same default as Kong's exclude_status_codes).
// Remove a code here (EXCLUDE_STATUS_CODES env) to meter it; its
// executionStatus then follows the outcome table below (401/403/429 ->
// BLOCKED unless STATUS_OUTCOMES says otherwise).
const EXCLUDE_STATUS_CODES = parseStatusCodeList(process.env.EXCLUDE_STATUS_CODES, [401, 403, 429]);
const MAX_CUSTOMER_ID_LENGTH = 64;

// Per-attempt HTTP timeout, and how much of the Lambda's remaining time is
// held back so the handler can return (and report failure) before the
// platform kills it.
const REQUEST_TIMEOUT_MS = 10000;
const DEADLINE_SAFETY_MS = 1500;
const MAX_ATTEMPTS = 3;

/** Trim + upper-case a configured productType; "API" when unset or blank. */
function normalizeProductType(raw) {
    const v = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
    return v || 'API';
}

/**
 * "consumer" (default) or "authorizer". Anything else — including the
 * long-removed "header" — is treated as "authorizer", the narrower source,
 * with a warning: a client-settable header is never an identity.
 */
function normalizeCustomerIdSource(raw) {
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (v === '' || v === 'consumer') return 'consumer';
    if (v !== 'authorizer') {
        console.warn(`[aforo-metering] CUSTOMER_ID_SOURCE="${raw}" is not supported — using "authorizer"`);
    }
    return 'authorizer';
}

/**
 * Resolve the customer from VERIFIED identity only: the Aforo authorizer's
 * customerId, then (source "consumer") the IAM caller. Never the API key
 * value, a request header, or the client IP. Returns '' when there is none.
 */
function resolveCustomerId(parsed, source = CUSTOMER_ID_SOURCE) {
    const fromAuthorizer = (parsed.customerId || '').trim();
    if (fromAuthorizer) return fromAuthorizer;
    if (source === 'consumer') return (parsed.caller || '').trim();
    return '';
}

/**
 * Parse METRIC_MAPPINGS. Invalid config is logged loudly and ignored rather
 * than crashing every invocation: events then fall through to
 * METRIC_NAME_PATTERN / DEFAULT_METRIC.
 */
function parseMetricMappings(raw) {
    if (!raw || !raw.trim()) return [];
    try {
        const rules = JSON.parse(raw);
        if (!Array.isArray(rules)) throw new Error('not a JSON array');
        return rules.filter((r) => {
            const ok = r && typeof r.value === 'string' && r.value !== ''
                && typeof r.metricName === 'string' && r.metricName.trim() !== ''
                && ['EXACT', 'PREFIX', 'CONTAINS'].includes(r.matchType || 'EXACT');
            if (!ok) console.error(`METRIC_MAPPINGS: ignoring invalid rule ${JSON.stringify(r)}`);
            return ok;
        });
    } catch (err) {
        console.error(`METRIC_MAPPINGS is not valid JSON (${err.message}) — no mapping applies`);
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

const OUTCOME_STATUSES = new Set([
    'SUCCESS', 'PARTIAL', 'TIMEOUT', 'ERROR', 'VALIDATION_FAILED', 'FAILED',
    'FAILURE', 'CANCELLED', 'PENDING', 'BLOCKED', 'HITL_REQUIRED',
]);

/**
 * Parse a status→outcome override list: "404=VALIDATION_FAILED,429=ERROR".
 * Keys are exact HTTP codes 200-599; values are canonical statuses
 * (case-insensitive). Invalid entries are skipped with a warning so one
 * typo never disables metering.
 */
function parseStatusOutcomes(raw) {
    const map = {};
    if (!raw || typeof raw !== 'string') return map;
    for (const part of raw.split(',')) {
        const entry = part.trim();
        if (!entry) continue;
        const eq = entry.indexOf('=');
        const code = eq > 0 ? entry.slice(0, eq).trim() : '';
        const outcome = eq > 0 ? entry.slice(eq + 1).trim().toUpperCase() : '';
        if (!/^[2-5]\d\d$/.test(code) || !OUTCOME_STATUSES.has(outcome)) {
            console.warn(`[aforo-metering] STATUS_OUTCOMES: ignoring invalid entry "${entry}"`);
            continue;
        }
        map[code] = outcome;
    }
    return map;
}

const STATUS_OUTCOMES = parseStatusOutcomes(process.env.STATUS_OUTCOMES);

/**
 * Map the upstream HTTP status to the server's executionStatus value
 * space for OUTCOME_BASED pricing (each event billed at a per-status
 * weight; every other pricing model ignores the field). Shared rule —
 * identical in all five gateway plugins (README "Execution status mapping").
 * Default table (policy locked 2026-09-30):
 *   2xx/3xx -> SUCCESS, 408/504 -> TIMEOUT, 499 -> CANCELLED,
 *   400/422 -> VALIDATION_FAILED, 401/403/429 -> BLOCKED,
 *   every other 4xx and 5xx (404 included) -> ERROR,
 *   unknown / 0 / missing / non-numeric / 1xx / out of range -> undefined.
 * `overrides` (STATUS_OUTCOMES env) wins over the default for exact codes.
 * Callers MUST only set the field when the result is defined — never
 * send null or an empty string.
 */
function outcomeFromStatus(status, overrides = STATUS_OUTCOMES) {
    const s = Number(status);
    if (!Number.isFinite(s) || s < 200 || s > 599) return undefined;
    const code = Math.floor(s);
    if (overrides && typeof overrides === 'object') {
        const o = overrides[String(code)];
        if (typeof o === 'string' && OUTCOME_STATUSES.has(o.toUpperCase())) {
            return o.toUpperCase();
        }
    }
    if (code < 400) return 'SUCCESS';
    if (code === 408 || code === 504) return 'TIMEOUT';
    if (code === 499) return 'CANCELLED';
    if (code === 400 || code === 422) return 'VALIDATION_FAILED';
    if (code === 401 || code === 403 || code === 429) return 'BLOCKED';
    return 'ERROR';
}

/**
 * Detect AGENTIC_API from W3C trace context.
 *
 * Per descriptor eventSchema.inferenceRule = HAS_TRACE (agentic_api.json),
 * a request with a resolvable trace id classifies as AGENTIC_API.
 * Preferred source is the W3C traceparent header (parsed for its 32-hex
 * trace_id field); fallback is x-trace-id per descriptor
 * tracing.allowFallback = true (non-OTel callers). MCP JSON-RPC still
 * wins the productType when both signals are present — the handler
 * checks MCP first and only consults this helper afterwards when
 * productType is still unset. Malformed traceparent falls through
 * cleanly; never invent a productType from an unparseable header.
 *
 * @param {Object|null} trace Trace-context object with .traceparent + .xTraceId.
 * @returns {string|null} 32-hex trace_id (lowercased) or trimmed x-trace-id,
 *                        or null when no signal is present or valid.
 */
function extractAgenticTraceId(trace) {
    if (!trace) return null;

    if (trace.traceparent) {
        // W3C format: version-trace_id-parent_id-flags (hex widths 2-32-16-2).
        // Invalid per spec: version=="ff", trace_id all zeros, parent_id all zeros.
        const parts = String(trace.traceparent).split('-');
        if (parts.length === 4 &&
            /^[0-9a-f]{2}$/i.test(parts[0]) && parts[0].toLowerCase() !== 'ff' &&
            /^[0-9a-f]{32}$/i.test(parts[1]) && !/^0+$/.test(parts[1]) &&
            /^[0-9a-f]{16}$/i.test(parts[2]) && !/^0+$/.test(parts[2]) &&
            /^[0-9a-f]{2}$/i.test(parts[3])) {
            return parts[1].toLowerCase();
        }
    }

    if (trace.xTraceId) {
        // Non-OTel fallback. Descriptor types trace_id as String, not UUID —
        // no shape check beyond non-empty after trim.
        const trimmed = String(trace.xTraceId).trim();
        if (trimmed.length > 0) {
            return trimmed;
        }
    }

    return null;
}

/**
 * Build a usage event from a parsed log entry, or return { skip: reason }.
 * Everything in the event — idempotencyKey included — is derived from the
 * log entry alone, so a redelivered log payload rebuilds identical events.
 */
function buildUsageEvent(parsed, logEvent) {
    if (EXCLUDE_PATHS.some(p => parsed.path && parsed.path.startsWith(p))) return { skip: 'excluded path' };
    if (EXCLUDE_STATUS_CODES.includes(parsed.status)) return { skip: 'excluded status' };

    // CORS preflights are a browser protocol detail, not a billable call, and
    // carry no Authorization header — so they can never have a customer.
    if ((parsed.method || '').toUpperCase() === 'OPTIONS') return { skip: 'OPTIONS' };

    const customerId = resolveCustomerId(parsed);
    if (!customerId) return { skip: 'no customerId' };
    if (customerId.length > MAX_CUSTOMER_ID_LENGTH) return { skip: 'customerId longer than 64 chars' };

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
        metricName: resolveMetricName(parsed),
        quantity: QUANTITY_SOURCE === 'response_size' ? (parsed.responseLength || 0) : 1,
        // requestId and the CloudWatch event id are both stable across Lambda
        // retries of the same log batch, so a re-sent event deduplicates.
        idempotencyKey: parsed.requestId || `${logEvent.id}`,
        occurredAt: new Date(logEvent.timestamp).toISOString(),
        productType: PRODUCT_TYPE,
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

    let isMcp = false;
    if (MCP_ENABLED && parsed.method === 'POST' && parsed.requestBody) {
        const mcpInfo = detectMcpToolCall(parsed.requestBody);
        if (mcpInfo) {
            isMcp = true;
            usageEvent.metricName = 'mcp_server.tool_invocations';
            usageEvent.quantity = 1;
            usageEvent.toolName = mcpInfo.toolName;
            usageEvent.agentId = mcpInfo.agentId;
            // MCP_SERVER requires toolName AND agentId: classify as MCP_SERVER
            // only when both are known, otherwise keep PRODUCT_TYPE rather
            // than send an event the ingestor must reject.
            if (usageEvent.toolName && usageEvent.agentId) usageEvent.productType = 'MCP_SERVER';
            usageEvent.executionDurationMs = parsed.latency || 0;
            // FROZEN key shape (log data + the static tenant setting only).
            // Changing it would double-bill retries in flight across an
            // upgrade. The CloudWatch event id stands in when the log format
            // has no requestId, so two such entries never share a key.
            usageEvent.idempotencyKey =
                `mcp:${AFORO_TENANT_ID}:${parsed.requestId || logEvent.id}:${mcpInfo.toolName}:${logEvent.timestamp}`;
        }
    }

    // AGENTIC_API classification — only when a trace id is resolvable
    // (descriptor eventSchema.inferenceRule = HAS_TRACE), MCP has not claimed
    // the event, and the configured type is the baseline API: an operator who
    // set PRODUCT_TYPE to anything else has already said what these calls
    // are. traceId goes top-level (the ingestor reads descriptor
    // requiredFields from the top level, not from metadata).
    if (!isMcp && usageEvent.productType === 'API') {
        const agenticTraceId = extractAgenticTraceId(trace);
        if (agenticTraceId) {
            usageEvent.productType = 'AGENTIC_API';
            usageEvent.traceId = agenticTraceId;
        }
    }

    // Outcome for OUTCOME_BASED pricing — every event path (standard API,
    // AGENTIC_API, MCP). Omitted when the status is not determinable.
    // CloudWatch access logs carry no response body, so a JSON-RPC `error`
    // inside a 2xx cannot be detected here.
    const executionStatus = outcomeFromStatus(parsed.status);
    if (executionStatus) usageEvent.executionStatus = executionStatus;

    // The Lambda cannot know the catalog, but a blank or oversized name can
    // never be a metric: drop it here rather than have the ingestor reject it.
    const metricName = typeof usageEvent.metricName === 'string' ? usageEvent.metricName.trim() : '';
    if (!metricName || metricName.length > MAX_METRIC_NAME_LENGTH) {
        console.warn(`[aforo-metering] dropping event for ${parsed.method} ${parsed.path}: ` +
            `metric name is ${metricName ? 'longer than 255 chars' : 'empty'}`);
        return { skip: 'invalid metricName' };
    }
    usageEvent.metricName = metricName;

    // The ingestor requires quantity > 0 (e.g. a 204 with
    // QUANTITY_SOURCE=response_size has none).
    if (!(Number.isFinite(usageEvent.quantity) && usageEvent.quantity > 0)) return { skip: 'quantity <= 0' };

    const required = PRODUCT_TYPE_REQUIRED_FIELDS[usageEvent.productType] || [];
    const missing = required.filter(f => usageEvent[f] === undefined || usageEvent[f] === null || usageEvent[f] === '');
    if (missing.length > 0) return { skip: `productType ${usageEvent.productType} missing ${missing.join('+')}` };

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
            'must include "customerId":"$context.authorizer.customerId" and the route must use the Aforo authorizer ' +
            '(or, for IAM-authorized routes, "caller":"$context.identity.caller").');
    }
    if (skipped['invalid metricName']) {
        emitMetric('EventsDroppedInvalidMetric', skipped['invalid metricName'], logEvents.length);
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
        const size = batches[i].length;
        if (r.outcome === 'sent') {
            const rejected = Math.min(size, r.rejectedEvents || 0);
            totalSent += size - rejected;
            dropped += rejected;
        } else if (r.outcome === 'rejected') {
            dropped += size;
        } else {
            transient += size;
        }
    });

    console.log(`Sent ${totalSent}/${usageEvents.length} events to Aforo`);

    if (dropped > 0) {
        // Permanent rejection: the ingestor judged these bytes and said no, so
        // a redelivery would be rejected again. Counted, never retried.
        emitMetric('EventsRejected', dropped, usageEvents.length);
    }

    if (transient > 0) {
        // Emit the failure metric BEFORE throwing so every failed invocation
        // is alarmable, not just the terminal one.
        emitMetric('EventsFailedToSend', transient, usageEvents.length);

        // SAFETY BASIS for throwing: every idempotencyKey is derived purely
        // from CloudWatch log DATA — `parsed.requestId || logEvent.id` for
        // standard events, plus toolName + logEvent.timestamp (and the static
        // tenant setting) for MCP events. NOTHING time-of-execution feeds a
        // key. Lambda's async retry re-invokes this handler with the
        // IDENTICAL awslogs payload, so the rebuilt events carry
        // byte-identical keys and the ingest layer dedups them — a redelivery
        // (including batches that already landed in this invocation) CANNOT
        // double-bill.
        //
        // Returning 200 here would tell Lambda "success" and turn a
        // recoverable ingest blip into permanent silent loss. Throwing hands
        // the events back to the async retry (and, when retries exhaust, to
        // the OnFailure destination configured in template.yaml).
        throw new Error(
            `Aforo ingest failed for ${transient}/${usageEvents.length} events after in-handler retries ` +
            '(transient failure) — throwing so Lambda redelivers (dedup-safe: idempotency keys are stable across redelivery)'
        );
    }

    return { statusCode: 200, body: `Processed ${totalSent} events, dropped ${dropped} rejected` };
}

/**
 * Emit a CloudWatch custom metric via Embedded Metric Format (EMF).
 *
 * EMF is a structured console.log — CloudWatch extracts the metric from
 * the log stream automatically, so this needs no SDK dependency and no
 * extra IAM permission. Namespace Aforo/Metering, dimension Gateway:
 *   EventsFailedToSend         — transient failure; fires before each throw.
 *                                The TERMINAL signal (async retries also
 *                                exhausted) is the OnFailure SQS queue depth.
 *   EventsRejected             — dropped after a permanent 4xx, or rejected
 *                                per event inside an accepted batch.
 *   EventsDroppedInvalidMetric — metric name empty or longer than 255 chars.
 *
 * Never throws: a metrics failure must not mask or replace the real
 * delivery failure being reported.
 */
function emitMetric(name, count, totalCount) {
    try {
        const record = {
            _aws: {
                Timestamp: Date.now(),
                CloudWatchMetrics: [{
                    Namespace: 'Aforo/Metering',
                    Dimensions: [['Gateway']],
                    Metrics: [{ Name: name, Unit: 'Count' }],
                }],
            },
            Gateway: 'aws-api-gateway',
            TotalEventsInInvocation: totalCount,
        };
        if (AFORO_TENANT_ID) record.TenantId = AFORO_TENANT_ID;
        record[name] = count;
        console.log(JSON.stringify(record));
    } catch (err) {
        console.error(`Failed to emit EMF metric ${name}: ${err.message}`);
    }
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
            // $context.identity.caller — the IAM principal API Gateway
            // verified (SigV4). $context.identity.apiKey (the key VALUE, a
            // secret) and $context.authorizer.principalId (a placeholder
            // when the token has no customer) are deliberately not read.
            caller: cleanContextValue(json.caller ?? json['identity.caller']),
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
            caller: '',
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
 * Per-event rejections inside an accepted batch. The ingestor wraps every 2xx
 * as { success, data, meta }; data carries { accepted, duplicates, failed,
 * errors: [{ index, message }] }. Returns the failed count (0 when the body
 * is absent or not that shape) and logs the reasons.
 */
function countRejectedEvents(resBody, events) {
    if (!resBody) return 0;
    let data;
    try {
        const json = JSON.parse(resBody);
        data = json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : json;
    } catch {
        return 0;
    }
    if (!data || typeof data !== 'object') return 0;
    const errors = Array.isArray(data.errors) ? data.errors : [];
    const failed = Number.isInteger(data.failed) && data.failed > 0 ? data.failed : errors.length;
    if (failed > 0) {
        const detail = errors.slice(0, 10).map((e) => {
            const ev = events[e && e.index];
            return `#${e && e.index}${ev ? ` (${ev.metricName})` : ''}: ${e && e.message}`;
        }).join('; ');
        console.error(`Aforo accepted the batch but rejected ${failed} event(s) — dropped. ${detail}`);
    }
    return failed;
}

/**
 * Send one batch. Resolves to { outcome, rejectedEvents }:
 *   'sent'     — 2xx (rejectedEvents = events the ingestor refused individually)
 *   'rejected' — permanent 4xx; dropped and logged, never retried
 *   'failed'   — transient failure that outlived the retries or the deadline
 * The body is serialized ONCE, so every attempt carries the same idempotency
 * keys.
 */
async function sendToAforo(events, deadline) {
    const body = JSON.stringify({ events });
    let retryAfterMs = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const timeLeft = deadline - Date.now();
        if (timeLeft <= 0) break;
        try {
            const res = await doPost(AFORO_ENDPOINT, body, Math.min(REQUEST_TIMEOUT_MS, timeLeft));
            if (res.status >= 200 && res.status < 300) {
                return { outcome: 'sent', rejectedEvents: countRejectedEvents(res.body, events) };
            }
            if (isPermanentRejection(res.status)) {
                console.error(`Aforo rejected the batch with ${res.status} — dropping ${events.length} event(s). ` +
                    `Response: ${String(res.body || '').slice(0, 500)}`);
                return { outcome: 'rejected' };
            }
            console.warn(`Aforo returned ${res.status} — attempt ${attempt}/${MAX_ATTEMPTS}`);
            retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers && res.headers['retry-after']) : null;
        } catch (err) {
            console.warn(`Request failed — attempt ${attempt}/${MAX_ATTEMPTS}: ${err.message}`);
            retryAfterMs = null;
        }

        if (attempt < MAX_ATTEMPTS) {
            // Honour Retry-After on 429; a wait longer than the cap (or the
            // Lambda deadline) ends the attempts and fails the batch
            // transiently, so Lambda's async retry re-delivers it later.
            if (retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS) break;
            const backoff = retryAfterMs !== null ? retryAfterMs : Math.pow(2, attempt - 1) * 1000;
            if (Date.now() + backoff >= deadline) break;
            await sleep(backoff);
        }
    }

    // Not "dropped" — the handler throws when any batch fails transiently, so
    // Lambda redelivers the whole invocation (dedup-safe; see the safety-basis
    // comment in the handler).
    console.error(`Batch of ${events.length} event(s) not delivered (transient failure or Lambda deadline) — ` +
        'the invocation will be redelivered');
    return { outcome: 'failed' };
}

/** Retry-After in delta-seconds or HTTP-date form → ms, or null. */
function parseRetryAfter(value) {
    if (value === undefined || value === null || value === '') return null;
    const secs = Number(value);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

// Enough of a response to read the per-event errors of a 1000-event batch
// without buffering an unbounded body.
const MAX_RESPONSE_BYTES = 262144;

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
            res.on('data', (chunk) => { if (resBody.length < MAX_RESPONSE_BYTES) resBody += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: resBody }));
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

// `Handler: index.handler` (template.yaml) resolves against module.exports,
// so `handler` MUST be a property of whatever is assigned here. An earlier
// version set exports.handler and then replaced module.exports wholesale,
// which left index.handler undefined at runtime.
module.exports = {
    handler,
    parseAccessLog,
    detectMcpToolCall,
    buildUsageEvent,
    resolveMetricName,
    resolveCustomerId,
    parseMetricMappings,
    isPermanentRejection,
    parseRetryAfter,
    countRejectedEvents,
    normalizeProductType,
    normalizeCustomerIdSource,
    extractAgenticTraceId,
    outcomeFromStatus,
    parseStatusOutcomes,
    parseStatusCodeList,
    FLUSH_COUNT,
};
