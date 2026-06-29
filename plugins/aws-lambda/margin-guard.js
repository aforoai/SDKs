/**
 * Aforo Margin Guard Pre-Flight Check for AWS API Gateway (Lambda)
 *
 * Calls pricing-service /internal/v1/margin-guard/quick-check endpoint.
 * Fail-open: if the check times out or fails, the request proceeds.
 *
 * Environment variables:
 *   MARGIN_GUARD_ENABLED: "true" to enable (default: "false")
 *   MARGIN_GUARD_URL: pricing-service base URL (e.g. http://pricing:8083)
 *   MARGIN_GUARD_CACHE_TTL_MS: cache TTL in milliseconds (default: 30000)
 *
 * Note: This module is designed for use in an API Gateway Lambda Authorizer
 * or custom integration. The CloudWatch Logs trigger Lambda (index.js) runs
 * asynchronously and cannot block requests. For real-time enforcement, deploy
 * this as a separate Lambda Authorizer.
 */

'use strict';

// In-memory cache for Lambda warm starts
const marginGuardCache = {};

/**
 * Check margin guard status for a customer.
 *
 * @param {string} tenantId
 * @param {string} customerId
 * @param {object} config - { marginGuardEnabled, marginGuardUrl, marginGuardCacheTtlMs }
 * @returns {Promise<{allowed: boolean, level: string, throttleRate?: number, retryAfterSeconds?: number, message?: string}>}
 */
async function checkMarginGuard(tenantId, customerId, config) {
    if (!config.marginGuardEnabled) {
        return { allowed: true, level: 'NONE' };
    }
    if (!customerId || !tenantId) {
        return { allowed: true, level: 'NONE' };
    }

    // Check in-memory cache (Lambda warm start)
    const cacheKey = `mg:${tenantId}:${customerId}`;
    const cached = marginGuardCache[cacheKey];
    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }

    try {
        const url = `${config.marginGuardUrl}/internal/v1/margin-guard/quick-check`
            + `?tenantId=${encodeURIComponent(tenantId)}`
            + `&scopeType=CUSTOMER`
            + `&scopeId=${encodeURIComponent(customerId)}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
            signal: AbortSignal.timeout(50), // 50ms timeout, fail-fast
        });

        if (!response.ok) {
            console.warn(`[aforo-margin-guard] Non-200 response: ${response.status} → fail-open ALLOW`);
            return { allowed: true, level: 'NONE' };
        }

        const result = await response.json();

        // Cache for configured TTL
        const ttl = config.marginGuardCacheTtlMs || 30000;
        marginGuardCache[cacheKey] = { data: result, expiresAt: Date.now() + ttl };

        return result;
    } catch (e) {
        // Timeout or network error → fail-open
        console.warn(`[aforo-margin-guard] Check failed: ${e.message} → fail-open ALLOW`);
        return { allowed: true, level: 'NONE' };
    }
}

/**
 * Build a 429 response for margin guard enforcement.
 *
 * @param {object} result - Quick-check result
 * @returns {object|null} - API Gateway response object if blocked/throttled, null if allowed
 */
function buildEnforcementResponse(result) {
    if (result.allowed) {
        return null; // Proceed normally
    }

    const level = result.level || 'NONE';

    if (level === 'L3_BLOCK') {
        return {
            statusCode: 429,
            headers: {
                'Content-Type': 'application/json',
                'X-Margin-Guard': 'blocked',
                'X-Margin-Guard-Level': 'L3',
                'Retry-After': String(result.retryAfterSeconds || 1800),
            },
            body: JSON.stringify({
                error: {
                    code: 'SERVICE_RESTRICTED_MARGIN',
                    message: result.message || 'Service restricted due to margin constraints. Contact support.',
                    retryAfterSeconds: result.retryAfterSeconds || 1800,
                    supportUrl: '/portal/support',
                },
            }),
        };
    }

    if (level === 'L2_THROTTLE') {
        const throttleRate = result.throttleRate || 50;
        const roll = Math.floor(Math.random() * 100);
        if (roll >= throttleRate) {
            // This request is throttled
            return {
                statusCode: 429,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Margin-Guard': 'throttled',
                    'X-Margin-Guard-Level': 'L2',
                    'Retry-After': '60',
                },
                body: JSON.stringify({
                    error: {
                        code: 'RATE_LIMITED_MARGIN',
                        message: result.message || 'Rate limited due to margin constraints. Please retry.',
                        retryAfterSeconds: 60,
                        dashboardUrl: '/portal/cost-explorer',
                    },
                }),
            };
        }
        // Allowed through within the throttle percentage
    }

    return null; // L1_ALERT or NONE → proceed
}

module.exports = { checkMarginGuard, buildEnforcementResponse };
