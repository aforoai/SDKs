/**
 * Aforo Compound Metering Module for AWS Lambda (API Gateway integration)
 *
 * Extracts multiple metric measurements from API response bodies using JSONPath
 * and emits compound usage events to the Aforo usage ingestor service.
 *
 * Runs asynchronously after response is returned to client (zero latency impact).
 */

const crypto = require('crypto');
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

// ── Build compound event ──────────────────────────────────

function buildCompoundEvent(customerId, measurements, metadata) {
    if (!measurements || measurements.length === 0) return null;
    // Same rule as index.js: an event without an Aforo customer id can never
    // be accepted, so it is not built. Pass the authorizer's customerId.
    if (!customerId || String(customerId).length > 64) return null;
    return {
        correlationId: crypto.randomUUID(),
        customerId,
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
    buildCompoundEvent,
    flushCompoundEvents,
    DEFAULT_LLM_PATHS,
    DEFAULT_CDN_PATHS,
    DEFAULT_PAYMENT_PATHS,
    DEFAULT_DIMENSION_PATHS,
};
