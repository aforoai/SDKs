/**
 * Aforo JWT jti Blocklist Check — Apigee JavaScript Policy
 *
 * Runs AFTER AforoJwtValidation succeeds.
 * Checks whether the token's jti has been individually revoked, or whether
 * all tokens for the token's key_id have been client-revoked.
 *
 * Requires the Apigee Redis callout extension to be configured, or the
 * aforo-metering-redis-check ServiceCallout policy (which calls a small
 * sidecar endpoint on org-service that performs the Redis lookup).
 *
 * Sidecar endpoint (org-service internal):
 *   GET /internal/v1/auth/token-check?jti={jti}&keyId={keyId}
 *   Response 200 { revoked: false }  — token is valid
 *   Response 200 { revoked: true }   — token is revoked
 *
 * Flow variables read (set by AforoJwtValidation via OutputClaims):
 *   jwt.claims.jti       — unique token ID
 *   aforo.key_id         — key identifier for client-level revocation
 *
 * On revocation detected: sets aforo.jti_revoked = "true" so the
 * AforoJwtRaiseFault policy can raise a 401 fault.
 *
 * Note: This approach keeps the revocation check synchronous within the
 * Apigee request pipeline without requiring a Redis extension license.
 * If your Apigee organisation has the Redis extension enabled, replace
 * the ServiceCallout with a direct Redis GET call.
 */

var jti   = context.getVariable('jwt.claims.jti')  || '';
var keyId = context.getVariable('aforo.key_id')     || '';

// Default: not revoked (fail-open — don't block on missing values)
context.setVariable('aforo.jti_revoked', 'false');
context.setVariable('aforo.jti_revoked_reason', '');

if (!jti && !keyId) {
    // No jti or keyId to check — skip
    // This path is taken when JWT validation is disabled or claims are absent
} else {
    // Build the query string for the org-service sidecar check
    var checkUrl = '/internal/v1/auth/token-check';
    var params   = [];
    if (jti)   params.push('jti='   + encodeURIComponent(jti));
    if (keyId) params.push('keyId=' + encodeURIComponent(keyId));
    if (params.length > 0) checkUrl += '?' + params.join('&');

    context.setVariable('aforo.jti_check_url', checkUrl);
    // The AforoJtiCheckCallout ServiceCallout policy sends a GET to this URL.
    // The response is stored in aforo.jti_check_response, parsed below by
    // AforoJtiCheckParse (a second JS policy that runs after the callout).
}
