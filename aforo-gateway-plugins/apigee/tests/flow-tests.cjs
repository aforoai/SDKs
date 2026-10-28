'use strict';
/**
 * End-to-end tests of the two shared flows, run through tests/lib/apigee-sim:
 * aforo-access (PreProxyFlowHook) -> the upstream -> aforo-metering
 * (PostProxyFlowHook), with the real bundle XML and scripts.
 *
 * Run: node apigee/tests/flow-tests.cjs   (from aforo-gateway-plugins/)
 */

const path = require('path');
const assert = require('assert');
const { test, section, report } = require('./lib/harness.cjs');
const sim = require('./lib/apigee-sim.cjs');

const ROOT = path.resolve(__dirname, '..');
const ACCESS = sim.loadBundle(path.join(ROOT, 'aforo-access', 'sharedflowbundle'));
const METERING = sim.loadBundle(path.join(ROOT, 'sharedflowbundle'));

const INGEST_URL = 'https://api.aforo.ai/v1/ingest/batch';
const QUOTA_URL = 'https://api.aforo.ai/api/v1/quota/check';
const TENANT = 'tenant-1';

const PRODUCTS = {
    'payments-product': {
        type: 'API', proxies: ['payments-proxy'], defaultMetric: 'payments.calls', enforce: 'true',
        mappings: [{ pathPattern: '^/payments/v1/charge', method: 'POST', metricName: 'charges' }],
        productId: 'prod-api'
    },
    'agentic-product': { type: 'AGENTIC_API', proxies: ['agentic-proxy'], defaultMetric: 'agentic.calls', enforce: 'true' },
    'agent-product': { type: 'AI_AGENT', proxies: ['agent-proxy'], defaultMetric: 'agent.calls', agentId: 'agent-cfg', enforce: 'true' },
    'mcp-product': { type: 'MCP_SERVER', proxies: ['mcp-proxy'], defaultMetric: 'tool_calls', enforce: 'true' }
};

const KEYS = {
    'sk_live_cust1': { app: { aforo_customer_id: 'cust-1' }, developer: { aforo_customer_id: 'dev-cust' },
        products: ['payments-product'], appName: 'my-app', email: 'dev@example.com' },
    'sk_live_devonly': { app: {}, developer: { aforo_customer_id: 'cust-dev' }, products: ['payments-product'] },
    'sk_live_noattr': { app: {}, developer: {}, products: ['payments-product'], appName: 'cust-from-name' },
    'sk_live_agentic': { app: { aforo_customer_id: 'cust-2' }, products: ['agentic-product'] },
    'client-secret-agent': { app: { aforo_customer_id: 'cust-3' }, products: ['agent-product'] },
    'client-secret-mcp': { app: { aforo_customer_id: 'cust-4' }, products: ['mcp-product'] }
};

const PROXY_BASEPATH = {
    'payments-proxy': '/payments', 'agentic-proxy': '/agentic', 'agent-proxy': '/agent',
    'mcp-proxy': '/mcp', 'legacy-proxy': '/legacy'
};

function baseKvm(overrides) {
    const kvm = {
        aforo_endpoint: INGEST_URL,
        api_key: 'ak_tenant_ingest',
        tenant_id: TENANT,
        quota_timeout_ms: '1500',
        quota_fail_open: 'true',
        quota_cache_ttl_ms: '1000'
    };
    for (const proxy of ['payments-proxy', 'agentic-proxy', 'agent-proxy', 'mcp-proxy']) kvm['managed_proxy__' + proxy] = 'true';
    for (const [name, p] of Object.entries(PRODUCTS)) {
        kvm['product_type__' + name] = p.type;
        kvm['default_metric__' + name] = p.defaultMetric;
        kvm['enforce_quota__' + name] = p.enforce;
        if (p.mappings) kvm['metric_mappings__' + name] = JSON.stringify(p.mappings);
        if (p.agentId) kvm['agent_id__' + name] = p.agentId;
        if (p.productId) kvm['aforo_product_id__' + name] = p.productId;
    }
    return Object.assign(kvm, overrides || {});
}

function newEnv(opts) {
    opts = opts || {};
    const productProxies = {};
    for (const [name, p] of Object.entries(PRODUCTS)) productProxies[name] = p.proxies;
    return {
        kvm: baseKvm(opts.kvm),
        keys: KEYS,
        productProxies,
        cache: new Map(),
        clock: { now: 1760000000000 },
        quota: opts.quota || (() => ({ status: 200, body: JSON.stringify({ success: true, data: { decision: 'ALLOW' } }) })),
        ingest: opts.ingest || ((req) => ({ status: 202, body: JSON.stringify({ success: true, data: { accepted: JSON.parse(req.body).events.length, failed: 0, errors: [] } }) })),
        jwt: opts.jwt,
        pubsub: opts.pubsub || (() => ({ ok: true })),
        log: [],
        http(req) {
            this.log.push(req);
            if (req.url === QUOTA_URL) return this.quota(req);
            if (req.url === INGEST_URL) return this.ingest(req);
            return { error: 'unknown url ' + req.url };
        }
    };
}

let seq = 0;

/**
 * One call through Apigee. req: {proxy, verb, suffix, headers, query, body,
 * upstream: {status, headers, body}, errorFlowMetering}
 */
function call(env, req) {
    seq++;
    const proxy = req.proxy || 'payments-proxy';
    const vars = {
        'apiproxy.name': proxy,
        'proxy.basepath': PROXY_BASEPATH[proxy] || '/',
        'proxy.pathsuffix': req.suffix === undefined ? '/v1/accounts' : req.suffix,
        'request.verb': req.verb || 'GET',
        'messageid': req.messageid || ('msg-' + seq),
        'client.received.start.timestamp': String(env.clock.now),
        'request.content': req.body === undefined ? null : req.body
    };
    for (const [k, v] of Object.entries(req.headers || {})) vars['request.header.' + k] = v;
    for (const [k, v] of Object.entries(req.query || {})) vars['request.queryparam.' + k] = v;
    const msg = new sim.Message(env, vars);
    const before = env.log.length;

    const accessFault = sim.runFlow(ACCESS, msg);
    const out = { msg, accessFault, upstreamCalled: false };
    if (!accessFault) {
        out.upstreamCalled = true;
        out.upstreamHeaders = Object.keys(msg.vars).filter((k) => k.startsWith('request.header.'))
            .reduce((o, k) => { o[k.slice('request.header.'.length).toLowerCase()] = msg.vars[k]; return o; }, {});
        out.upstreamQuery = Object.keys(msg.vars).filter((k) => k.startsWith('request.queryparam.'));
        const up = req.upstream || { status: 200 };
        msg.set('response.status.code', String(up.status));
        msg.set('response.content', up.body === undefined ? '{"ok":true}' : up.body);
        for (const [k, v] of Object.entries(up.headers || {})) msg.set('response.header.' + k, v);
        env.clock.now += 40;
        msg.set('system.timestamp', String(env.clock.now));
        // Apigee: a target 4xx/5xx goes to the error flow and skips the
        // PostProxyFlowHook; metering then runs only from a DefaultFaultRule
        // FlowCallout (errorFlowMetering).
        const errorFlow = up.status >= 400;
        if (!errorFlow || req.errorFlowMetering) out.meteringFault = sim.runFlow(METERING, msg);
    } else if (req.errorFlowMetering) {
        out.meteringFault = sim.runFlow(METERING, msg);
    }
    const mine = env.log.slice(before);
    out.quotaCalls = mine.filter((r) => r.url === QUOTA_URL);
    out.ingestCalls = mine.filter((r) => r.url === INGEST_URL);
    out.publishes = msg.publishes || [];
    out.events = out.ingestCalls.length ? JSON.parse(out.ingestCalls[0].body).events
        : (out.publishes.length ? JSON.parse(out.publishes[0].data).events : []);
    return out;
}

const KEY = { 'x-api-key': 'sk_live_cust1' };

// ─────────────────────────────────────────────────────────────────────────
section('Managed proxies, keys and identity (AC1, AC3, AC4)');

test('unmanaged proxy: no key check, no quota, no event', () => {
    const env = newEnv();
    const r = call(env, { proxy: 'legacy-proxy' });
    assert.strictEqual(r.accessFault, null);
    assert.deepStrictEqual(r.msg.trace, ['AforoAccessReadManaged']);
    assert.strictEqual(r.quotaCalls.length, 0);
    assert.strictEqual(r.ingestCalls.length, 0);
});

test('missing key: standard 401, upstream not called, not metered', () => {
    const r = call(newEnv(), { errorFlowMetering: true });
    assert.strictEqual(r.accessFault.status, 401);
    assert.strictEqual(r.accessFault.code, 'oauth.v2.FailedToResolveAPIKey');
    assert.strictEqual(r.upstreamCalled, false);
    assert.strictEqual(r.ingestCalls.length, 0);
});

test('unknown key: 401 InvalidApiKey', () => {
    const r = call(newEnv(), { headers: { 'x-api-key': 'nope' } });
    assert.strictEqual(r.accessFault.status, 401);
    assert.strictEqual(r.accessFault.code, 'oauth.v2.InvalidApiKey');
});

test('key whose API products do not cover this proxy: 401 (per-product access, like Kong ACL)', () => {
    const r = call(newEnv(), { proxy: 'agent-proxy', headers: KEY });
    assert.strictEqual(r.accessFault.status, 401);
    assert.strictEqual(r.accessFault.code, 'oauth.v2.InvalidApiKeyForGivenResource');
});

test('key accepted from header apikey and from query parameter apikey', () => {
    const env = newEnv();
    assert.strictEqual(call(env, { headers: { apikey: 'sk_live_cust1' } }).events[0].customerId, 'cust-1');
    assert.strictEqual(call(env, { query: { apikey: 'sk_live_cust1' } }).events[0].customerId, 'cust-1');
});

test('the upstream never receives the end customer key (hide credentials)', () => {
    const env = newEnv();
    let r = call(env, { headers: { 'x-api-key': 'sk_live_cust1', 'X-Other': 'kept' } });
    assert.strictEqual(r.upstreamHeaders['x-api-key'], undefined);
    assert.strictEqual(r.upstreamHeaders['x-other'], 'kept');
    r = call(env, { headers: { apikey: 'sk_live_cust1' } });
    assert.strictEqual(r.upstreamHeaders.apikey, undefined);
    r = call(env, { query: { apikey: 'sk_live_cust1', page: '2' } });
    assert.deepStrictEqual(r.upstreamQuery, ['request.queryparam.page']);
    assert.ok(r.msg.trace.indexOf('AforoAccessHideCredentials') > r.msg.trace.indexOf('AforoVerifyApiKey'));
});

test('customer = the app attribute aforo_customer_id, never request headers, app name or email', () => {
    const r = call(newEnv(), { headers: Object.assign({ 'X-Customer-Id': 'evil', 'X-Aforo-Customer-Id': 'evil' }, KEY) });
    assert.strictEqual(r.events.length, 1);
    assert.strictEqual(r.events[0].customerId, 'cust-1');
    assert.strictEqual(r.msg.get('aforo.verified.customerSource'), 'app');
});

test('customer falls back to the developer attribute', () => {
    const r = call(newEnv(), { headers: { 'x-api-key': 'sk_live_devonly' } });
    assert.strictEqual(r.events[0].customerId, 'cust-dev');
    assert.strictEqual(r.msg.get('aforo.verified.customerSource'), 'developer');
});

test('verified app without aforo_customer_id: let through, no quota call, no event', () => {
    const r = call(newEnv(), { headers: { 'x-api-key': 'sk_live_noattr' } });
    assert.strictEqual(r.accessFault, null);
    assert.strictEqual(r.upstreamCalled, true);
    assert.strictEqual(r.quotaCalls.length, 0);
    assert.strictEqual(r.ingestCalls.length, 0);
    assert.strictEqual(r.msg.get('aforo.skipReason'), 'no verified customer');
});

test('API product without Aforo settings: let through, unmetered', () => {
    const env = newEnv();
    for (const k of Object.keys(env.kvm)) if (k.endsWith('__payments-product')) delete env.kvm[k];
    const r = call(env, { headers: KEY });
    assert.strictEqual(r.upstreamCalled, true);
    assert.strictEqual(r.ingestCalls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
section('Pre-flight quota check');

test('ALLOW: one quota call with customer + billed metric and the tenant headers', () => {
    const r = call(newEnv(), { headers: KEY, verb: 'POST', suffix: '/v1/charge' });
    assert.strictEqual(r.quotaCalls.length, 1);
    const q = r.quotaCalls[0];
    assert.deepStrictEqual(JSON.parse(q.body), { customerId: 'cust-1', metricName: 'charges' });
    assert.strictEqual(q.headers['X-API-Key'], 'ak_tenant_ingest');
    assert.strictEqual(q.headers['X-Tenant-Id'], TENANT);
    assert.strictEqual(r.upstreamCalled, true);
    assert.strictEqual(r.events[0].metricName, 'charges', 'the check asks about the metric the event bills to');
});

test('DENY: 429 with Retry-After = ceil(retryAfterMs/1000) and a JSON body; upstream not called; not metered', () => {
    const env = newEnv({ quota: () => ({ status: 200, body: JSON.stringify({ success: true, data: { decision: 'DENY', reason: 'Quota used up', retryAfterMs: 2500 } }) }) });
    const r = call(env, { headers: KEY, errorFlowMetering: true });
    assert.strictEqual(r.accessFault.status, 429);
    assert.strictEqual(r.accessFault.headers['Retry-After'], '3');
    assert.deepStrictEqual(JSON.parse(r.accessFault.body), { message: 'Quota used up', retryAfter: 3 });
    assert.strictEqual(r.upstreamCalled, false);
    assert.strictEqual(r.ingestCalls.length, 0, 'not metered, even from a DefaultFaultRule FlowCallout');
});

test('DENY Retry-After: at least 1 s; 60 s without retryAfterMs', () => {
    let env = newEnv({ quota: () => ({ status: 200, body: '{"success":true,"data":{"decision":"DENY","retryAfterMs":120}}' }) });
    assert.strictEqual(call(env, { headers: KEY }).accessFault.headers['Retry-After'], '1');
    env = newEnv({ quota: () => ({ status: 200, body: '{"decision":"DENY"}' }) });
    assert.strictEqual(call(env, { headers: KEY }).accessFault.headers['Retry-After'], '60');
});

test('DENY is never cached: the next call asks again', () => {
    const env = newEnv({ quota: () => ({ status: 200, body: '{"success":true,"data":{"decision":"DENY","retryAfterMs":1000}}' }) });
    call(env, { headers: KEY });
    const r = call(env, { headers: KEY });
    assert.strictEqual(r.quotaCalls.length, 1);
    assert.strictEqual(r.accessFault.status, 429);
});

test('ALLOW is cached for quota_cache_ttl_ms (1 s), then asked again', () => {
    const env = newEnv();
    assert.strictEqual(call(env, { headers: KEY }).quotaCalls.length, 1);
    assert.strictEqual(call(env, { headers: KEY }).quotaCalls.length, 0, 'second call within 1 s: cache hit');
    env.clock.now += 1500;
    assert.strictEqual(call(env, { headers: KEY }).quotaCalls.length, 1, 'after the TTL: asked again');
});

test('cache key includes the metric: another metric asks again', () => {
    const env = newEnv();
    call(env, { headers: KEY });
    assert.strictEqual(call(env, { headers: KEY, verb: 'POST', suffix: '/v1/charge' }).quotaCalls.length, 1);
});

test('quota_cache_ttl_ms = 0 turns the cache off', () => {
    const env = newEnv({ kvm: { quota_cache_ttl_ms: '0' } });
    call(env, { headers: KEY });
    assert.strictEqual(call(env, { headers: KEY }).quotaCalls.length, 1);
});

test('WARN: let through, cached, X-RateLimit-Warning on the response (fresh and cached)', () => {
    const env = newEnv({ quota: () => ({ status: 200, body: '{"success":true,"data":{"decision":"WARN"}}' }) });
    let r = call(env, { headers: KEY });
    assert.strictEqual(r.msg.get('response.header.X-RateLimit-Warning'), 'approaching-limit');
    r = call(env, { headers: KEY });
    assert.strictEqual(r.quotaCalls.length, 0);
    assert.strictEqual(r.msg.get('response.header.X-RateLimit-Warning'), 'approaching-limit');
    assert.strictEqual(r.events.length, 1);
});

test('timeout beyond 1500 ms: fail open (served and metered), not cached', () => {
    const env = newEnv({ quota: () => ({ timeoutMs: 2000 }) });
    const r = call(env, { headers: KEY });
    assert.strictEqual(r.accessFault, null);
    assert.strictEqual(r.upstreamCalled, true);
    assert.strictEqual(r.events.length, 1);
    assert.strictEqual(r.msg.get('aforo.access.quotaDecision'), 'UNAVAILABLE');
    assert.strictEqual(call(env, { headers: KEY }).quotaCalls.length, 1, 'nothing cached');
});

test('a 1.2 s answer is still within the 1500 ms timeout', () => {
    const env = newEnv({ quota: () => ({ status: 200, latencyMs: 1200, body: '{"success":true,"data":{"decision":"DENY"}}' }) });
    assert.strictEqual(call(env, { headers: KEY }).accessFault.status, 429);
});

test('500 / unreadable answer: fail open', () => {
    let env = newEnv({ quota: () => ({ status: 500, body: 'oops' }) });
    assert.strictEqual(call(env, { headers: KEY }).upstreamCalled, true);
    env = newEnv({ quota: () => ({ status: 200, body: 'not json' }) });
    assert.strictEqual(call(env, { headers: KEY }).upstreamCalled, true);
});

test('quota_fail_open = false: no answer is a 503 with Retry-After 1, not metered', () => {
    const env = newEnv({ kvm: { quota_fail_open: 'false' }, quota: () => ({ timeoutMs: 5000 }) });
    const r = call(env, { headers: KEY, errorFlowMetering: true });
    assert.strictEqual(r.accessFault.status, 503);
    assert.strictEqual(r.accessFault.headers['Retry-After'], '1');
    assert.strictEqual(r.ingestCalls.length, 0);
});

test('enforce_quota__{p} not "true": no quota call', () => {
    const env = newEnv({ kvm: { 'enforce_quota__payments-product': 'false' } });
    const r = call(env, { headers: KEY });
    assert.strictEqual(r.quotaCalls.length, 0);
    assert.strictEqual(r.events.length, 1);
});

test('excluded path and CORS preflight: no quota call, no event', () => {
    const env = newEnv({ quota: () => ({ status: 200, body: '{"decision":"DENY"}' }) });
    let r = call(env, { headers: KEY, suffix: '/health' });
    assert.strictEqual(r.quotaCalls.length, 0);
    assert.strictEqual(r.upstreamCalled, true);
    assert.strictEqual(r.ingestCalls.length, 0);
    r = call(env, { headers: Object.assign({ 'Access-Control-Request-Method': 'POST' }, KEY), verb: 'OPTIONS' });
    assert.strictEqual(r.quotaCalls.length, 0);
    assert.strictEqual(r.ingestCalls.length, 0);
});

test('quota_check_url from the KVM wins over the derived URL', () => {
    const env = newEnv({ kvm: { quota_check_url: 'https://quota.example/check' } });
    env.http = function (req) { this.log.push(req); return req.url === 'https://quota.example/check' ? { status: 200, body: '{"decision":"DENY"}' } : { status: 202, body: '{}' }; };
    assert.strictEqual(call(env, { headers: KEY }).accessFault.status, 429);
});

// ─────────────────────────────────────────────────────────────────────────
section('API');

test('API: one event, every common field, executionStatus, idempotencyKey = messageid', () => {
    const r = call(newEnv(), { headers: KEY, messageid: 'rrt-123', upstream: { status: 201 } });
    assert.strictEqual(r.ingestCalls.length, 1);
    assert.strictEqual(r.ingestCalls[0].headers['X-API-Key'], 'ak_tenant_ingest');
    assert.strictEqual(r.ingestCalls[0].waits, false, 'async: Apigee does not wait for the ingestor');
    const e = r.events[0];
    assert.strictEqual(e.productType, 'API');
    assert.strictEqual(e.customerId, 'cust-1');
    assert.strictEqual(e.metricName, 'payments.calls');
    assert.strictEqual(e.quantity, 1);
    assert.strictEqual(e.idempotencyKey, 'rrt-123');
    assert.strictEqual(e.executionStatus, 'SUCCESS');
    assert.strictEqual(e.endpointPath, '/payments/v1/accounts');
    assert.strictEqual(e.httpMethod, 'GET');
    assert.strictEqual(e.statusCode, 201);
    // client start -> response: the 5 ms quota call plus the 40 ms upstream
    assert.strictEqual(e.responseTimeMs, 45);
    assert.strictEqual(e.metadata.productId, 'prod-api');
    assert.strictEqual(e.metadata.apiProduct, 'payments-product');
    assert.strictEqual(e.traceId, undefined);
    assert.strictEqual(e.agentId, undefined);
});

test('API: client X-Request-Id never becomes the idempotency key', () => {
    const r = call(newEnv(), { headers: Object.assign({ 'x-request-id': 'same' }, KEY), messageid: 'm-1' });
    assert.strictEqual(r.events[0].idempotencyKey, 'm-1');
    assert.strictEqual(r.events[0].trace.xRequestId, 'same');
});

test('API: a client traceparent stays informational; the type stays API', () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const e = call(newEnv(), { headers: Object.assign({ traceparent: tp }, KEY) }).events[0];
    assert.strictEqual(e.productType, 'API');
    assert.strictEqual(e.traceId, undefined);
    assert.strictEqual(e.trace.traceparent, tp);
});

test('API: X-Aforo-Quantity from the upstream response; unusable values fall back to 1', () => {
    const env = newEnv();
    assert.strictEqual(call(env, { headers: KEY, upstream: { status: 200, headers: { 'X-Aforo-Quantity': '2.5' } } }).events[0].quantity, 2.5);
    assert.strictEqual(call(env, { headers: KEY, upstream: { status: 200, headers: { 'X-Aforo-Quantity': 'abc' } } }).events[0].quantity, 1);
    assert.strictEqual(call(env, { headers: Object.assign({ 'X-Aforo-Quantity': '999' }, KEY) }).events[0].quantity, 1, 'request header ignored');
});

test('API: quantity_header__{p} overrides the header name', () => {
    const env = newEnv({ kvm: { 'quantity_header__payments-product': 'X-Units' } });
    assert.strictEqual(call(env, { headers: KEY, upstream: { status: 200, headers: { 'X-Units': '7' } } }).events[0].quantity, 7);
});

test('API: quantity_source=response_size bills a chunked body (no Content-Length)', () => {
    const env = newEnv({ kvm: { quantity_source: 'response_size' } });
    assert.strictEqual(call(env, { headers: KEY, upstream: { status: 200, body: 'héllo' } }).events[0].quantity, 6);
    assert.strictEqual(call(env, { headers: KEY, upstream: { status: 200, body: 'x', headers: { 'Content-Length': '1234' } } }).events[0].quantity, 1234);
});

test('API: X-Aforo-Metric from the upstream response names the metric', () => {
    const e = call(newEnv(), { headers: KEY, upstream: { status: 200, headers: { 'X-Aforo-Metric': 'sms_sent' } } }).events[0];
    assert.strictEqual(e.metricName, 'sms_sent');
});

test('API: status_outcomes__{p} overrides the status table', () => {
    const env = newEnv({ kvm: { exclude_status_codes: 'none', 'status_outcomes__payments-product': '{"404":"VALIDATION_FAILED"}' } });
    const e = call(env, { headers: KEY, upstream: { status: 404 }, errorFlowMetering: true }).events[0];
    assert.strictEqual(e.executionStatus, 'VALIDATION_FAILED');
});

test('upstream 5xx: not metered from the hook (error flow); metered as ERROR from a DefaultFaultRule FlowCallout', () => {
    const env = newEnv();
    assert.strictEqual(call(env, { headers: KEY, upstream: { status: 503 } }).ingestCalls.length, 0);
    const e = call(env, { headers: KEY, upstream: { status: 500 }, errorFlowMetering: true }).events[0];
    assert.strictEqual(e.executionStatus, 'ERROR');
    assert.strictEqual(e.statusCode, 500);
});

test('exclude_status_codes default 401,403,429: an upstream 401 is not billed', () => {
    const r = call(newEnv(), { headers: KEY, upstream: { status: 401 }, errorFlowMetering: true });
    assert.strictEqual(r.ingestCalls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
section('AGENTIC_API');

const AGENTIC = { proxy: 'agentic-proxy', headers: { 'x-api-key': 'sk_live_agentic' } };

test('AGENTIC_API: traceId from the upstream X-Aforo-Trace-Id', () => {
    const e = call(newEnv(), Object.assign({ upstream: { status: 200, headers: { 'X-Aforo-Trace-Id': 'goal-42' } } }, AGENTIC)).events[0];
    assert.strictEqual(e.productType, 'AGENTIC_API');
    assert.strictEqual(e.traceId, 'goal-42');
    assert.strictEqual(e.executionStatus, 'SUCCESS');
});

test('AGENTIC_API: else the gateway request id (messageid), never the client traceparent', () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const e = call(newEnv(), { proxy: 'agentic-proxy', messageid: 'rrt-9', headers: { 'x-api-key': 'sk_live_agentic', traceparent: tp, 'X-Aforo-Trace-Id': 'client-picked' } }).events[0];
    assert.strictEqual(e.traceId, 'rrt-9');
});

test('AGENTIC_API: trace_id_header__{p} renames the header; an unusable value skips the event', () => {
    const env = newEnv({ kvm: { 'trace_id_header__agentic-product': 'X-Goal' } });
    assert.strictEqual(call(env, Object.assign({ upstream: { status: 200, headers: { 'X-Goal': 'g1' } } }, AGENTIC)).events[0].traceId, 'g1');
    const r = call(env, Object.assign({ upstream: { status: 200, headers: { 'X-Goal': 'x'.repeat(200) } } }, AGENTIC));
    assert.strictEqual(r.ingestCalls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
section('AI_AGENT');

const AGENT = { proxy: 'agent-proxy', headers: { 'x-api-key': 'client-secret-agent' } };

test('AI_AGENT: agentId + sessionId from the upstream response headers; traceId = sessionId', () => {
    const e = call(newEnv(), Object.assign({ upstream: { status: 200, headers: { 'X-Aforo-Agent-Id': 'agent-up', 'X-Aforo-Session-Id': 'sess-1' } } }, AGENT)).events[0];
    assert.strictEqual(e.productType, 'AI_AGENT');
    assert.strictEqual(e.customerId, 'cust-3');
    assert.strictEqual(e.agentId, 'agent-up');
    assert.strictEqual(e.sessionId, 'sess-1');
    assert.strictEqual(e.traceId, 'sess-1');
});

test('AI_AGENT: else agent_id__{p} and messageid; request headers never used', () => {
    const r = call(newEnv(), { proxy: 'agent-proxy', messageid: 'rrt-7', headers: { 'x-api-key': 'client-secret-agent', 'X-Agent-Id': 'evil', 'X-Aforo-Agent-Id': 'evil', 'X-Aforo-Session-Id': 'evil' } });
    const e = r.events[0];
    assert.strictEqual(e.agentId, 'agent-cfg');
    assert.strictEqual(e.sessionId, 'rrt-7');
});

test('AI_AGENT: without agent_id__{p}, the proxy name is the agent (as Kong uses the service)', () => {
    const env = newEnv();
    delete env.kvm['agent_id__agent-product'];
    assert.strictEqual(call(env, AGENT).events[0].agentId, 'agent-proxy');
});

test('AI_AGENT: an unusable X-Aforo-Agent-Id skips the event rather than billing another agent', () => {
    const r = call(newEnv(), Object.assign({ upstream: { status: 200, headers: { 'X-Aforo-Agent-Id': 'a'.repeat(37) } } }, AGENT));
    assert.strictEqual(r.ingestCalls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
section('MCP_SERVER');

const MCP = { proxy: 'mcp-proxy', verb: 'POST', suffix: '', headers: { 'x-api-key': 'client-secret-mcp' } };
const rpc = (method, params, id) => ({ jsonrpc: '2.0', id: id === undefined ? 1 : id, method, params });

test('MCP: tools/call is checked and billed: default_metric, agentId = customer, session from Mcp-Session-Id response header', () => {
    const r = call(newEnv(), Object.assign({
        body: JSON.stringify(rpc('tools/call', { name: 'search', _meta: { agent_id: 'evil' } })),
        upstream: { status: 200, headers: { 'Mcp-Session-Id': 'mcp-sess-1' } }
    }, MCP, { headers: { 'x-api-key': 'client-secret-mcp', 'X-Agent-Id': 'evil', 'Mcp-Session-Id': 'client-sess' } }));
    assert.strictEqual(r.quotaCalls.length, 1);
    assert.deepStrictEqual(JSON.parse(r.quotaCalls[0].body), { customerId: 'cust-4', metricName: 'tool_calls' });
    assert.strictEqual(r.events.length, 1);
    const e = r.events[0];
    assert.strictEqual(e.productType, 'MCP_SERVER');
    assert.strictEqual(e.metricName, 'tool_calls');
    assert.strictEqual(e.toolName, 'search');
    assert.strictEqual(e.agentId, 'cust-4');
    assert.strictEqual(e.sessionId, 'mcp-sess-1');
    assert.strictEqual(e.executionStatus, 'SUCCESS');
});

test('MCP: X-Aforo-Agent-Id from the upstream names the agent', () => {
    const e = call(newEnv(), Object.assign({ body: JSON.stringify(rpc('tools/call', { name: 't' })),
        upstream: { status: 200, headers: { 'X-Aforo-Agent-Id': 'agent-9' } } }, MCP)).events[0];
    assert.strictEqual(e.agentId, 'agent-9');
});

test('MCP: initialize / tools/list / ping are never checked, blocked or billed (even when DENY)', () => {
    const env = newEnv({ quota: () => ({ status: 200, body: '{"decision":"DENY"}' }) });
    for (const m of ['initialize', 'tools/list', 'ping', 'notifications/initialized']) {
        const r = call(env, Object.assign({ body: JSON.stringify(rpc(m, {})) }, MCP));
        assert.strictEqual(r.accessFault, null, m);
        assert.strictEqual(r.quotaCalls.length, 0, m);
        assert.strictEqual(r.ingestCalls.length, 0, m);
    }
});

test('MCP: tools/call is blocked 429 on DENY', () => {
    const env = newEnv({ quota: () => ({ status: 200, body: '{"decision":"DENY","retryAfterMs":4000}' }) });
    const r = call(env, Object.assign({ body: JSON.stringify(rpc('tools/call', { name: 't' })) }, MCP));
    assert.strictEqual(r.accessFault.status, 429);
    assert.strictEqual(r.accessFault.headers['Retry-After'], '4');
});

test('MCP: a JSON-RPC batch bills one event per tools/call, with distinct keys', () => {
    const body = JSON.stringify([rpc('tools/call', { name: 'a' }, 1), rpc('ping', {}, 2), rpc('tools/call', { name: 'b' }, 3)]);
    const r = call(newEnv(), Object.assign({ body, messageid: 'rrt-b', upstream: { status: 200, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'x' } }]) } }, MCP));
    assert.strictEqual(r.events.length, 2);
    assert.deepStrictEqual(r.events.map((e) => e.toolName), ['a', 'b']);
    assert.deepStrictEqual(r.events.map((e) => e.idempotencyKey), ['mcp:tenant-1:rrt-b:1:a', 'mcp:tenant-1:rrt-b:2:b']);
    assert.deepStrictEqual(r.events.map((e) => e.executionStatus), ['SUCCESS', 'ERROR'], 'JSON-RPC error inside a 200');
});

test('MCP: a tools/call without a name is still billed, as "unknown"', () => {
    const r = call(newEnv(), Object.assign({ body: JSON.stringify(rpc('tools/call', null)) }, MCP));
    assert.strictEqual(r.events[0].toolName, 'unknown');
});

test('MCP: a GET (SSE stream) or a non-JSON body bills nothing', () => {
    const env = newEnv();
    assert.strictEqual(call(env, Object.assign({}, MCP, { verb: 'GET' })).ingestCalls.length, 0);
    assert.strictEqual(call(env, Object.assign({ body: 'not json' }, MCP)).ingestCalls.length, 0);
});

test('MCP: a long Mcp-Session-Id is hashed, not dropped', () => {
    const e = call(newEnv(), Object.assign({ body: JSON.stringify(rpc('tools/call', { name: 't' })),
        upstream: { status: 200, headers: { 'Mcp-Session-Id': 's'.repeat(100) } } }, MCP)).events[0];
    assert.ok(/^mcp-[0-9a-f]{56}$/.test(e.sessionId), e.sessionId);
});

// ─────────────────────────────────────────────────────────────────────────
section('Delivery');

test('sync: waits for the 202; a transient per-event error is re-sent once, alone, with the same key', () => {
    let n = 0;
    const env = newEnv({
        kvm: { delivery_mode: 'sync' },
        ingest: (req) => {
            n++;
            const events = JSON.parse(req.body).events;
            if (n === 1) return { status: 202, body: JSON.stringify({ success: true, data: { accepted: 0, failed: events.length, errors: [{ index: 0, message: 'The event could not be stored; retry' }] } }) };
            return { status: 202, body: JSON.stringify({ success: true, data: { accepted: events.length, failed: 0, errors: [] } }) };
        }
    });
    const r = call(env, { headers: KEY, messageid: 'rrt-s' });
    assert.strictEqual(r.ingestCalls.length, 2);
    assert.strictEqual(r.ingestCalls[0].waits, true);
    assert.strictEqual(JSON.parse(r.ingestCalls[1].body).events[0].idempotencyKey, 'rrt-s');
    assert.strictEqual(r.msg.get('aforo.meteringDroppedEvents'), '0');
});

test('sync: a permanent per-event error is dropped and logged, not re-sent', () => {
    const env = newEnv({ kvm: { delivery_mode: 'sync' }, ingest: () => ({ status: 202, body: '{"success":true,"data":{"accepted":0,"failed":1,"errors":[{"index":0,"message":"Unknown metric"}]}}' }) });
    const r = call(env, { headers: KEY });
    assert.strictEqual(r.ingestCalls.length, 1);
    assert.ok(r.msg.prints.some((p) => p.includes('USAGE EVENT REFUSED') && p.includes('Unknown metric')));
});

test('sync: 5xx re-sends the whole batch once; still failing is logged as dropped', () => {
    const env = newEnv({ kvm: { delivery_mode: 'sync' }, ingest: () => ({ status: 503, body: 'down' }) });
    const r = call(env, { headers: KEY });
    assert.strictEqual(r.ingestCalls.length, 2);
    assert.strictEqual(r.msg.get('aforo.meteringDroppedEvents'), '1');
    assert.ok(r.msg.prints.some((p) => p.includes('USAGE EVENT DROPPED')));
});

test('sync: max_retries = 0 never re-sends', () => {
    const env = newEnv({ kvm: { delivery_mode: 'sync', max_retries: '0' }, ingest: () => ({ status: 503 }) });
    assert.strictEqual(call(env, { headers: KEY }).ingestCalls.length, 1);
});

test('async (default): one send, nothing waited for, nothing read back', () => {
    const r = call(newEnv({ ingest: () => ({ status: 503 }) }), { headers: KEY });
    assert.strictEqual(r.ingestCalls.length, 1);
    assert.strictEqual(r.ingestCalls[0].waits, false);
    assert.strictEqual(r.msg.get('aforo.calloutResponse.status.code'), null);
});

const TOPIC = 'projects/my-gcp-project/topics/aforo-metering';

test('pubsub: one Pub/Sub message per call with the events, no HTTP send', () => {
    const r = call(newEnv({ kvm: { delivery_mode: 'pubsub', pubsub_topic: TOPIC } }), { headers: KEY, messageid: 'ps-1' });
    assert.strictEqual(r.ingestCalls.length, 0);
    assert.strictEqual(r.publishes.length, 1);
    assert.strictEqual(r.publishes[0].topic, TOPIC);
    const events = JSON.parse(r.publishes[0].data).events;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].idempotencyKey, 'ps-1', 'key frozen to messageid, so a redelivered message deduplicates');
    assert.strictEqual(events[0].customerId, 'cust-1');
});

test('pubsub: MCP batch is one message carrying every tools/call event', () => {
    const env = newEnv({ kvm: { delivery_mode: 'pubsub', pubsub_topic: TOPIC } });
    const body = JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'b' } }
    ]);
    const r = call(env, { proxy: 'mcp-proxy', verb: 'POST', suffix: '', body, headers: { 'x-api-key': 'client-secret-mcp' } });
    assert.strictEqual(r.publishes.length, 1);
    assert.strictEqual(JSON.parse(r.publishes[0].data).events.length, 2);
});

test('pubsub: a failed publish never fails the call', () => {
    const r = call(newEnv({ kvm: { delivery_mode: 'pubsub', pubsub_topic: TOPIC }, pubsub: () => ({ error: 'PERMISSION_DENIED' }) }), { headers: KEY });
    assert.strictEqual(r.meteringFault, null);
    assert.strictEqual(r.publishes.length, 1);
    assert.strictEqual(r.ingestCalls.length, 0);
});

test('pubsub without pubsub_topic: falls back to async HTTP delivery, nothing published', () => {
    const r = call(newEnv({ kvm: { delivery_mode: 'pubsub' } }), { headers: KEY });
    assert.strictEqual(r.publishes.length, 0);
    assert.strictEqual(r.ingestCalls.length, 1);
    assert.strictEqual(r.ingestCalls[0].waits, false);
});

test('async and sync never publish to Pub/Sub, even with pubsub_topic set', () => {
    for (const mode of [undefined, 'async', 'sync']) {
        const kvm = { pubsub_topic: TOPIC };
        if (mode) kvm.delivery_mode = mode;
        const r = call(newEnv({ kvm }), { headers: KEY });
        assert.strictEqual(r.publishes.length, 0, String(mode));
        assert.strictEqual(r.ingestCalls.length >= 1, true, String(mode));
    }
});

test('refused or unmetered calls publish nothing', () => {
    const env = newEnv({ kvm: { delivery_mode: 'pubsub', pubsub_topic: TOPIC } });
    assert.strictEqual(call(env, {}).publishes.length, 0, 'missing key: 401');
    assert.strictEqual(call(env, { headers: KEY, suffix: '/health' }).publishes.length, 0, 'excluded path');
});

// ─────────────────────────────────────────────────────────────────────────
section('Optional Aforo JWT');

test('jwt_validation_enabled: claims copied, keyId in metadata, headers forwarded', () => {
    const env = newEnv({
        kvm: { jwt_validation_enabled: 'true', aforo_jwks_uri: 'https://auth.aforo.ai/jwks', aforo_jwt_issuer: 'https://auth.aforo.ai' },
        jwt: (token, cfg) => (token === 'good' && cfg.jwksUri && cfg.issuer ? { tenant_id: TENANT, customer_id: 'cust-1', key_id: 'key-7' } : null)
    });
    const r = call(env, { headers: Object.assign({ authorization: 'Bearer good' }, KEY) });
    assert.strictEqual(r.accessFault, null);
    assert.strictEqual(r.events[0].metadata.keyId, 'key-7');
    assert.strictEqual(r.upstreamHeaders['x-key-id'], 'key-7');
    assert.strictEqual(r.events[0].customerId, 'cust-1', 'still the app attribute');
});

test('jwt_validation_enabled: no token 401; token for another tenant 401', () => {
    const env = newEnv({
        kvm: { jwt_validation_enabled: 'true', aforo_jwks_uri: 'u', aforo_jwt_issuer: 'i' },
        jwt: (token) => (token === 'other' ? { tenant_id: 'tenant-2' } : null)
    });
    assert.strictEqual(call(env, { headers: KEY }).accessFault.status, 401);
    const r = call(env, { headers: Object.assign({ authorization: 'Bearer other' }, KEY) });
    assert.strictEqual(r.accessFault.status, 401);
    assert.strictEqual(JSON.parse(r.accessFault.body).error, 'invalid_token');
});

report('apigee flow tests');
