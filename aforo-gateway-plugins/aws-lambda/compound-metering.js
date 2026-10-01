/**
 * Aforo Compound Metering Module for AWS Lambda (API Gateway integration)
 *
 * Extracts multiple metric measurements from API response bodies using JSONPath
 * and emits compound usage events to the Aforo usage ingestor service.
 *
 * Runs asynchronously after response is returned to client (zero latency impact).
 */

const crypto = require('node:crypto');
const https = require('https');

// ── JSONPath-lite: dotted path resolution ──────────────────

function resolveJsonPath(obj, path) {
    if (!obj || !path) return undefined;
    const clean = path.startsWith('$.') ? path.slice(2) : path;
    let current = obj;
    for (const segment of clean.split('.')) {
        if (current == null) return undefined;
        // Handle array index: segment[0]
        const match = segment.match(/^(.+)\[(\d+)\]$/);
        if (match) {
            current = current[match[1]];
            if (Array.isArray(current)) {
                current = current[parseInt(match[2])];
            } else {
                return undefined;
            }
        } else {
            current = current[segment];
        }
    }
    return current;
}

// ── Extract measurements from response body ────────────────

function extractMeasurements(responseBody, extractionPaths, dimensionPaths) {
    if (!responseBody) return null;

    let parsed;
    try {
        parsed = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
    } catch (e) {
        console.log('[aforo-compound] Response body is not valid JSON, skipping');
        return null;
    }

    const measurements = [];
    for (const [jsonPath, metricName] of Object.entries(extractionPaths || {})) {
        const value = resolveJsonPath(parsed, jsonPath);
        if (typeof value === 'number' && value > 0) {
            const measurement = { metricName, quantity: value };
            // Extract optional dimension
            if (dimensionPaths) {
                for (const [dimPath, dimKey] of Object.entries(dimensionPaths)) {
                    const dimValue = resolveJsonPath(parsed, dimPath);
                    if (typeof dimValue === 'string' && dimValue) {
                        measurement.dimensionKey = dimValue;
                        break;
                    }
                }
            }
            measurements.push(measurement);
        }
    }

    return measurements.length > 0 ? measurements : null;
}

// ── Deterministic correlationId (FROZEN — A+ compound-key freeze, 2026-07-05) ──
//
// Dedup-safety basis: the server types correlationId as a UUID and
// CompoundEventDecomposer derives EVERY per-metric dedup key from it —
//   correlationId:metricName[:dimensionKey]:index
// — so the correlationId is the dedup ROOT for the whole compound event.
// Prompt 3 made this Lambda throw on ingest failure so CloudWatch
// re-invokes it with the IDENTICAL awslogs payload (see index.js "SAFETY
// BASIS"). The pre-freeze uuidv4() here minted a NEW id per invocation,
// so a redelivered compound event decomposed to NEW keys → double-billing.
// Now the id is derived purely from the caller's stable seed (log DATA:
// `parsed.requestId || logEvent.id` — the same identity the standard
// idempotencyKey was frozen to in prompt 3), so a redelivery rebuilds a
// byte-identical correlationId and the ingest dedups it.
// NEVER put a clock or random component back into this derivation.
function deriveCorrelationId(seed) {
    const hex = crypto.createHash('md5')
        .update('aforo-compound:' + seed)
        .digest('hex');
    // Format as an RFC-4122 v3-style UUID (version nibble 3, variant 10xx)
    // so the server's UUID-typed correlationId field parses it.
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) +
        '-3' + hex.slice(13, 16) +
        '-' + variant + hex.slice(17, 20) +
        '-' + hex.slice(20, 32);
}

// ── Build compound event ──────────────────────────────────

// productType values the 2.1.0 signature accepted as the 4th argument.
const KNOWN_PRODUCT_TYPES = new Set([
    'API', 'AGENTIC_API', 'AI_AGENT', 'MCP_SERVER',
    'GRPC_API', 'GRAPHQL_API', 'WEBSOCKET_API', 'MQTT_BROKER',
]);

/**
 * buildCompoundEvent(customerId, measurements, metadata, correlationSeed, productType)
 *
 * correlationSeed — the request's stable identity (parsed.requestId ||
 *   logEvent.id). It is the dedup root for the whole compound event.
 * productType — defaults to the PRODUCT_TYPE env, then "API".
 *
 * The 4th argument may also be an options object { correlationSeed,
 * productType }. For callers written against 2.1.0, whose 4th argument was
 * the productType: a 4th argument that is exactly a known productType, with
 * no 5th argument, is read as the productType — never as a seed (one seed
 * shared by every event would dedup them all into one).
 */
function buildCompoundEvent(customerId, measurements, metadata, correlationSeed, productType) {
    if (!measurements || measurements.length === 0) return null;
    // Same rule as index.js: an event without an Aforo customer id can never
    // be accepted, so it is not built. Pass the authorizer's customerId —
    // never an API key value or a client IP.
    if (!customerId || String(customerId).length > 64) return null;

    if (correlationSeed && typeof correlationSeed === 'object') {
        productType = productType || correlationSeed.productType;
        correlationSeed = correlationSeed.correlationSeed;
    } else if (productType === undefined && typeof correlationSeed === 'string'
            && KNOWN_PRODUCT_TYPES.has(correlationSeed.trim().toUpperCase())) {
        productType = correlationSeed;
        correlationSeed = undefined;
    }

    // Stable-identity preference: explicit caller seed > requestId already
    // present in metadata > one-time random LAST RESORT. The random path is a
    // dedup opt-out for that single event — a redelivery of it CAN
    // double-bill, so callers on a retrying transport MUST pass a seed.
    const seed = correlationSeed || (metadata && metadata.requestId);
    if (!seed) {
        console.warn('[aforo-compound] No stable seed for correlationId — ' +
            'random fallback is NOT redelivery-safe. Pass the log-derived ' +
            'identity (parsed.requestId || logEvent.id) as the 4th argument.');
    }
    const type = String(productType || process.env.PRODUCT_TYPE || 'API').trim().toUpperCase() || 'API';
    return {
        correlationId: seed ? deriveCorrelationId(String(seed)) : crypto.randomUUID(),
        customerId,
        productType: type,
        occurredAt: new Date().toISOString(),
        metadata,
        measurements,
    };
}

// ── Async flush to Aforo compound batch endpoint ──────────

async function flushCompoundEvents(events, config) {
    if (!events || events.length === 0) return;

    const payload = JSON.stringify({ events });
    // aforoEndpoint is normally the full batch URL (…/v1/ingest/batch), so the
    // compound path is built from its origin, not appended to it.
    const url = new URL(config.compoundBatchEndpoint ||
        `${new URL(config.aforoEndpoint).origin}/api/v1/ingest/compound/batch`);

    const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // X-API-Key alone: Bearer is parsed as a JWT and rejected 401.
            // The tenant comes from the key, so no X-Tenant-Id is sent.
            'X-API-Key': config.apiKey,
            'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 5000,
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', (err) => {
            console.warn('[aforo-compound] Flush failed:', err.message);
            resolve(null); // fire-and-forget
        });
        req.on('timeout', () => {
            req.destroy();
            console.warn('[aforo-compound] Flush timeout');
            resolve(null);
        });
        req.write(payload);
        req.end();
    });
}

// ── Default extraction paths ──────────────────────────────

const DEFAULT_LLM_PATHS = {
    '$.usage.prompt_tokens': 'input-tokens',
    '$.usage.completion_tokens': 'output-tokens',
    '$.usage.total_tokens': 'total-tokens',
};

const DEFAULT_CDN_PATHS = {
    '$.bandwidth.in_bytes': 'bandwidth-in-gb',
    '$.bandwidth.out_bytes': 'bandwidth-out-gb',
    '$.compute.seconds': 'compute-seconds',
    '$.request_count': 'request-count',
};

const DEFAULT_PAYMENT_PATHS = {
    '$.transaction.amount': 'transaction-amount',
    '$.transaction.fee_percent': 'fee-percentage',
    '$.transaction.fee_fixed': 'fee-fixed',
};

const DEFAULT_DIMENSION_PATHS = {
    '$.model': 'model-name',
    '$.region': 'region',
};

module.exports = {
    resolveJsonPath,
    extractMeasurements,
    deriveCorrelationId,
    buildCompoundEvent,
    flushCompoundEvents,
    DEFAULT_LLM_PATHS,
    DEFAULT_CDN_PATHS,
    DEFAULT_PAYMENT_PATHS,
    DEFAULT_DIMENSION_PATHS,
};
