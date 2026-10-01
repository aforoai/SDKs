/**
 * Aforo Margin Guard Pre-Flight Check — Apigee JavaScript Callout
 *
 * Calls pricing-service /internal/v1/margin-guard/quick-check to determine
 * whether a request should be allowed, throttled (L2), or blocked (L3).
 *
 * Fail-open: if the check fails or times out, the request proceeds.
 *
 * Flow variables consumed:
 *   private.aforo.marginGuardEnabled — "true" to enable (KVM margin_guard_enabled)
 *   private.aforo.marginGuardUrl — pricing-service base URL (KVM margin_guard_url)
 *     (each also read from the non-private aforo.* name when unset)
 *   aforo.tenant_id — tenant from the verified JWT, else private.aforo.tenantId (KVM tenant_id)
 *   aforo.customer_id — customer from the verified JWT (VerifyJWT output claim),
 *     else aforo.customerId when the proxy sets it
 *
 * Flow variables produced:
 *   aforo.marginGuard.blocked — "true" if L3 block
 *   aforo.marginGuard.throttled — "true" if L2 throttle (probabilistic, this request rejected)
 *   aforo.marginGuard.header — "blocked" | "throttled" (X-Margin-Guard header value)
 *   aforo.marginGuard.level — enforcement level (NONE, L1_ALERT, L2_THROTTLE, L3_BLOCK)
 *   aforo.marginGuard.retryAfterSeconds — seconds until retry
 *   aforo.marginGuard.message — human-readable message
 *   aforo.marginGuard.responseBody — JSON body for 429 response
 *
 * A downstream RaiseFault policy (AforoMarginGuardRaiseFault) checks these
 * variables and returns the appropriate 429 response.
 */

function mgSetting(name) {
    var v = context.getVariable('private.aforo.' + name);
    if (v === null || v === undefined || ('' + v) === '') v = context.getVariable('aforo.' + name);
    return (v === null || v === undefined) ? '' : ('' + v);
}
var tenantId = context.getVariable('aforo.tenant_id') || mgSetting('tenantId');
var customerId = context.getVariable('aforo.customer_id') || context.getVariable('aforo.customerId');
var marginGuardEnabled = mgSetting('marginGuardEnabled');
var marginGuardUrl = mgSetting('marginGuardUrl');

// Initialize output variables to safe defaults
context.setVariable('aforo.marginGuard.blocked', 'false');
context.setVariable('aforo.marginGuard.throttled', 'false');
context.setVariable('aforo.marginGuard.level', 'NONE');
context.setVariable('aforo.marginGuard.header', '');

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
                        context.setVariable('aforo.marginGuard.header', 'blocked');
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
                            context.setVariable('aforo.marginGuard.header', 'throttled');
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
