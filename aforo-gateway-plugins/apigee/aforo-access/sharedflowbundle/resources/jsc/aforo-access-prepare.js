/**
 * aforo-access, step 1 on a managed proxy (before VerifyAPIKey).
 *
 * - Raises aforo.access.refused. It is lowered only by AforoAccessComplete,
 *   the flow's last step, so a request this flow turns away (401, 429, 503)
 *   or that faults half way is never metered, even if the proxy's own
 *   DefaultFaultRule calls aforo-metering. Same rule as Kong's aforo_refused.
 * - Clears every aforo.verified.* variable, so nothing but this flow's own
 *   later steps can have set them for this request.
 * - Picks the caller's API key: header x-api-key, else header apikey, else
 *   query parameter apikey (Kong key-auth's names). VerifyAPIKey takes one
 *   ref only, so the key is copied into aforo.access.clientKey. A missing key
 *   leaves it unset and VerifyAPIKey answers the standard 401
 *   (oauth.v2.FailedToResolveAPIKey).
 */

var VERIFIED = ['customerId', 'apiProduct', 'productType', 'mcpCalls', 'mcpOther', 'customerSource'];

context.setVariable('aforo.access.refused', 'true');
for (var v = 0; v < VERIFIED.length; v++) {
    context.setVariable('aforo.verified.' + VERIFIED[v], '');
}
context.setVariable('aforo.access.checkQuota', 'false');
context.setVariable('aforo.access.cachedDecision', '');
context.setVariable('aforo.access.quotaDecision', '');
context.setVariable('aforo.access.quotaCacheable', 'false');
context.setVariable('aforo.access.quotaFailClosed', 'false');
context.setVariable('aforo.access.jwtRejected', 'false');

function firstHeader(name) {
    var v = context.getVariable(name);
    if (v === null || v === undefined) return '';
    return ('' + v).replace(/^\s+|\s+$/g, '');
}

var key = firstHeader('request.header.x-api-key') ||
    firstHeader('request.header.apikey') ||
    firstHeader('request.queryparam.apikey');

if (key) {
    context.setVariable('aforo.access.clientKey', key);
}
