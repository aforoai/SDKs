/**
 * aforo-access: reads the answer of AforoQuotaCheck (POST /api/v1/quota/check)
 * and decides, as Kong's preflight-quota.lua does:
 *
 *   DENY        aforo.access.quotaDecision = DENY. AforoQuotaExceeded answers
 *               429 with Retry-After = max(1, ceil(retryAfterMs / 1000))
 *               (60 when the ingestor gives none) and the same number in the
 *               JSON body. Never cached, so a top-up unblocks at once.
 *   ALLOW/WARN  let through; cached by AforoQuotaPopulateCache for
 *               quota_cache_ttl_ms. WARN adds X-RateLimit-Warning to the
 *               response (set by aforo-metering).
 *   no answer   timeout, connection error, non-200 or an unreadable body:
 *               fail OPEN (let through, not cached) unless quota_fail_open
 *               is "false"; then aforo.access.quotaFailClosed = true and
 *               AforoQuotaUnavailable answers 503.
 *
 * The answer is {"success":true,"data":{decision,reason,retryAfterMs}}; the
 * bare {decision,...} is read too.
 */

var CALLOUT = 'AforoQuotaCheck';
var RESPONSE = 'aforo.access.quotaResponse';

function v(name) {
    var x = context.getVariable(name);
    return (x === null || x === undefined) ? '' : ('' + x);
}

var failed = v('servicecallout.' + CALLOUT + '.failed') === 'true';
var status = parseInt(v(RESPONSE + '.status.code'), 10);
var data = null;
var problem = '';

if (isNaN(status)) {
    problem = 'no response (timeout or connection error)';
} else if (status !== 200) {
    problem = 'status ' + status + ((status === 401 || status === 403)
        ? ' (the ingestor refused api_key / tenant_id)' : '');
} else {
    try {
        var parsed = JSON.parse(v(RESPONSE + '.content'));
        data = (parsed && typeof parsed.data === 'object' && parsed.data) ? parsed.data : parsed;
        if (!data || typeof data.decision !== 'string') {
            data = null;
            problem = 'no decision in the response';
        }
    } catch (e) {
        problem = 'unreadable response body';
    }
}
if (!problem && failed) problem = 'callout failed';

var failOpen = aforoFlag('quotaFailOpen', true);

if (problem) {
    context.setVariable('aforo.access.quotaDecision', 'UNAVAILABLE');
    context.setVariable('aforo.access.quotaCacheable', 'false');
    if (failOpen) {
        print('[aforo-access] quota check unavailable (' + problem + '): failing OPEN, quota NOT enforced for this call');
    } else {
        print('[aforo-access] quota check unavailable (' + problem + '): quota_fail_open=false, answering 503');
        context.setVariable('aforo.access.quotaFailClosed', 'true');
        context.setVariable('aforo.access.unavailableBody', JSON.stringify({ message: 'Quota check unavailable' }));
    }
} else if (data.decision === 'DENY') {
    var ms = Number(data.retryAfterMs);
    var retryAfter = (isFinite(ms) && ms > 0) ? Math.max(1, Math.ceil(ms / 1000)) : 60;
    var reason = (typeof data.reason === 'string' && data.reason) ? data.reason : 'Quota exceeded';
    context.setVariable('aforo.access.quotaDecision', 'DENY');
    context.setVariable('aforo.access.quotaCacheable', 'false');
    context.setVariable('aforo.access.retryAfter', String(retryAfter));
    context.setVariable('aforo.access.denyBody', JSON.stringify({ message: reason, retryAfter: retryAfter }));
} else {
    var decision = data.decision;
    var cacheable = (decision === 'ALLOW' || decision === 'WARN') &&
        v('aforo.access.quotaCacheEnabled') === 'true';
    context.setVariable('aforo.access.quotaDecision', decision);
    context.setVariable('aforo.access.quotaCacheable', cacheable ? 'true' : 'false');
}
