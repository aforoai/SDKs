/**
 * aforo-access: revocation check of a verified Aforo JWT (KVM
 * jwt_validation_enabled = "true"). The same contract as the Azure APIM
 * fragment aforo-jwt-validation:
 *
 *   GET {aforo_org_service_url}/api/v1/public/gateway/token-status
 *       ?jti=&keyId=&clientId=          X-API-Key: {api_key}
 *   -> {"revoked": true|false, "reason"} (bare or inside {success, data})
 *
 * One script, three steps (the Javascript policy's Property "phase"):
 *
 *   prepare  decides whether the check runs (the token has a jti or key_id,
 *            jti_check_enabled is not "false", the token is for this
 *            tenant) and sets the cache key tenant|jti|keyId, the URL and
 *            the limits. AforoJwtRevocationLookupCache then reads the entry.
 *   call     whether to call org-service: nothing cached, or fewer than
 *            jti_breaker_failures failures in a row. "OK", "REVOKED" and
 *            "OPEN" (breaker) answer without a call.
 *   decide   reads the answer and sets the entry to store and the verdict:
 *              revoked      401 (AforoJwtRevoked)
 *              unavailable  503 with Retry-After 5 (AforoJwtRevocationUnavailable),
 *                           only with jti_check_fallback = "DENY"
 *              ok           the call goes on
 *
 * Cache entry (environment cache, prefix aforo-jti):
 *   OK       not revoked, for jti_cache_seconds (default 30; 0 = ask every time)
 *   REVOKED  until the token's exp (at most 24 h; 1 h without exp)
 *   F:n      n unanswered checks in a row, for jti_breaker_seconds (default 30)
 *   OPEN     jti_breaker_failures (default 3) reached: no call for
 *            jti_breaker_seconds
 * No answer (timeout 2 s, connection error, non-200, unreadable body, breaker
 * open) lets the call through unless jti_check_fallback is "DENY".
 */

var TOKEN_STATUS_PATH = '/api/v1/public/gateway/token-status';

function rv(name) {
    var x = context.getVariable(name);
    return (x === null || x === undefined) ? '' : ('' + x);
}

function limit(name, dflt, allowZero) {
    var raw = aforoCfg(name);
    var re = allowZero ? /^[0-9]{1,5}$/ : /^[1-9][0-9]{0,4}$/;
    return re.test(raw) ? parseInt(raw, 10) : dflt;
}

function prepare() {
    context.setVariable('aforo.access.revocationCheck', 'false');
    if (!aforoFlag('jwtValidationEnabled', false)) return;
    if (!aforoFlag('jtiCheckEnabled', true)) return;
    if (rv('aforo.access.jwtRejected') === 'true') return;
    var jti = aforoTrim(rv('aforo.jwt.jti'));
    var keyId = aforoTrim(rv('aforo.jwt.key_id'));
    var clientId = aforoTrim(rv('aforo.jwt.client_id'));
    if (!jti && !keyId) return;
    var tenant = aforoCfg('tenantId');
    var base = aforoCfg('orgServiceUrl').replace(/\/+$/, '');
    context.setVariable('aforo.access.revocationCheck', 'true');
    context.setVariable('aforo.access.revocationCacheKey', tenant + '|' + jti + '|' + keyId);
    context.setVariable('aforo.access.revocationLimits', [
        limit('jtiCacheSeconds', 30, true),
        limit('jtiBreakerFailures', 3, false),
        limit('jtiBreakerSeconds', 30, false)
    ].join(','));
    if (!/^https?:\/\/[^\/]/i.test(base)) {
        // Counts as no answer: the fallback applies, as for an outage.
        print('[aforo-access] jwt revocation check: aforo_org_service_url is not set or not http(s); ' +
            'treated as no answer (jti_check_fallback applies)');
        context.setVariable('aforo.access.revocationUrl', '');
        return;
    }
    context.setVariable('aforo.access.revocationUrl', base + TOKEN_STATUS_PATH +
        '?jti=' + encodeURIComponent(jti) +
        '&keyId=' + encodeURIComponent(keyId) +
        '&clientId=' + encodeURIComponent(clientId));
}

function call() {
    var go = 'false';
    if (rv('aforo.access.revocationCheck') === 'true' && rv('aforo.access.revocationUrl')) {
        var c = rv('aforo.access.revocationCached');
        var lim = rv('aforo.access.revocationLimits').split(',');
        if (!c) go = 'true';
        else if (c.indexOf('F:') !== 0) go = 'false';
        else if (!/^F:[0-9]{1,5}$/.test(c)) go = 'true';
        else go = parseInt(c.substring(2), 10) < parseInt(lim[1], 10) ? 'true' : 'false';
    }
    context.setVariable('aforo.access.revocationCall', go);
}

// The callout's answer: OK, REVOKED|<ttl seconds>, or UNAVAILABLE.
function answer() {
    var res = 'aforo.access.revocationResponse';
    var status = parseInt(rv(res + '.status.code'), 10);
    if (status !== 200) return 'UNAVAILABLE';
    var data;
    try {
        var body = JSON.parse(rv(res + '.content'));
        data = (body && typeof body.data === 'object' && body.data) ? body.data : body;
    } catch (e) {
        return 'UNAVAILABLE';
    }
    if (!data || typeof data.revoked !== 'boolean') return 'UNAVAILABLE';
    if (!data.revoked) return 'OK';
    var rawExp = aforoTrim(rv('aforo.jwt.exp'));
    var ttl = 3600;
    if (/^[0-9]{1,12}$/.test(rawExp)) {
        var now = Number(rv('system.timestamp'));
        if (!isFinite(now) || now <= 0) now = new Date().getTime();
        ttl = parseInt(rawExp, 10) - Math.floor(now / 1000);
    }
    if (ttl < 1) ttl = 1;
    if (ttl > 86400) ttl = 86400;
    return 'REVOKED|' + ttl;
}

function decide() {
    if (rv('aforo.access.revocationCheck') !== 'true') return;
    var lim = rv('aforo.access.revocationLimits').split(',');
    var called = rv('aforo.access.revocationCall') === 'true';
    var c = rv('aforo.access.revocationCached');
    var store = '';
    var ttl = 0;
    var result;  // ok | revoked | none (no answer)
    if (!rv('aforo.access.revocationUrl')) {
        result = 'none';  // misconfigured: nothing stored, the fallback applies
    } else if (called) {
        var a = answer();
        if (a === 'OK') {
            result = 'ok';
            if (lim[0] !== '0') { store = 'OK'; ttl = parseInt(lim[0], 10); }
        } else if (a.indexOf('REVOKED|') === 0) {
            result = 'revoked';
            store = 'REVOKED';
            ttl = parseInt(a.substring(8), 10);
        } else {
            result = 'none';
            var n = /^F:[0-9]{1,5}$/.test(c) ? parseInt(c.substring(2), 10) + 1 : 1;
            store = n >= parseInt(lim[1], 10) ? 'OPEN' : 'F:' + n;
            ttl = parseInt(lim[2], 10);
        }
    } else if (!c || c === 'OK') {
        result = 'ok';
    } else if (c === 'REVOKED') {
        result = 'revoked';
    } else {
        result = 'none';  // breaker open
    }
    context.setVariable('aforo.access.revocationStore', store ? 'true' : 'false');
    context.setVariable('aforo.access.revocationState', store);
    context.setVariable('aforo.access.revocationTtlSec', String(ttl));

    var deny = aforoCfg('jtiCheckFallback').toUpperCase() === 'DENY';
    var verdict = result === 'none' ? (deny ? 'unavailable' : 'ok') : result;
    if (result === 'none') {
        print('[aforo-access] jwt revocation check: no answer' + (called ? '' : ' (breaker open or not configured)') +
            (deny ? '; jti_check_fallback=DENY, answering 503' : '; letting the call through'));
    }
    context.setVariable('aforo.access.revocationVerdict', verdict);
    if (verdict === 'revoked') {
        context.setVariable('aforo.access.revokedBody', JSON.stringify({
            error: 'invalid_token', error_description: 'Token has been revoked'
        }));
    } else if (verdict === 'unavailable') {
        context.setVariable('aforo.access.revocationUnavailableBody', JSON.stringify({
            error: 'temporarily_unavailable', error_description: 'REVOCATION_CHECK_UNAVAILABLE'
        }));
    }
}

var phase = (typeof properties !== 'undefined' && properties && properties.phase) ? '' + properties.phase : '';
if (phase === 'prepare') prepare();
else if (phase === 'call') call();
else if (phase === 'decide') decide();
else print('[aforo-access] aforo-jwt-revocation.js: unknown phase "' + phase + '"');
