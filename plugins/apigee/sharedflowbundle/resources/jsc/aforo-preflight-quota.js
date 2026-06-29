/**
 * Aforo Pre-Flight Quota Check for Apigee (JavaScript Callout)
 *
 * Runs in the access control phase (before proxying to target).
 * Calls usage-ingestor /api/v1/quota/check via ServiceCallout.
 * Fail-open: if check fails, request proceeds.
 *
 * Config via KVM:
 *   preflight_enabled: "true" | "false"
 *   preflight_url: Aforo quota check endpoint URL
 *   preflight_timeout_ms: max wait time (default: 50)
 *   preflight_fallback: "ALLOW" (default) or "DENY"
 */

var enabled = context.getVariable('aforo.preflight_enabled');
if (enabled !== 'true') {
    // Pre-flight disabled — skip
    context.setVariable('aforo.preflight_decision', 'ALLOW');
} else {
    var customerId = context.getVariable('aforo.customer_id') ||
                     context.getVariable('apiproxy.consumerkey') || '';

    if (!customerId) {
        context.setVariable('aforo.preflight_decision', 'ALLOW');
    } else {
        // Build request body for ServiceCallout
        var metricName = context.getVariable('aforo.preflight_metric_name') || '';
        var requestBody = JSON.stringify({
            customerId: customerId,
            metricName: metricName || null
        });

        context.setVariable('aforo.preflight_request_body', requestBody);
        context.setVariable('aforo.preflight_ready', 'true');
    }
}

// ── Post-ServiceCallout: Parse response ──
// (This section runs after the ServiceCallout policy returns)

var responseBody = context.getVariable('aforo.preflight_response');
if (responseBody) {
    try {
        var parsed = JSON.parse(responseBody);
        var data = parsed.data || parsed;
        var decision = data.decision || 'ALLOW';

        context.setVariable('aforo.preflight_decision', decision);

        if (decision === 'DENY') {
            var retryAfter = data.retryAfterMs ? Math.floor(data.retryAfterMs / 1000) : 60;
            context.setVariable('aforo.preflight_retry_after', String(retryAfter));
            context.setVariable('aforo.preflight_reason', data.reason || 'Rate limit exceeded');
        } else if (decision === 'WARN') {
            context.setVariable('aforo.preflight_warning', 'approaching-limit');
        }

        // Forward rate limit headers
        if (data.headers) {
            for (var key in data.headers) {
                context.setVariable('response.header.' + key, data.headers[key]);
            }
        }
    } catch (e) {
        var fallback = context.getVariable('aforo.preflight_fallback') || 'ALLOW';
        context.setVariable('aforo.preflight_decision', fallback);
    }
}
