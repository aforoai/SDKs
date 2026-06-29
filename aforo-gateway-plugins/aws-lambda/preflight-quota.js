/**
 * Aforo Pre-Flight Quota Check for AWS Lambda (API Gateway integration)
 *
 * Called in the authorizer or pre-invoke phase. Synchronous check against
 * the usage-ingestor /api/v1/quota/check endpoint.
 * Fail-open: if the check times out or fails, the request proceeds.
 */

const https = require('https');

/**
 * Check pre-flight quota for a customer.
 *
 * @param {Object} config - { preflightUrl, tenantId, apiKey, timeoutMs, fallback }
 * @param {string} customerId - Customer identifier
 * @param {string} [metricName] - Optional metric name
 * @returns {Promise<{decision: string, reason?: string, headers?: Object}>}
 */
async function checkPreFlightQuota(config, customerId, metricName) {
    if (!config.preflightEnabled) return { decision: 'ALLOW' };
    if (!customerId) return { decision: 'ALLOW' };

    const fallback = config.preflightFallback || 'ALLOW';
    const payload = JSON.stringify({ customerId, metricName });
    const url = new URL(config.preflightUrl);

    const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Id': config.tenantId,
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Length': Buffer.byteLength(payload),
        },
        timeout: config.timeoutMs || 50,
    };

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const data = parsed.data || parsed;
                    resolve(data);
                } catch (e) {
                    console.warn('[aforo-preflight] Parse error:', e.message);
                    resolve({ decision: fallback });
                }
            });
        });

        req.on('error', (err) => {
            console.warn('[aforo-preflight] Request error:', err.message);
            resolve({ decision: fallback });
        });

        req.on('timeout', () => {
            req.destroy();
            console.warn('[aforo-preflight] Timeout');
            resolve({ decision: fallback });
        });

        req.write(payload);
        req.end();
    });
}

/**
 * Build a 429 response for API Gateway Lambda proxy integration.
 */
function build429Response(data) {
    const retryAfter = data.retryAfterMs ? Math.floor(data.retryAfterMs / 1000) : 60;
    const headers = {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        ...(data.headers || {}),
    };

    return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
            message: data.reason || 'Rate limit exceeded',
            retryAfter,
        }),
    };
}

module.exports = { checkPreFlightQuota, build429Response };
