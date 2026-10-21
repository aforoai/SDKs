/**
 * aforo-access: who is calling, what the call bills to, and whether the
 * pre-flight quota check runs. Runs after AforoVerifyApiKey succeeded and
 * AforoAccessReadProductConfig read the API product's settings. Uses
 * aforo-billing.js (IncludeURL).
 *
 * Customer (AC1): the aforo_customer_id custom attribute of the app that
 * owns the verified key, else of its developer, as VerifyAPIKey itself
 * exposes them:
 *     verifyapikey.AforoVerifyApiKey.app.aforo_customer_id
 *     verifyapikey.AforoVerifyApiKey.developer.aforo_customer_id
 * VerifyAPIKey sets these from the same lookup that verified the key, so no
 * second lookup (AccessEntity + ExtractVariables) is needed, and nothing the
 * client sends can reach them. Never the request, the app's name or display
 * name, or the developer's email. A verified key whose app and developer have
 * no aforo_customer_id is someone else's app on this proxy: it is let through
 * unmetered and unchecked.
 *
 * API product: verifyapikey.AforoVerifyApiKey.apiproduct.name, the product
 * Apigee matched to this proxy and path for that key.
 *
 * Output (read by aforo-metering; none can be set by a client, which can
 * only reach request.* variables):
 *   aforo.verified.customerId / apiProduct / productType
 *   aforo.verified.mcpCalls   JSON [{toolName, id}] of the body's tools/call
 *   aforo.verified.mcpOther   number of other JSON-RPC messages
 * and for the quota steps:
 *   aforo.access.checkQuota      "true" when the pre-flight check runs
 *   aforo.access.preflightMetric the metric it asks about
 *   aforo.access.quotaCacheKey / quotaCacheTtlSec / quotaUrl / quotaBody
 */

var VERIFY_POLICY = 'AforoVerifyApiKey';
var QUOTA_CHECK_PATH = '/api/v1/quota/check';

function verified(name) {
    return aforoTrim(aforoStr('verifyapikey.' + VERIFY_POLICY + '.' + name));
}

function quotaUrl() {
    var configured = aforoCfg('quotaCheckUrl');
    if (configured) return configured;
    var m = /^(https?:\/\/[^\/]+)/i.exec(aforoCfg('endpoint'));
    return m ? m[1] + QUOTA_CHECK_PATH : '';
}

// quota_cache_ttl_ms (default 1000) in whole seconds, the cache's unit:
// rounded up, 0 turns the cache off.
function cacheTtlSeconds() {
    var raw = aforoCfg('quotaCacheTtlMs');
    var ms = /^\d+$/.test(raw) ? parseInt(raw, 10) : 1000;
    return ms <= 0 ? 0 : Math.ceil(ms / 1000);
}

var fromApp = verified('app.aforo_customer_id');
var fromDeveloper = verified('developer.aforo_customer_id');
var customerId = fromApp || fromDeveloper;
var apiProduct = verified('apiproduct.name');
var product = aforoProductConfig();
var method = aforoStr('request.verb').toUpperCase();
var path = aforoRequestPath();

var skip = '';
if (!customerId) {
    skip = 'the verified app and its developer have no aforo_customer_id attribute';
} else if (customerId.length > AFORO_MAX.customerId || !aforoIsText(customerId, false)) {
    skip = 'aforo_customer_id is not a usable customer id (more than 64 characters or not text)';
} else if (!apiProduct) {
    skip = 'VerifyAPIKey resolved no API product';
} else if (!product.configured) {
    skip = 'API product ' + apiProduct + ' has no Aforo settings (product_type__/default_metric__/metric_mappings__)';
}

if (skip) {
    print('[aforo-access] not metered or quota-checked: ' + skip);
} else {
    context.setVariable('aforo.verified.customerId', customerId);
    context.setVariable('aforo.verified.customerSource', fromApp ? 'app' : 'developer');
    context.setVariable('aforo.verified.apiProduct', apiProduct);
    context.setVariable('aforo.verified.productType', product.type);

    // MCP: read the client's body here, on the request path, once. The
    // metering flow uses this list rather than re-reading request.content,
    // which a TargetEndpoint may have rewritten by then.
    var jsonrpc = null;
    if (product.type === 'MCP_SERVER' && method === 'POST') {
        jsonrpc = aforoParseJsonRpc(context.getVariable('request.content'));
    }
    context.setVariable('aforo.verified.mcpCalls', JSON.stringify(jsonrpc ? jsonrpc.calls : []));
    context.setVariable('aforo.verified.mcpOther', String(jsonrpc ? jsonrpc.other : 0));

    // Pre-flight: only the metric this call bills to, and nothing for a call
    // that bills nothing (an excluded path, a CORS preflight, an MCP message
    // without a tools/call). The upstream's X-Aforo-Metric and quantity are
    // not known yet: the check asks whether the quota is already used up.
    if (product.enforceQuota) {
        var billable = aforoBillable(product.type, jsonrpc);
        var metric = '';
        if (aforoIsExcludedRequest(aforoExcludePaths(aforoCfg('excludePaths'))) ||
                aforoIsCorsPreflight(method)) {
            metric = '';
        } else if (billable.tools) {
            metric = aforoToolCallMetric(method, path, '', product);
        } else if (billable.plain) {
            metric = aforoResolveMetric(method, path, '', product, '');
        }
        var url = quotaUrl();
        if (metric && url) {
            var tenantId = aforoCfg('tenantId');
            var ttl = cacheTtlSeconds();
            context.setVariable('aforo.access.checkQuota', 'true');
            context.setVariable('aforo.access.preflightMetric', metric);
            context.setVariable('aforo.access.quotaUrl', url);
            context.setVariable('aforo.access.quotaBody',
                JSON.stringify({ customerId: customerId, metricName: metric }));
            // Tenant in the key: customer ids are unique only within a tenant.
            context.setVariable('aforo.access.quotaCacheKey', tenantId + '|' + customerId + '|' + metric);
            context.setVariable('aforo.access.quotaCacheTtlSec', String(ttl));
            context.setVariable('aforo.access.quotaCacheEnabled', ttl > 0 ? 'true' : 'false');
        } else if (metric && !url) {
            print('[aforo-access] enforce_quota is set but there is no quota_check_url and ' +
                'aforo_endpoint has no http(s) origin: quota NOT enforced');
        }
    }
}

// Optional Aforo JWT (jwt_validation_enabled): a token for another tenant is
// refused, as in Kong. AforoJwtValidation already checked its signature.
if (aforoFlag('jwtValidationEnabled', false)) {
    var jwtTenant = aforoTrim(aforoStr('aforo.jwt.tenant_id'));
    var tenant = aforoCfg('tenantId');
    if (!jwtTenant || !tenant || jwtTenant !== tenant) {
        context.setVariable('aforo.access.jwtRejected', 'true');
        context.setVariable('aforo.access.jwtRejectedBody', JSON.stringify({
            error: 'invalid_token',
            error_description: 'The token was not issued for this tenant'
        }));
    }
}
