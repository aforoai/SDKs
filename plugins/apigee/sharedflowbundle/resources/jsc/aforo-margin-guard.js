/**
 * Aforo Margin Guard Pre-Flight Check — Apigee JavaScript Callout
 *
 * Calls pricing-service /internal/v1/margin-guard/quick-check to determine
 * whether a request should be allowed, throttled (L2), or blocked (L3).
 *
 * Fail-open: if the check fails or times out, the request proceeds.
 *
 * Flow variables consumed:
 *   aforo.marginGuardEnabled — "true" to enable
 *   aforo.marginGuardUrl — pricing-service base URL
 *   aforo.tenantId — tenant identifier
 *   aforo.customerId — customer identifier (from consumer or header)
 *
 * Flow variables produced:
 *   aforo.marginGuard.blocked — "true" if L3 block
 *   aforo.marginGuard.throttled — "true" if L2 throttle (probabilistic, this request rejected)
 *   aforo.marginGuard.level — enforcement level (NONE, L1_ALERT, L2_THROTTLE, L3_BLOCK)
 *   aforo.marginGuard.retryAfterSeconds — seconds until retry
 *   aforo.marginGuard.message — human-readable message
 *   aforo.marginGuard.responseBody — JSON body for 429 response
 *
 * A downstream RaiseFault policy (AforoMarginGuardRaiseFault) checks these
 * variables and returns the appropriate 429 response.
 */

var marginGuardEnabled = context.getVariable('aforo.marginGuardEnabled');
var marginGuardUrl = context.getVariable('aforo.marginGuardUrl');
var tenantId = context.getVariable('aforo.tenantId');
var customerId = context.getVariable('aforo.customerId');

// Initialize output variables to safe defaults
context.setVariable('aforo.marginGuard.blocked', 'false');
context.setVariable('aforo.marginGuard.throttled', 'false');
context.setVariable('aforo.marginGuard.level', 'NONE');

if (marginGuardEnabled !== 'true' || !customerId || !tenantId || !marginGuardUrl) {
    // Not enabled or missing required context — skip
} else {
    var url = marginGuardUrl
        + '/internal/v1/margin-guard/quick-check'
        + '?tenantId=' + encodeURIComponent(tenantId)
        + '&scopeType=CUSTOMER'
        + '&scopeId=' + encodeURIComponent(customerId);

    try {
        var req = new Request(url, 'GET', {
            'Content-Type': 'application/json',
            'X-Tenant-Id': tenantId
        });

        var exchange = httpClient.send(req);
        exchange.waitForComplete(50); // 50ms timeout

        if (exchange.isSuccess()) {
            var response = exchange.getResponse();
            if (response.status === 200) {
                var result = JSON.parse(response.content);

                context.setVariable('aforo.marginGuard.level', result.level || 'NONE');

                if (!result.allowed) {
                    if (result.level === 'L3_BLOCK') {
                        var retryAfter = result.retryAfterSeconds || 1800;
                        context.setVariable('aforo.marginGuard.blocked', 'true');
                        context.setVariable('aforo.marginGuard.retryAfterSeconds', String(retryAfter));
                        context.setVariable('aforo.marginGuard.message',
                            result.message || 'Service restricted due to margin constraints.');
                        context.setVariable('aforo.marginGuard.responseBody', JSON.stringify({
                            error: {
                                code: 'SERVICE_RESTRICTED_MARGIN',
                                message: result.message || 'Service restricted due to margin constraints. Contact support.',
                                retryAfterSeconds: retryAfter,
                                supportUrl: '/portal/support'
                            }
                        }));
                    } else if (result.level === 'L2_THROTTLE') {
                        var throttleRate = result.throttleRate || 50;
                        var roll = Math.floor(Math.random() * 100);
                        if (roll >= throttleRate) {
                            // This request is throttled
                            context.setVariable('aforo.marginGuard.throttled', 'true');
                            context.setVariable('aforo.marginGuard.retryAfterSeconds', '60');
                            context.setVariable('aforo.marginGuard.message',
                                result.message || 'Rate limited due to margin constraints.');
                            context.setVariable('aforo.marginGuard.responseBody', JSON.stringify({
                                error: {
                                    code: 'RATE_LIMITED_MARGIN',
                                    message: result.message || 'Rate limited due to margin constraints. Please retry.',
                                    retryAfterSeconds: 60,
                                    dashboardUrl: '/portal/cost-explorer'
                                }
                            }));
                        }
                        // Else: allowed through within throttle percentage
                    }
                }
            }
            // Non-200: fail-open
        }
        // Timeout or failure: fail-open (variables already set to defaults)
    } catch (e) {
        // Any error: fail-open
        // Variables already set to safe defaults (blocked=false, throttled=false)
    }
}
