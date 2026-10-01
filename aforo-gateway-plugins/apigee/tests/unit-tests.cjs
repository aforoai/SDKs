/**
 * Unit tests for Apigee aforo-metering JavaScript policy.
 * Run with: node tests/unit-tests.cjs
 *
 * Uses a minimal mock of the Apigee context object. Each test re-reads
 * and re-evaluates the policy source so no state leaks between tests.
 */

const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.resolve(__dirname, '../sharedflowbundle/resources/jsc/aforo-metering.js');
const POLICY_SRC = fs.readFileSync(POLICY_PATH, 'utf8');

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
    if (condition) {
        testsPassed++;
        console.log('  PASS: ' + message);
    } else {
        testsFailed++;
        console.error('  FAIL: ' + message);
    }
}

function assertEquals(actual, expected, message) {
    if (actual === expected) {
        testsPassed++;
        console.log('  PASS: ' + message);
    } else {
        testsFailed++;
        console.error('  FAIL: ' + message + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
}

// ── Mock Apigee context ──
function createMockContext(variables) {
    const vars = Object.assign({
        'request.verb': 'GET',
        'proxy.pathsuffix': '/v1/accounts/123',
        'response.status.code': '200',
        'target.latency': '47',
        'messageid': 'msg-001',
        'developer.app.name': 'my-developer-app',
        'developer.email': 'dev@example.com',
        'aforo.customer_id': 'cust_abc',
        'aforo.mcpEnabled': 'false',
        'aforo.mcpProductId': '',
        'aforo.defaultMetric': 'api_calls',
        'aforo.metricMappings': JSON.stringify([
            { matchType: 'PREFIX', value: '/v1/sms', metricName: 'sms_sent' },
            { matchType: 'EXACT', value: '/v1/otp/verify', metricName: 'otp_verified' },
            { matchType: 'CONTAINS', value: '/calls/', metricName: 'call_minutes' },
        ]),
        'request.header.traceparent': null,
        'request.header.tracestate': null,
        'request.header.x-trace-id': null,
        'request.header.x-request-id': null,
        'request.header.Mcp-Session-Id': '',
        'request.header.X-Agent-Id': '',
        'request.content': null,
    }, variables);

    let storedPayload = null;

    return {
        getVariable: function(name) { return vars[name] || null; },
        setVariable: function(name, value) {
            if (name === 'aforo.eventPayload') storedPayload = value;
            vars[name] = value;
        },
        getStoredPayload: function() { return storedPayload; },
        vars: vars,
    };
}

function runPolicy(ctx) {
    // Apigee JS scripts access a global `context` object. Eval the
    // policy source in a scope where `context` is our mock.
    const context = ctx;  // eslint-disable-line no-unused-vars
    const print = function() {};  // Apigee's JS runtime provides print()
    eval(POLICY_SRC);
}

// ── Tests ──

console.log('\nApigee Aforo Metering — Unit Tests\n');

// Test 1: Standard API event includes W3C trace context
console.log('Test 1: Standard API event includes W3C trace context');
(function() {
    const ctx = createMockContext({
        'request.header.traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'request.header.tracestate': 'congo=t61rcWkgMzE',
        'request.header.x-trace-id': 'legacy-123',
        'request.header.x-request-id': 'req-456',
    });
    runPolicy(ctx);

    const payload = JSON.parse(ctx.getStoredPayload());
    const event = payload.events[0];

    assert(event.trace !== undefined, 'trace object exists');
    assertEquals(event.trace.traceparent,
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'traceparent captured');
    assertEquals(event.trace.tracestate, 'congo=t61rcWkgMzE', 'tracestate captured');
    assertEquals(event.trace.xTraceId, 'legacy-123', 'xTraceId captured');
    assertEquals(event.trace.xRequestId, 'req-456', 'xRequestId captured');
    assertEquals(event.endpointPath, '/v1/accounts/123', 'endpointPath is top-level');
    assertEquals(event.httpMethod, 'GET', 'httpMethod is top-level');
    assertEquals(event.statusCode, 200, 'statusCode is top-level');
})();

// Test 2: Absent trace headers produce null values
console.log('\nTest 2: Absent trace headers produce null values');
(function() {
    const ctx = createMockContext({});
    runPolicy(ctx);

    const payload = JSON.parse(ctx.getStoredPayload());
    const event = payload.events[0];

    assert(event.trace !== undefined, 'trace object exists even without headers');
    assertEquals(event.trace.traceparent, null, 'traceparent is null when absent');
    assertEquals(event.trace.tracestate, null, 'tracestate is null when absent');
})();

// Test 3: Security regression — X-Agent-Id header is IGNORED (IDOR finding #11)
console.log('\nTest 3: X-Agent-Id header is not trusted (security regression guard)');
(function() {
    const ctx = createMockContext({
        'aforo.mcpEnabled': 'true',
        'request.verb': 'POST',
        'request.content': JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { name: 'search_docs' }
            // NOTE: no params._meta.agent_id — so agentId should stay empty
        }),
        // Attacker injects a forged header trying to impersonate an agent
        'request.header.X-Agent-Id': 'agent_forged_by_attacker'
    });
    runPolicy(ctx);

    const payload = JSON.parse(ctx.getStoredPayload());
    const event = payload.events[0];

    assertEquals(event.metricName, 'mcp_server.tool_invocations', 'MCP detection triggered');
    // MCP_SERVER requires agentId: without one the configured type is kept.
    assertEquals(event.productType, 'API', 'no agentId → not MCP_SERVER (configured product_type kept)');
    assertEquals(event.toolName, 'search_docs', 'toolName from JSON-RPC payload');
    assertEquals(event.agentId, '',
        'agentId is EMPTY (forged X-Agent-Id header is ignored) — IDOR fix 2026-04-23');
})();

// Test 4: Security regression — valid agent_id in payload is used
console.log('\nTest 4: agent_id from JSON-RPC params._meta is trusted');
(function() {
    const ctx = createMockContext({
        'aforo.mcpEnabled': 'true',
        'request.verb': 'POST',
        'request.content': JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
                name: 'search_docs',
                _meta: { agent_id: 'agent_legit' }
            }
        }),
        // Attacker still tries forgery — must still be ignored
        'request.header.X-Agent-Id': 'agent_forged_by_attacker'
    });
    runPolicy(ctx);

    const payload = JSON.parse(ctx.getStoredPayload());
    const event = payload.events[0];

    assertEquals(event.agentId, 'agent_legit',
        'agentId comes from JSON-RPC payload, not the forged header');
    assertEquals(event.productType, 'MCP_SERVER', 'toolName + agentId → MCP_SERVER');
})();

function eventOf(ctx) {
    const raw = ctx.getStoredPayload();
    return raw ? JSON.parse(raw).events[0] : null;
}

// Test 5: metric comes from mappings / default metric, never {method} {path}
console.log('\nTest 5: Metric resolution (mappings, default; route-shaped only if configured)');
(function() {
    let ctx = createMockContext({});
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'api_calls', 'unmapped path → default_metric, not "GET /v1/accounts/123"');
    ctx = createMockContext({ 'request.verb': 'POST', 'proxy.pathsuffix': '/v1/sms/send' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'sms_sent', 'PREFIX mapping');
    ctx = createMockContext({ 'proxy.pathsuffix': '/v1/otp/verify' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'otp_verified', 'EXACT mapping');
    ctx = createMockContext({ 'proxy.pathsuffix': '/v2/calls/9' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'call_minutes', 'CONTAINS mapping');
    ctx = createMockContext({ 'proxy.basepath': '/svc', 'proxy.pathsuffix': '/v1/sms/x' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'api_calls', 'matching uses basepath + pathsuffix');
    assertEquals(eventOf(ctx).endpointPath, '/svc/v1/sms/x', 'endpointPath includes basepath');
    ctx = createMockContext({ 'aforo.metricMappings': 'not json' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'api_calls', 'invalid mappings JSON → default metric');
    ctx = createMockContext({ 'aforo.metricMappings': null, 'aforo.metricNamePattern': '{method} {path}' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'GET /v1/accounts/123', 'pattern honoured only when explicitly set');

    // Merged precedence: mapping -> metric_name_pattern -> default_metric -> api_calls.
    ctx = createMockContext({ 'private.aforo.metricNamePattern': '{method} {path}', 'proxy.pathsuffix': '/v1/sms/send' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'sms_sent', 'a mapping match beats metric_name_pattern');
    ctx = createMockContext({ 'private.aforo.metricNamePattern': '{method} {path}' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'GET /v1/accounts/123', 'metric_name_pattern beats default_metric');
    ctx = createMockContext({ 'aforo.defaultMetric': null, 'private.aforo.defaultMetric': 'requests' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'requests', 'KVM default_metric (private.aforo.defaultMetric)');
    ctx = createMockContext({ 'aforo.defaultMetric': null, 'aforo.metricMappings': null });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'api_calls', 'nothing configured -> api_calls');
    ctx = createMockContext({ 'aforo.metricMappings': null,
        'private.aforo.metricMappings': JSON.stringify([{ matchType: 'prefix', value: '/v1/acc', metricName: ' accounts ' }]) });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'accounts', 'mappings read from private.aforo.*; matchType case-insensitive; name trimmed');
    ctx = createMockContext({ 'private.aforo.metricNamePattern': '{method} {basepath}|{pathsuffix}|{path}',
        'proxy.basepath': '/svc', 'proxy.pathsuffix': '/a' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'GET /svc|/a|/svc/a', 'pattern placeholders {basepath} {pathsuffix} {path}');

    // A metric name the ingestor cannot take is not sent.
    ctx = createMockContext({ 'aforo.metricMappings': JSON.stringify([{ matchType: 'PREFIX', value: '/v1', metricName: 'm'.repeat(256) }]) });
    runPolicy(ctx);
    assertEquals(ctx.getStoredPayload(), null, 'metric name > 255 chars -> no event');
    assertEquals(ctx.vars['aforo.skip'], 'true', 'and aforo.skip is set');
    ctx = createMockContext({ 'aforo.metricMappings': JSON.stringify([{ matchType: 'PREFIX', value: '/v1', metricName: '   ' }]) });
    runPolicy(ctx);
    assertEquals(ctx.getStoredPayload(), null, 'blank mapped metric name -> no event');
    ctx = createMockContext({ 'aforo.metricMappings': JSON.stringify({ not: 'an array' }) });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).metricName, 'api_calls', 'mappings that are not an array are ignored');
})();

// Test 6: customer identity
console.log('\nTest 6: customerId comes from a verified source; never a secret; none -> no event');
(function() {
    const NO_APP = { 'developer.app.name': null, 'developer.email': null };
    let ctx = createMockContext({});
    runPolicy(ctx);
    assertEquals(eventOf(ctx).customerId, 'cust_abc', 'customerId = aforo.customer_id (VerifyJWT claim) first');

    ctx = createMockContext({ 'aforo.customer_id': null });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).customerId, 'my-developer-app', 'no JWT claim -> developer.app.name (VerifyAPIKey)');
    ctx = createMockContext({ 'aforo.customer_id': null, 'developer.app.name': null });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).customerId, 'dev@example.com', 'then developer.email');
    ctx = createMockContext({ 'aforo.customer_id': null, 'private.aforo.customerIdSource': 'consumer' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).customerId, 'my-developer-app', 'customer_id_source "consumer" (installer default) = developer app');

    ctx = createMockContext(Object.assign({ 'aforo.customer_id': null }, NO_APP));
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.sendEvent'], 'false', 'no identity -> not sent');
    assertEquals(ctx.vars['aforo.skip'], 'true', 'no identity -> aforo.skip');
    assertEquals(ctx.vars['aforo.meteringSend'] || null, null, 'no identity -> not marked for sending');
    assertEquals(ctx.vars['aforo.skipReason'], 'no customerId', 'skip reason recorded');
    assertEquals(ctx.getStoredPayload(), null, 'no identity -> no payload (never customerId "" / unknown)');

    ctx = createMockContext({ 'aforo.customer_id': null, 'private.aforo.customerIdSource': 'jwt' });
    runPolicy(ctx);
    assertEquals(ctx.getStoredPayload(), null, 'customer_id_source "jwt": developer app is not used');

    ctx = createMockContext({ 'aforo.customer_id': null,
        'aforo.customerIdSource': 'flow_variable:verifyapikey.VerifyKey.app.aforo_customer_id',
        'verifyapikey.VerifyKey.app.aforo_customer_id': 'cust_from_app' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).customerId, 'cust_from_app', 'customer_id_source flow_variable');
    ctx = createMockContext({ 'aforo.customer_id': null,
        'aforo.customerIdSource': 'flow_variable:verifyapikey.VerifyKey.app.aforo_customer_id' });
    runPolicy(ctx);
    assertEquals(ctx.getStoredPayload(), null, 'flow_variable configured but empty -> no event (no developer-app fallback)');

    ctx = createMockContext({ 'aforo.customer_id': null,
        'aforo.customerIdSource': 'flow_variable:request.header.x-customer-id',
        'request.header.x-customer-id': 'spoofed' });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.sendEvent'], 'false', 'client-controlled request.* variable refused');

    // A secret or a client IP is never the customer.
    [['verifyapikey.VerifyKey.client_id', 'key-abc'], ['apiproxy.consumerkey', 'key-abc'],
     ['request.queryparam.apikey', 'key-abc'], ['client.ip', '10.0.0.1'], ['proxy.client.ip', '10.0.0.1'],
     ['oauthv2accesstoken.X.access_token', 'tok'], ['verifyapikey.VerifyKey.client_secret', 's']].forEach(function(pair) {
        const vars = { 'aforo.customer_id': null, 'aforo.customerIdSource': 'flow_variable:' + pair[0] };
        vars[pair[0]] = pair[1];
        const c = createMockContext(vars);
        runPolicy(c);
        assertEquals(c.getStoredPayload(), null, 'flow_variable:' + pair[0] + ' refused');
    });
    ctx = createMockContext({ 'aforo.customer_id': null, 'apiproxy.consumerkey': 'key-abc', 'client.ip': '10.0.0.1',
        'developer.app.name': null, 'developer.email': null });
    runPolicy(ctx);
    assertEquals(ctx.getStoredPayload(), null, 'consumer key / client IP are never read as the customer');

    ctx = createMockContext({ 'aforo.customer_id': 'x'.repeat(65) });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.sendEvent'], 'false', 'customerId > 64 chars not sent');
    ctx = createMockContext({ 'aforo.customer_id': 'x'.repeat(64) });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.sendEvent'], 'true', 'customerId of exactly 64 chars is sent');
})();

// Test 7: skips
console.log('\nTest 7: OPTIONS, exclude_paths, exclude_status_codes, zero quantity are not sent');
(function() {
    let ctx = createMockContext({ 'request.verb': 'OPTIONS' });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.sendEvent'], 'false', 'OPTIONS not metered');
    ctx = createMockContext({ 'aforo.excludePaths': '/health, /v1/accounts' });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.skipReason'], 'excluded path', 'exclude_paths applied');
    ctx = createMockContext({ 'aforo.excludeStatusCodes': '401,403,200' });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.skipReason'], 'excluded status code', 'exclude_status_codes applied');
    ctx = createMockContext({ 'aforo.quantitySource': 'response_size', 'response.header.Content-Length': '0' });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.skipReason'], 'quantity <= 0', 'zero-byte response not metered');
    ctx = createMockContext({ 'aforo.quantitySource': 'response_size', 'response.header.Content-Length': '512' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).quantity, 512, 'response_size quantity');
    ctx = createMockContext({});
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.sendEvent'], 'true', 'normal request is sent');
    assertEquals(eventOf(ctx).idempotencyKey, 'msg-001', 'idempotencyKey = messageid');
    assert(!isNaN(Date.parse(eventOf(ctx).occurredAt)), 'occurredAt is ISO-8601');

    // Without a messageid the key must still be unique per event: two distinct
    // requests sharing one key would make the ingestor answer DUPLICATE and
    // silently drop the second, under-billing the caller.
    const a = createMockContext({ 'messageid': '' });
    runPolicy(a);
    const b = createMockContext({ 'messageid': '' });
    runPolicy(b);
    assert(!!eventOf(a).idempotencyKey, 'fallback idempotencyKey is non-empty');
    assert(eventOf(a).idempotencyKey !== eventOf(b).idempotencyKey,
        'two messageid-less requests get different idempotency keys');
})();

// Test 7b: productType
console.log('\nTest 7b: productType from KVM product_type (default API), per-type required fields');
(function() {
    let ctx = createMockContext({});
    runPolicy(ctx);
    assertEquals(eventOf(ctx).productType, 'API', 'default productType API');
    ctx = createMockContext({ 'aforo.productType': ' agentic_api ' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).productType, 'AGENTIC_API', 'KVM value trimmed and upper-cased');
    ctx = createMockContext({ 'aforo.productType': 'NEW_TYPE' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).productType, 'NEW_TYPE', 'unknown type passed through');
    ctx = createMockContext({ 'aforo.productType': 'GRAPHQL_API' });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.sendEvent'], 'false', 'GRAPHQL_API without gqlOperationType not sent');
    assertEquals(ctx.vars['aforo.skipReason'], 'productType GRAPHQL_API missing gqlOperationType', 'skip reason names the field');
    ctx = createMockContext({ 'aforo.productType': 'AI_AGENT', 'request.header.Mcp-Session-Id': 's1',
        'request.header.X-Agent-Id': 'agent_forged' });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.sendEvent'], 'false', 'AI_AGENT never takes agentId from X-Agent-Id');
    const xml = fs.readFileSync(path.resolve(__dirname, '../sharedflowbundle/policies/AforoMeteringReadConfig.xml'), 'utf8');
    assert(/<Get assignTo="private\.aforo\.productType">\s*<Key><Parameter>product_type<\/Parameter>/.test(xml), 'KVM product_type read into private.aforo.productType');
    ctx = createMockContext({ 'private.aforo.productType': 'ai_agent ', 'aforo.productType': 'API' });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.skipReason'], 'productType AI_AGENT missing agentId+sessionId', 'the KVM (private) value wins over aforo.productType');
    // An explicit non-API type is not replaced by trace detection.
    ctx = createMockContext({ 'private.aforo.productType': 'NEW_TYPE',
        'request.header.traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).productType, 'NEW_TYPE', 'configured non-API type kept when a traceparent is present');
})();

// Test 8: bundle XML contract checks (static)
console.log('\nTest 8: bundle sends X-API-Key only; JWT steps are opt-in');
(function() {
    const bundle = path.resolve(__dirname, '../sharedflowbundle');
    const send = fs.readFileSync(path.join(bundle, 'policies/AforoMeteringSendEvent.xml'), 'utf8');
    assert(/<Header name="X-API-Key">/.test(send), 'ServiceCallout sets X-API-Key');
    assert(!/<Header name="Authorization">/.test(send), 'no Authorization header');
    assert(!/<Header name="X-Tenant-Id">/.test(send), 'no X-Tenant-Id header');
    const flow = fs.readFileSync(path.join(bundle, 'sharedflows/default.xml'), 'utf8');
    const jwtStep = flow.match(/<Name>AforoJwtValidation<\/Name>\s*<Condition>([^<]*)<\/Condition>/);
    assert(jwtStep && /aforo\.jwtValidationEnabled = "true"/.test(jwtStep[1]), 'AforoJwtValidation gated on jwt_validation_enabled');
    const sendStep = flow.match(/<Name>AforoMeteringSendEvent<\/Name>\s*<Condition>([^<]*)<\/Condition>/);
    assert(sendStep && /aforo\.meteringSend = "true"/.test(sendStep[1]) && /aforo\.skip != "true"/.test(sendStep[1]),
        'send gated on aforo.meteringSend and aforo.skip');
    const retry = fs.readFileSync(path.join(bundle, 'policies/AforoMeteringSendEventRetry1.xml'), 'utf8');
    assert(/<Header name="X-API-Key">/.test(retry) && !/<Header name="Authorization">/.test(retry) &&
        !/<Header name="X-Tenant-Id">/.test(retry), 'the retry sends X-API-Key only');
    const raise = fs.readFileSync(path.join(bundle, 'policies/AforoMarginGuardRaiseFault.xml'), 'utf8');
    assert(!/\?/.test(raise.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '')), 'no ternary in RaiseFault templates');
})();

// Test 5: Idempotency key is FROZEN — standard key equals messageid, no clock component
console.log('\nTest 5: Standard idempotency key is stable request identity (no clock)');
(function() {
    const ctx = createMockContext({});
    runPolicy(ctx);
    const event = JSON.parse(ctx.getStoredPayload()).events[0];

    assertEquals(event.idempotencyKey, 'msg-001',
        'standard key is exactly messageid — no Date.now() suffix');

    // Simulated retry / replay: a second evaluation with the same request
    // identity MUST produce the identical key so the ingestor dedups.
    const ctx2 = createMockContext({});
    runPolicy(ctx2);
    const event2 = JSON.parse(ctx2.getStoredPayload()).events[0];
    assertEquals(event2.idempotencyKey, event.idempotencyKey,
        'key identical across re-evaluation — retry re-send dedups');
})();

// Test 6: MCP idempotency key is FROZEN — mcp:apigee:{messageid}:{tool}, no clock component
console.log('\nTest 6: MCP idempotency key is stable request identity (no clock)');
(function() {
    const mcpVars = {
        'aforo.mcpEnabled': 'true',
        'request.verb': 'POST',
        'request.content': JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { name: 'search_docs' }
        })
    };
    const ctx = createMockContext(mcpVars);
    runPolicy(ctx);
    const event = JSON.parse(ctx.getStoredPayload()).events[0];

    assertEquals(event.idempotencyKey, 'mcp:apigee:msg-001:search_docs',
        'MCP key is mcp:apigee:{messageid}:{toolName} — no Date.now() suffix');

    const ctx2 = createMockContext(mcpVars);
    runPolicy(ctx2);
    const event2 = JSON.parse(ctx2.getStoredPayload()).events[0];
    assertEquals(event2.idempotencyKey, event.idempotencyKey,
        'MCP key identical across re-evaluation — retry re-send dedups');
})();

// Test 7: Key fallback chain — x-request-id used when messageid is absent
console.log('\nTest 7: Key falls back to x-request-id when messageid is absent');
(function() {
    const ctx = createMockContext({
        'messageid': '',
        'request.header.x-request-id': 'client-req-789'
    });
    runPolicy(ctx);
    const event = JSON.parse(ctx.getStoredPayload()).events[0];
    assertEquals(event.idempotencyKey, 'client-req-789',
        'fallback key is the stable x-request-id header, not a clock value');
})();

// Test 8: The retry re-sends the FROZEN payload variable — same key both attempts
console.log('\nTest 8: Frozen payload re-send carries an identical key (dedup-safe retry)');
(function() {
    const ctx = createMockContext({});
    runPolicy(ctx);
    // The ServiceCallout retry steps reference {aforo.eventPayload} — the
    // same flow variable the primary send used. Simulate both attempts
    // reading it and assert the key bytes match.
    const attempt1 = JSON.parse(ctx.getStoredPayload()).events[0].idempotencyKey;
    const attempt2 = JSON.parse(ctx.getStoredPayload()).events[0].idempotencyKey;
    assertEquals(attempt2, attempt1, 'retry attempt sends byte-identical key');
    assert(!/:\d{13}$/.test(attempt1), 'key carries no trailing epoch-millis timestamp');
})();

// ═══ AGENTIC_API detection (P0-5, docs/final/111 Session 4) ═══
// Per descriptor eventSchema.inferenceRule = HAS_TRACE, an event with a
// resolvable W3C traceparent (or x-trace-id fallback) is classified as
// AGENTIC_API. MCP JSON-RPC still wins when both signals coexist.

// Test 9: traceparent present + non-JSON-RPC → productType=AGENTIC_API
console.log('\nTest 9: traceparent + non-MCP request classifies as AGENTIC_API');
(function() {
    const ctx = createMockContext({
        'request.header.traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'request.verb': 'POST',
        'proxy.pathsuffix': '/v1/orchestrate',
        'response.status.code': '200',
    });
    runPolicy(ctx);
    const event = JSON.parse(ctx.getStoredPayload()).events[0];

    assertEquals(event.productType, 'AGENTIC_API', 'productType set to AGENTIC_API');
    assertEquals(event.traceId, '4bf92f3577b34da6a3ce929d0e0e4736',
        'traceId is the 32-hex trace_id field from traceparent (lowercased)');
    // Descriptor requiredFields — must be top-level, not metadata
    assertEquals(event.endpointPath, '/v1/orchestrate', 'endpointPath top-level');
    assertEquals(event.httpMethod, 'POST', 'httpMethod top-level');
    assertEquals(event.statusCode, 200, 'statusCode top-level');
})();

// Test 10: MCP tools/call + traceparent → MCP wins
console.log('\nTest 10: MCP tools/call + traceparent → productType stays MCP_SERVER');
(function() {
    const ctx = createMockContext({
        'aforo.mcpEnabled': 'true',
        'request.verb': 'POST',
        'request.content': JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { name: 'search_docs', _meta: { agent_id: 'agent_1' } }
        }),
        'request.header.traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    runPolicy(ctx);
    const event = JSON.parse(ctx.getStoredPayload()).events[0];

    assertEquals(event.productType, 'MCP_SERVER',
        'MCP wins when both signals present (JSON-RPC + traceparent)');
    assertEquals(event.toolName, 'search_docs', 'toolName still populated from JSON-RPC');
    assert(event.traceId === undefined,
        'MCP branch does not stamp top-level traceId (would confuse routing)');
})();

// Test 11: neither traceparent nor JSON-RPC → productType unset (API default)
console.log('\nTest 11: no trace signal → productType is the configured type (default API)');
(function() {
    const ctx = createMockContext({});
    runPolicy(ctx);
    const event = JSON.parse(ctx.getStoredPayload()).events[0];

    assertEquals(event.productType, 'API',
        'productType is the default API — never AGENTIC_API without a trace id');
    assert(event.traceId === undefined, 'traceId unset when no trace header present');
})();

// Test 12: malformed traceparent → fall through (fail-safe)
console.log('\nTest 12: malformed traceparent → not AGENTIC_API (fail-safe)');
(function() {
    // Wrong field count — 3 fields instead of 4
    const ctx1 = createMockContext({
        'request.header.traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-01',
    });
    runPolicy(ctx1);
    let event = JSON.parse(ctx1.getStoredPayload()).events[0];
    assert(event.productType === 'API' && event.traceId === undefined, 'wrong field count rejected');

    // Invalid version "ff" per W3C spec
    const ctx2 = createMockContext({
        'request.header.traceparent': 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    runPolicy(ctx2);
    event = JSON.parse(ctx2.getStoredPayload()).events[0];
    assert(event.productType === 'API' && event.traceId === undefined, 'version=ff rejected');

    // All-zero trace_id — invalid per W3C spec
    const ctx3 = createMockContext({
        'request.header.traceparent': '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    });
    runPolicy(ctx3);
    event = JSON.parse(ctx3.getStoredPayload()).events[0];
    assert(event.productType === 'API' && event.traceId === undefined, 'all-zero trace_id rejected');

    // All-zero parent_id — invalid per W3C spec
    const ctx4 = createMockContext({
        'request.header.traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
    });
    runPolicy(ctx4);
    event = JSON.parse(ctx4.getStoredPayload()).events[0];
    assert(event.productType === 'API' && event.traceId === undefined, 'all-zero parent_id rejected');

    // Non-hex trace_id
    const ctx5 = createMockContext({
        'request.header.traceparent': '00-ZZZZ2f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    runPolicy(ctx5);
    event = JSON.parse(ctx5.getStoredPayload()).events[0];
    assert(event.productType === 'API' && event.traceId === undefined, 'non-hex trace_id rejected');
})();

// Test 13: x-trace-id fallback for non-OTel callers
console.log('\nTest 13: x-trace-id fallback classifies as AGENTIC_API');
(function() {
    // Non-OTel client: no traceparent, but sends x-trace-id
    const ctx = createMockContext({
        'request.header.traceparent': null,
        'request.header.x-trace-id': 'legacy-agent-run-42',
    });
    runPolicy(ctx);
    const event = JSON.parse(ctx.getStoredPayload()).events[0];

    assertEquals(event.productType, 'AGENTIC_API',
        'x-trace-id fallback triggers AGENTIC_API classification');
    assertEquals(event.traceId, 'legacy-agent-run-42',
        'traceId carries the raw x-trace-id value (arbitrary string per descriptor)');
})();

// Test 14: traceparent takes precedence over x-trace-id
console.log('\nTest 14: traceparent takes precedence over x-trace-id');
(function() {
    const ctx = createMockContext({
        'request.header.traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'request.header.x-trace-id': 'legacy-would-lose',
    });
    runPolicy(ctx);
    const event = JSON.parse(ctx.getStoredPayload()).events[0];

    assertEquals(event.traceId, '4bf92f3577b34da6a3ce929d0e0e4736',
        'W3C traceparent wins over x-trace-id when both present');
})();

// ═══ Compound metering policy (aforo-compound-metering.js) ═══
// A+ compound-key freeze (2026-07-05): the compound correlationId is the
// dedup ROOT (server decomposes correlationId:metricName[:dim]:index),
// so it must be UUID-shaped AND stable per transaction.

const COMPOUND_PATH = path.resolve(__dirname, '../sharedflowbundle/resources/jsc/aforo-compound-metering.js');
const COMPOUND_SRC = fs.readFileSync(COMPOUND_PATH, 'utf8');
const nodeCrypto = require('node:crypto');

function runCompoundPolicy(ctx) {
    const context = ctx;  // eslint-disable-line no-unused-vars
    eval(COMPOUND_SRC);
    // Non-strict eval leaks declarations into this scope — hand the
    // embedded helpers back so tests can exercise them directly.
    return {
        md5hex: typeof md5hex === 'function' ? md5hex : null,
        deriveCorrelationId: typeof deriveCorrelationId === 'function' ? deriveCorrelationId : null,
    };
}

function compoundVars(overrides) {
    return Object.assign({
        'aforo.compound_metering_enabled': 'true',
        'response.content': JSON.stringify({ usage: { prompt_tokens: 500, completion_tokens: 200 } }),
        'aforo.response_extraction_paths': JSON.stringify({
            '$.usage.prompt_tokens': 'input-tokens',
            '$.usage.completion_tokens': 'output-tokens',
        }),
        'aforo.response_extraction_dimensions': '',
        'aforo.customer_id': 'cust_abc',
        'messageid': 'rrt-045d5d40ec4338cf9-b-ho-24818-42246656-1',
        'request.header.x-request-id': null,
        'apiproxy.name': 'test-proxy',
        'environment.name': 'test',
        'response.status.code': '200',
    }, overrides);
}

const UUID_V3_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[34][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function expectedCorrelationId(seed) {
    const hex = nodeCrypto.createHash('md5').update('aforo-compound:' + seed).digest('hex');
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-3' + hex.slice(13, 16) +
        '-' + variant + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

// Test C1: embedded pure-JS MD5 matches node:crypto (incl. padding edges)
console.log('\nTest C1: embedded MD5 matches node:crypto byte-for-byte');
(function() {
    const { md5hex } = runCompoundPolicy(createMockContext(compoundVars({
        'aforo.compound_metering_enabled': 'false' // helpers only, skip main block
    })));
    assert(md5hex !== null, 'md5hex helper is defined');
    const vectors = [
        '',                                                     // empty
        'a',
        'aforo-compound:rrt-045d5d40ec4338cf9-b-ho-24818-42246656-1',
        'The quick brown fox jumps over the lazy dog',
        'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63),         // padding edges
        'x'.repeat(64), 'x'.repeat(65), 'x'.repeat(130),        // multi-block
    ];
    for (const v of vectors) {
        const expected = nodeCrypto.createHash('md5').update(v).digest('hex');
        assertEquals(md5hex(v), expected, 'md5("' + (v.length > 20 ? v.slice(0, 12) + '…len' + v.length : v) + '")');
    }
})();

// Test C2: messageid path — deterministic, UUID-shaped, stable across re-evaluation
console.log('\nTest C2: compound correlationId frozen to messageid (stable + UUID-shaped)');
(function() {
    const ctx1 = createMockContext(compoundVars({}));
    runCompoundPolicy(ctx1);
    const evt1 = JSON.parse(ctx1.getVariable('aforo.compound_event'));
    assert(UUID_V3_RE.test(evt1.correlationId),
        'correlationId is a valid v3-style UUID (raw messageid would 400 on the UUID-typed DTO)');
    assertEquals(evt1.correlationId,
        expectedCorrelationId('rrt-045d5d40ec4338cf9-b-ho-24818-42246656-1'),
        'correlationId derived purely from messageid (no entropy)');

    const ctx2 = createMockContext(compoundVars({}));
    runCompoundPolicy(ctx2);
    const evt2 = JSON.parse(ctx2.getVariable('aforo.compound_event'));
    assertEquals(evt2.correlationId, evt1.correlationId,
        'correlationId identical across re-evaluation — retry/redelivery dedups');
    assertEquals(evt1.measurements.length, 2, 'both LLM measurements extracted');
})();

// Test C3: x-request-id fallback when messageid is absent
console.log('\nTest C3: compound correlationId falls back to x-request-id');
(function() {
    const ctx = createMockContext(compoundVars({
        'messageid': '',
        'request.header.x-request-id': 'client-req-789',
    }));
    runCompoundPolicy(ctx);
    const evt = JSON.parse(ctx.getVariable('aforo.compound_event'));
    assertEquals(evt.correlationId, expectedCorrelationId('client-req-789'),
        'fallback correlationId derived from the stable x-request-id header');
})();

// Test C4: random last resort is UUID-shaped (dedup opt-out, never a 400)
console.log('\nTest C4: keyless last resort is still a parseable UUID');
(function() {
    const ctx = createMockContext(compoundVars({
        'messageid': '',
        'request.header.x-request-id': null,
    }));
    runCompoundPolicy(ctx);
    const evt = JSON.parse(ctx.getVariable('aforo.compound_event'));
    assert(UUID_ANY_RE.test(evt.correlationId),
        'random fallback correlationId parses as a UUID (' + evt.correlationId + ')');
})();

// ── executionStatus (OUTCOME_BASED pricing) ──
function runPolicyEvent(overrides) {
    const ctx = createMockContext(overrides);
    runPolicy(ctx);
    return JSON.parse(ctx.getStoredPayload()).events[0];
}

// Test O1: outcomeFromStatus mapping table (helper pulled out of the policy scope)
console.log('\nTest O1: outcomeFromStatus mapping table');
(function() {
    const context = createMockContext({});  // eslint-disable-line no-unused-vars
    const mapFn = eval(POLICY_SRC + '\n;outcomeFromStatus');
    const cases = [
        [200, 'SUCCESS'], [204, 'SUCCESS'], [301, 'SUCCESS'], [304, 'SUCCESS'],
        [408, 'TIMEOUT'], [504, 'TIMEOUT'], [499, 'CANCELLED'],
        [400, 'VALIDATION_FAILED'], [422, 'VALIDATION_FAILED'],
        [401, 'BLOCKED'], [403, 'BLOCKED'], [429, 'BLOCKED'],
        [404, 'ERROR'], [409, 'ERROR'],
        [500, 'ERROR'], [502, 'ERROR'], [503, 'ERROR'],
    ];
    cases.forEach(function(c) {
        assertEquals(mapFn(c[0]), c[1], 'status ' + c[0] + ' -> ' + c[1]);
    });
    [0, null, undefined, NaN, 'abc', 101, 600].forEach(function(v) {
        assertEquals(mapFn(v), null, 'status ' + String(v) + ' -> null (omitted)');
    });
})();

// Test O2: standard API event carries executionStatus
console.log('\nTest O2: standard API event executionStatus');
(function() {
    assertEquals(runPolicyEvent({ 'response.status.code': '200' }).executionStatus,
        'SUCCESS', '200 -> SUCCESS');
    assertEquals(runPolicyEvent({ 'response.status.code': '404' }).executionStatus,
        'ERROR', '404 -> ERROR');
    assertEquals(runPolicyEvent({ 'response.status.code': '422' }).executionStatus,
        'VALIDATION_FAILED', '422 -> VALIDATION_FAILED');
    assertEquals(runPolicyEvent({ 'response.status.code': '429', 'private.aforo.excludeStatusCodes': 'none' }).executionStatus,
        'BLOCKED', '429 -> BLOCKED (when metered: exclude_status_codes=none)');
    assertEquals(runPolicyEvent({ 'response.status.code': '503' }).executionStatus,
        'ERROR', '503 -> ERROR');
    const missing = runPolicyEvent({ 'response.status.code': null });
    assert(!('executionStatus' in missing), 'missing status -> key omitted (not null/empty)');
})();

// Test O2b: KVM status_outcomes overrides
console.log('\nTest O2b: status_outcomes overrides');
(function() {
    const context = createMockContext({});  // eslint-disable-line no-unused-vars
    const parse = eval(POLICY_SRC + '\n;parseStatusOutcomes');
    assertEquals(JSON.stringify(parse(' 404 = validation_failed ,429=ERROR,bad,700=ERROR,500=NOPE,,')),
        JSON.stringify({ 404: 'VALIDATION_FAILED', 429: 'ERROR' }), 'valid entries kept, invalid skipped');
    assertEquals(JSON.stringify(parse(null)), '{}', 'unset KVM key -> no overrides');
    const kv = { 'private.aforo.statusOutcomes': '404=VALIDATION_FAILED,202=PENDING' };
    assertEquals(runPolicyEvent(Object.assign({ 'response.status.code': '404' }, kv)).executionStatus,
        'VALIDATION_FAILED', 'override wins for 404');
    assertEquals(runPolicyEvent(Object.assign({ 'response.status.code': '202' }, kv)).executionStatus,
        'PENDING', 'override on a 2xx');
    assertEquals(runPolicyEvent(Object.assign({ 'response.status.code': '403', 'private.aforo.excludeStatusCodes': 'none' }, kv)).executionStatus,
        'BLOCKED', 'unlisted code keeps the default');
})();

// Test O3: AGENTIC_API event carries executionStatus
console.log('\nTest O3: AGENTIC_API event executionStatus');
(function() {
    const ev = runPolicyEvent({
        'response.status.code': '408',
        'request.header.traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    assertEquals(ev.productType, 'AGENTIC_API', 'classified AGENTIC_API');
    assertEquals(ev.executionStatus, 'TIMEOUT', '408 -> TIMEOUT');
})();

// Test O4: MCP tool call — status table + JSON-RPC error inside a 2xx
console.log('\nTest O4: MCP executionStatus');
(function() {
    const mcp = {
        'aforo.mcpEnabled': 'true',
        'request.verb': 'POST',
        'request.content': JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_docs' } }),
    };
    assertEquals(runPolicyEvent(Object.assign({}, mcp, { 'response.status.code': '200' })).executionStatus,
        'SUCCESS', 'MCP 200 -> SUCCESS');
    assertEquals(runPolicyEvent(Object.assign({}, mcp, { 'response.status.code': '504' })).executionStatus,
        'TIMEOUT', 'MCP 504 -> TIMEOUT (was ERROR)');
    assertEquals(runPolicyEvent(Object.assign({}, mcp, { 'response.status.code': '500' })).executionStatus,
        'ERROR', 'MCP 500 -> ERROR');
    assertEquals(runPolicyEvent(Object.assign({}, mcp, {
        'response.status.code': '200',
        'response.content': JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad args' } }),
    })).executionStatus, 'ERROR', 'MCP 200 with JSON-RPC error object -> ERROR');
    assertEquals(runPolicyEvent(Object.assign({}, mcp, {
        'response.status.code': '200',
        'response.content': JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'no "error" here' }] } }),
    })).executionStatus, 'SUCCESS', 'MCP 200 with JSON-RPC result (text mentions "error") -> SUCCESS');
    assertEquals(runPolicyEvent({
        'response.status.code': '200',
        'response.content': JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }),
    }).executionStatus, 'SUCCESS', 'non-MCP event ignores response body (status-only)');
})();

// ── Exclusions (exclude_status_codes / exclude_paths) ──
// An excluded request sets aforo.skip = "true" and stores NO payload.
function runPolicySkip(overrides) {
    const ctx = createMockContext(overrides);
    runPolicy(ctx);
    return { skip: ctx.getVariable('aforo.skip'), payload: ctx.getStoredPayload() };
}
function assertSkipped(overrides, message) {
    const r = runPolicySkip(overrides);
    assert(r.skip === 'true' && r.payload === null, message + ' -> skipped, no payload');
}
function assertMetered(overrides, message) {
    const r = runPolicySkip(overrides);
    assert(r.skip === 'false' && r.payload !== null &&
        JSON.parse(r.payload).events.length === 1, message + ' -> metered');
}
const MCP_CALL = {
    'aforo.mcpEnabled': 'true',
    'request.verb': 'POST',
    'request.content': JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_docs', _meta: { agent_id: 'agent_1' } } }),
};
const AGENTIC_CALL = {
    'request.header.traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
};

// Test X1: default status exclusion
console.log('\nTest X1: default exclude_status_codes (401,403,429)');
(function() {
    ['401', '403', '429'].forEach(function(c) {
        assertSkipped({ 'response.status.code': c }, 'default: ' + c);
    });
    ['200', '404', '500'].forEach(function(c) {
        assertMetered({ 'response.status.code': c }, 'default: ' + c);
    });
    assertSkipped({ 'response.status.code': '401', 'private.aforo.excludeStatusCodes': '' }, 'blank KVM value uses the default');
    assertSkipped({ 'response.status.code': '401', 'private.aforo.excludeStatusCodes': '  ' }, 'whitespace KVM value uses the default');
    assertMetered({ 'response.status.code': null }, 'unknown status');
})();

// Test X2: explicit list replaces the default
console.log('\nTest X2: explicit exclude_status_codes replaces the default');
(function() {
    const kv = { 'private.aforo.excludeStatusCodes': '404, 500' };
    assertSkipped(Object.assign({ 'response.status.code': '404' }, kv), 'listed 404');
    assertSkipped(Object.assign({ 'response.status.code': '500' }, kv), 'listed 500');
    assertMetered(Object.assign({ 'response.status.code': '401' }, kv), '401 no longer excluded');
    assertMetered(Object.assign({ 'response.status.code': '429' }, kv), '429 no longer excluded');
    assertEquals(runPolicyEvent(Object.assign({ 'response.status.code': '401' }, kv)).executionStatus,
        'BLOCKED', 'a metered 401 bills as BLOCKED');
})();

// Test X3: exclude nothing
console.log('\nTest X3: exclude_status_codes = none');
(function() {
    ['none', ' NONE '].forEach(function(v) {
        ['401', '403', '429'].forEach(function(c) {
            assertMetered({ 'response.status.code': c, 'private.aforo.excludeStatusCodes': v }, JSON.stringify(v) + ': ' + c);
        });
    });
})();

// Test X4: malformed config never throws
console.log('\nTest X4: malformed exclude config');
(function() {
    const context = createMockContext({});  // eslint-disable-line no-unused-vars
    const parse = eval(POLICY_SRC + '\n;parseExcludeStatusCodes');
    assertEquals(JSON.stringify(parse(' 401 ,, abc, 4x9, 999, 42, 40.5, 503 ,')), '[401,503]', 'junk entries ignored');
    assertEquals(JSON.stringify(parse(null)), '[401,403,429]', 'null -> default');
    assertEquals(JSON.stringify(parse(undefined)), '[401,403,429]', 'undefined -> default');
    assertEquals(JSON.stringify(parse(',, ,')), '[401,403,429]', 'only separators -> default');
    assertEquals(JSON.stringify(parse('abc')), '[]', 'a value with no valid code excludes nothing');
    assertEquals(JSON.stringify(parse(429)), '[429]', 'numeric value tolerated');
    let threw = false;
    try {
        runPolicySkip({ 'private.aforo.excludeStatusCodes': '{}[],=;\u0000', 'private.aforo.excludePaths': ',,[(*,' });
        runPolicySkip({ 'private.aforo.excludeStatusCodes': {}, 'private.aforo.excludePaths': 12 });
    } catch (e) { threw = true; }
    assert(!threw, 'malformed config does not throw');
    assertMetered({ 'response.status.code': '401', 'private.aforo.excludeStatusCodes': 'abc' }, 'junk-only list: 401');
})();

// Test X5: exclude_paths
console.log('\nTest X5: exclude_paths');
(function() {
    assertSkipped({ 'proxy.pathsuffix': '/health' }, 'default: /health (exact)');
    assertSkipped({ 'proxy.pathsuffix': '/health/live' }, 'default: /health/live (prefix)');
    assertSkipped({ 'proxy.pathsuffix': '/ready' }, 'default: /ready');
    assertSkipped({ 'proxy.pathsuffix': '/metrics' }, 'default: /metrics');
    assertMetered({ 'proxy.pathsuffix': '/v1/health' }, 'default: /v1/health (not a prefix match)');
    assertMetered({ 'proxy.pathsuffix': '/v1/accounts' }, 'default: /v1/accounts');
    const kv = { 'private.aforo.excludePaths': ' /internal , /v1/ping ,' };
    assertSkipped(Object.assign({ 'proxy.pathsuffix': '/internal/debug' }, kv), 'explicit: /internal/debug');
    assertSkipped(Object.assign({ 'proxy.pathsuffix': '/v1/ping' }, kv), 'explicit: /v1/ping');
    assertMetered(Object.assign({ 'proxy.pathsuffix': '/v1/accounts' }, kv), 'explicit: /v1/accounts');
    assertMetered(Object.assign({ 'proxy.pathsuffix': '/health' }, kv), 'explicit list replaces the default: /health');
    assertMetered({ 'proxy.pathsuffix': '/health', 'private.aforo.excludePaths': 'none' }, 'none: /health');
    assertSkipped({ 'proxy.pathsuffix': '/status', 'request.path': '/health/status', 'private.aforo.excludePaths': '/health' },
        'full request path is checked too');
    assertSkipped({ 'proxy.pathsuffix': '/health', 'private.aforo.excludeStatusCodes': 'none' }, 'path exclusion is independent of the status list');
})();

// Test X6: MCP and AGENTIC_API paths honour the exclusions
console.log('\nTest X6: MCP + AGENTIC_API exclusions');
(function() {
    assertSkipped(Object.assign({}, MCP_CALL, { 'response.status.code': '401' }), 'MCP 401');
    assertSkipped(Object.assign({}, MCP_CALL, { 'response.status.code': '429' }), 'MCP 429');
    assertSkipped(Object.assign({}, MCP_CALL, { 'proxy.pathsuffix': '/health' }), 'MCP on an excluded path');
    assertMetered(Object.assign({}, MCP_CALL, { 'response.status.code': '200' }), 'MCP 200');
    assertEquals(runPolicyEvent(Object.assign({}, MCP_CALL, { 'response.status.code': '403', 'private.aforo.excludeStatusCodes': 'none' })).productType,
        'MCP_SERVER', 'MCP 403 metered as MCP_SERVER when nothing is excluded');
    assertSkipped(Object.assign({}, AGENTIC_CALL, { 'response.status.code': '403' }), 'AGENTIC_API 403');
    assertSkipped(Object.assign({}, AGENTIC_CALL, { 'proxy.pathsuffix': '/metrics' }), 'AGENTIC_API on an excluded path');
    assertMetered(Object.assign({}, AGENTIC_CALL, { 'response.status.code': '500' }), 'AGENTIC_API 500');
})();

// Test X7: the shared flow gates every outbound step on aforo.skip
console.log('\nTest X7: shared flow conditions');
(function() {
    const flow = fs.readFileSync(path.resolve(__dirname, '../sharedflowbundle/sharedflows/default.xml'), 'utf8');
    ['AforoMeteringSendEvent', 'AforoMeteringRetryGate', 'AforoMeteringSendEventRetry1', 'AforoMeteringLogDeliveryFailure'].forEach(function(name) {
        const m = flow.match(new RegExp('<Name>' + name + '</Name>\\s*<Condition>([^<]*)</Condition>'));
        assert(!!m && m[1].indexOf('aforo.skip != "true"') !== -1, name + ' is conditional on aforo.skip');
    });
    // Rule #21: the idempotency key is unchanged by exclusion config.
    const a = runPolicyEvent({ 'messageid': 'msg-777' });
    const b = runPolicyEvent({ 'messageid': 'msg-777', 'private.aforo.excludeStatusCodes': 'none', 'private.aforo.excludePaths': 'none' });
    assertEquals(a.idempotencyKey, 'msg-777', 'idempotency key is the stable request identity');
    assertEquals(b.idempotencyKey, a.idempotencyKey, 'exclusion config does not change the idempotency key');
})();

// ── Bounded send (the flow runs before the client gets its response) ──
const BUNDLE_DIR = path.resolve(__dirname, '../sharedflowbundle');
const GATE_SRC = fs.readFileSync(path.join(BUNDLE_DIR, 'resources/jsc/aforo-metering-retry-gate.js'), 'utf8');
const LOG_SRC = fs.readFileSync(path.join(BUNDLE_DIR, 'resources/jsc/aforo-metering-log-failure.js'), 'utf8');

function plainContext(vars) {
    const v = Object.assign({}, vars);
    return {
        getVariable: function(name) { return Object.prototype.hasOwnProperty.call(v, name) ? v[name] : null; },
        setVariable: function(name, value) { v[name] = value; },
        vars: v,
    };
}
function runScript(src, vars) {
    const ctx = plainContext(vars);
    const printed = [];
    new Function('context', 'print', src)(ctx, function(m) { printed.push(m); });
    return { vars: ctx.vars, printed: printed };
}
// A first attempt that ended `agoMs` ago with the given outcome.
function gate(extra, agoMs) {
    return runScript(GATE_SRC, Object.assign({
        'aforo.meteringSendStartMs': String(Date.now() - (agoMs === undefined ? 50 : agoMs)),
    }, extra)).vars;
}

// Test B1: the timeouts and retry count in the shipped policies
console.log('\nTest B1: send timeouts are 1 s connect / 2 s response, one retry policy');
(function() {
    const policies = fs.readdirSync(path.join(BUNDLE_DIR, 'policies'));
    const callouts = policies.filter(function(f) {
        return fs.readFileSync(path.join(BUNDLE_DIR, 'policies', f), 'utf8').indexOf('<ServiceCallout') >= 0;
    }).sort();
    assertEquals(JSON.stringify(callouts), JSON.stringify(['AforoMeteringSendEvent.xml', 'AforoMeteringSendEventRetry1.xml']),
        'exactly two ServiceCallout policies: the send and one retry');
    assertEquals(policies.indexOf('AforoMeteringSendEventRetry2.xml'), -1, 'the second retry policy is gone');
    callouts.forEach(function(f) {
        const xml = fs.readFileSync(path.join(BUNDLE_DIR, 'policies', f), 'utf8');
        assert(/<Property name="connect\.timeout\.millis">1000<\/Property>/.test(xml), f + ': connect timeout is 1000 ms');
        assert(/<Property name="io\.timeout\.millis">2000<\/Property>/.test(xml), f + ': response timeout is 2000 ms');
        assert(/<ServiceCallout name="[^"]+" continueOnError="true">/.test(xml), f + ': continueOnError=true');
        assert(/<Property name="success\.codes">1xx,2xx,3xx,4xx<\/Property>/.test(xml), f + ': a 4xx is not a policy failure');
        // Apigee takes only literals for these properties.
        assert(!/timeout\.millis">\s*\{/.test(xml), f + ': timeouts are literals, not flow variables');
        assert(xml.indexOf('<Payload contentType="application/json">{aforo.eventPayload}</Payload>') >= 0,
            f + ': sends the frozen aforo.eventPayload variable');
    });
})();

// Test B2: every step on the metering path has continueOnError=true
console.log('\nTest B2: no metering step can fail the API call');
(function() {
    ['AforoMeteringReadConfig', 'AforoMeteringBuildEvent', 'AforoMeteringSendEvent', 'AforoMeteringRetryGate',
     'AforoMeteringSendEventRetry1', 'AforoMeteringLogDeliveryFailure'].forEach(function(name) {
        const xml = fs.readFileSync(path.join(BUNDLE_DIR, 'policies', name + '.xml'), 'utf8');
        const root = xml.match(/<(KeyValueMapOperations|Javascript|ServiceCallout)\b[^>]*>/);
        assert(!!root && root[0].indexOf('continueOnError="true"') >= 0, name + ' has continueOnError="true"');
        const limit = root && root[0].match(/timeLimit="(\d+)"/);
        if (root && root[1] === 'Javascript') {
            assert(!!limit && parseInt(limit[1], 10) <= 500, name + ' script time limit is at most 500 ms');
        }
    });
})();

// Test B3: max_retries is validated and clamped to 0..1
console.log('\nTest B3: KVM max_retries');
(function() {
    const FAIL = { 'servicecallout.AforoMeteringSendEvent.failed': true };
    function retries(raw) {
        const extra = Object.assign({}, FAIL);
        if (raw !== undefined) extra['private.aforo.maxRetries'] = raw;
        return gate(extra);
    }
    assertEquals(retries(undefined)['aforo.meteringMaxRetries'], '1', 'absent -> 1');
    assertEquals(retries(undefined)['aforo.meteringRetry'], 'true', 'absent -> a failed send is retried');
    assertEquals(retries('0')['aforo.meteringRetry'], 'false', '0 -> no retry');
    assertEquals(retries(' 1 ')['aforo.meteringMaxRetries'], '1', 'spaces are ignored');
    assertEquals(retries('5')['aforo.meteringMaxRetries'], '1', '5 is clamped to 1');
    assertEquals(retries('999999999999999999999')['aforo.meteringMaxRetries'], '1', 'a huge number is clamped to 1');
    assertEquals(retries('-3')['aforo.meteringMaxRetries'], '0', 'a negative number is clamped to 0');
    ['abc', '', '1.5', '1e3', 'none', 'true'].forEach(function(junk) {
        assertEquals(retries(junk)['aforo.meteringMaxRetries'], '1', JSON.stringify(junk) + ' -> the default 1');
    });
})();

// Test B4: what is retried
console.log('\nTest B4: retry only on a connection failure or a 5xx, and only when it failed quickly');
(function() {
    function first(failed, status, agoMs) {
        const extra = {};
        if (failed !== null) extra['servicecallout.AforoMeteringSendEvent.failed'] = failed;
        if (status !== null) extra['aforo.calloutResponse.status.code'] = status;
        return gate(extra, agoMs);
    }
    let v = first(false, 202);
    assertEquals(v['aforo.meteringFirstAttempt'], 'delivered', '202 -> delivered');
    assertEquals(v['aforo.meteringRetry'], 'false', '202 -> no retry');

    v = first(true, null);
    assertEquals(v['aforo.meteringFirstAttempt'], 'failed', 'transport error -> failed');
    assertEquals(v['aforo.meteringRetry'], 'true', 'transport error -> retried');
    assertEquals(first('true', null)['aforo.meteringRetry'], 'true', 'the failed flag as a string is read the same way');

    [500, 502, 503, 504].forEach(function(code) {
        assertEquals(first(true, code)['aforo.meteringRetry'], 'true', code + ' -> retried');
    });
    assertEquals(first(false, 503)['aforo.meteringRetry'], 'true', '503 is retried even if the failed flag is not set');

    [400, 401, 403, 404, 409, 413, 422, 429].forEach(function(code) {
        const r = first(false, code);
        assertEquals(r['aforo.meteringFirstAttempt'], 'rejected', code + ' -> rejected');
        assertEquals(r['aforo.meteringRetry'], 'false', code + ' -> never re-sent');
    });

    // A connect timeout ends after about 1 s: retried. A response timeout
    // ends after 2 s or more: the ingestor is hanging, not retried.
    assertEquals(first(true, null, 1050)['aforo.meteringRetry'], 'true', 'failed after 1.05 s (connect timeout) -> retried');
    assertEquals(first(true, null, 2100)['aforo.meteringRetry'], 'false', 'failed after 2.1 s (response timeout) -> not retried');
    assertEquals(first(true, null, 3000)['aforo.meteringRetry'], 'false', 'failed after 3 s -> not retried');

    // No start time: elapsed time unknown, so no retry.
    const noStart = runScript(GATE_SRC, { 'servicecallout.AforoMeteringSendEvent.failed': true }).vars;
    assertEquals(noStart['aforo.meteringRetry'], 'false', 'no send start time -> not retried');
    const junkStart = runScript(GATE_SRC, { 'servicecallout.AforoMeteringSendEvent.failed': true, 'aforo.meteringSendStartMs': 'x' }).vars;
    assertEquals(junkStart['aforo.meteringRetry'], 'false', 'unreadable send start time -> not retried');

    // Nothing at all (neither a flag nor a status): treated as failed.
    assertEquals(first(null, null)['aforo.meteringFirstAttempt'], 'failed', 'no flag and no status -> failed');
})();

// Test B5: worst-case delay from the shipped numbers
console.log('\nTest B5: worst-case added delay');
(function() {
    const send = fs.readFileSync(path.join(BUNDLE_DIR, 'policies/AforoMeteringSendEvent.xml'), 'utf8');
    const connect = parseInt(send.match(/connect\.timeout\.millis">(\d+)</)[1], 10);
    const io = parseInt(send.match(/io\.timeout\.millis">(\d+)</)[1], 10);
    const windowMs = parseInt(GATE_SRC.match(/var RETRY_WINDOW_MS = (\d+);/)[1], 10);
    const cap = parseInt(GATE_SRC.match(/var MAX_RETRIES_CAP = (\d+);/)[1], 10);
    assertEquals(cap, 1, 'at most one retry');
    assert(windowMs >= connect && windowMs < io, 'a connect timeout is inside the retry window, a response timeout is outside it');
    assertEquals(connect * 2, 2000, 'unreachable ingestor: two connect timeouts = 2 s');
    assertEquals(connect + io, 3000, 'ingestor accepts the connection and never answers: 3 s, no retry');
    assert(windowMs + connect + io <= 4200, 'upper limit (first attempt fails at the edge of the window, then a full retry) is about 4 s');
})();

// Test B6: the build script starts the clock and marks the event for sending
console.log('\nTest B6: send start time and send marker');
(function() {
    const ctx = createMockContext({});
    const before = Date.now();
    runPolicy(ctx);
    const start = parseInt(ctx.getVariable('aforo.meteringSendStartMs'), 10);
    assert(start >= before && start <= Date.now(), 'aforo.meteringSendStartMs is the current time');
    assertEquals(ctx.getVariable('aforo.meteringSend'), 'true', 'aforo.meteringSend is set for a metered request');
    const payload = ctx.getStoredPayload();
    assert(payload.indexOf('meteringSendStartMs') === -1 && payload.indexOf(String(start)) === -1,
        'the start time is not in the payload');
    assertEquals(JSON.parse(payload).events[0].idempotencyKey, 'msg-001', 'the idempotency key is still the request identity');

    const skipped = createMockContext({ 'response.status.code': '401' });
    runPolicy(skipped);
    assertEquals(skipped.getVariable('aforo.meteringSend'), null, 'an excluded request is not marked for sending');

    const flow = fs.readFileSync(path.join(BUNDLE_DIR, 'sharedflows/default.xml'), 'utf8');
    const sendCond = flow.match(/<Name>AforoMeteringSendEvent<\/Name>\s*<Condition>([^<]*)<\/Condition>/)[1];
    assert(sendCond.indexOf('aforo.meteringSend = "true"') >= 0 && sendCond.indexOf('private.aforo.endpoint != null') >= 0,
        'the send runs only with a built payload and an endpoint');
    const retryCond = flow.match(/<Name>AforoMeteringSendEventRetry1<\/Name>\s*<Condition>([^<]*)<\/Condition>/)[1];
    assert(retryCond.indexOf('aforo.meteringRetry = "true"') >= 0, 'the retry runs only when the gate allows it');
    assert(flow.indexOf('status.code = 429') === -1, 'no flow condition retries a 429');
    const order = ['AforoMeteringBuildEvent', 'AforoMeteringSendEvent', 'AforoMeteringRetryGate',
        'AforoMeteringSendEventRetry1', 'AforoMeteringLogDeliveryFailure'].map(function(n) { return flow.indexOf('<Name>' + n + '</Name>'); });
    assert(order.every(function(pos, i) { return pos > 0 && (i === 0 || pos > order[i - 1]); }), 'steps run in order: build, send, gate, retry, log');
})();

// Test B7: a dropped event is recorded
console.log('\nTest B7: delivery failure log');
(function() {
    function log(vars) { return runScript(LOG_SRC, Object.assign({ 'messageid': 'msg-42' }, vars)); }

    let r = log({ 'aforo.meteringRetry': 'true', 'servicecallout.AforoMeteringSendEventRetry1.failed': true });
    assertEquals(r.vars['aforo.meteringDeliveryFailed'], 'true', 'send and retry both unreachable -> failed');
    assertEquals(r.vars['aforo.meteringDeliveryReason'], 'unreachable', 'reason unreachable');
    assertEquals(r.vars['aforo.meteringDeliveryAttempts'], '2', 'two attempts');
    assertEquals(r.vars['aforo.meteringDeliveryLastStatus'], 'no-response', 'no status');
    assert(r.printed.length === 1 && r.printed[0].indexOf('USAGE EVENT DROPPED') >= 0 && r.printed[0].indexOf('msg-42') >= 0,
        'one line printed, naming the request');

    r = log({ 'aforo.meteringRetry': 'true', 'servicecallout.AforoMeteringSendEventRetry1.failed': false,
              'aforo.calloutResponseRetry1.status.code': 202 });
    assertEquals(r.vars['aforo.meteringDeliveryFailed'], 'false', 'the retry delivered it -> not failed');
    assertEquals(r.printed.length, 0, 'nothing printed when the retry delivered');

    r = log({ 'aforo.meteringRetry': 'true', 'servicecallout.AforoMeteringSendEventRetry1.failed': true,
              'aforo.calloutResponseRetry1.status.code': 503 });
    assertEquals(r.vars['aforo.meteringDeliveryReason'], 'server_error', '503 on the retry -> server_error');
    assertEquals(r.vars['aforo.meteringDeliveryLastStatus'], '503', 'last status 503');

    r = log({ 'aforo.meteringRetry': 'false', 'servicecallout.AforoMeteringSendEvent.failed': false,
              'aforo.calloutResponse.status.code': 429 });
    assertEquals(r.vars['aforo.meteringDeliveryFailed'], 'true', 'a 429 is a dropped event');
    assertEquals(r.vars['aforo.meteringDeliveryReason'], 'rejected', 'reason rejected');
    assertEquals(r.vars['aforo.meteringDeliveryAttempts'], '1', 'one attempt');

    r = log({ 'aforo.meteringRetry': 'false', 'servicecallout.AforoMeteringSendEvent.failed': true });
    assertEquals(r.vars['aforo.meteringDeliveryAttempts'], '1', 'max_retries 0 or a slow failure: one attempt, recorded');
    assertEquals(r.printed.length, 1, 'and printed');

    // The gate script failed (no variables at all): still recorded.
    r = log({ 'servicecallout.AforoMeteringSendEvent.failed': true });
    assertEquals(r.vars['aforo.meteringDeliveryFailed'], 'true', 'recorded even when the gate set nothing');
})();

// ── Merge 2.2.0: union of the working repo and the 2.1.0 mirror ──

// Test M1: one key, built once, identical on the retry
console.log('\nTest M1: idempotency key identical across the retry');
(function() {
    const send = fs.readFileSync(path.join(BUNDLE_DIR, 'policies/AforoMeteringSendEvent.xml'), 'utf8');
    const retry = fs.readFileSync(path.join(BUNDLE_DIR, 'policies/AforoMeteringSendEventRetry1.xml'), 'utf8');
    const payloadRef = /<Payload contentType="application\/json">\{aforo\.eventPayload\}<\/Payload>/;
    assert(payloadRef.test(send) && payloadRef.test(retry), 'send and retry post the same aforo.eventPayload variable');
    assert(GATE_SRC.indexOf('aforo.eventPayload') === -1 || !/setVariable\('aforo\.eventPayload'/.test(GATE_SRC),
        'the retry gate does not rebuild the payload');
    assert(!/setVariable\('aforo\.eventPayload'/.test(LOG_SRC), 'the failure log does not rebuild the payload');
    const policyCode = POLICY_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert(!/Date\.now\(\)/.test(policyCode), 'no Date.now() anywhere in the build script (no clock in a key)');
    assert(!/uniqueEventId/.test(policyCode), 'the 2.1.0 clock-based fallback id is not used');

    // The key is a function of request identity only: config from either
    // side (mappings, product type, quantity source) does not change it.
    const base = { 'messageid': 'rrt-abc-123' };
    const k1 = runPolicyEvent(base).idempotencyKey;
    const k2 = runPolicyEvent(Object.assign({}, base, { 'private.aforo.productType': 'NEW_TYPE',
        'private.aforo.metricNamePattern': '{method} {path}', 'private.aforo.quantitySource': 'response_size',
        'response.header.Content-Length': '10' })).idempotencyKey;
    assertEquals(k1, 'rrt-abc-123', 'standard key = messageid');
    assertEquals(k2, k1, 'same request, different config -> same key');
    const mcp = Object.assign({}, MCP_CALL, base);
    assertEquals(runPolicyEvent(mcp).idempotencyKey, 'mcp:apigee:rrt-abc-123:search_docs', 'MCP key = mcp:apigee:{messageid}:{tool}');
    assertEquals(runPolicyEvent(mcp).idempotencyKey, runPolicyEvent(mcp).idempotencyKey, 'MCP key stable on re-evaluation');
    // Two different requests never share a key.
    assert(runPolicyEvent({ 'messageid': 'a' }).idempotencyKey !== runPolicyEvent({ 'messageid': 'b' }).idempotencyKey,
        'distinct requests -> distinct keys (not a content hash)');
})();

// Test M2: exclusions after the merge
console.log('\nTest M2: exclusions still applied (defaults, replace, none, base path)');
(function() {
    assertSkipped({ 'response.status.code': '429' }, 'default: 429');
    assertSkipped({ 'proxy.pathsuffix': '/health' }, 'default: /health');
    assertSkipped({ 'proxy.basepath': '/svc', 'proxy.pathsuffix': '/metrics' }, 'default path matched on the path suffix under a base path');
    assertSkipped({ 'proxy.basepath': '/health', 'proxy.pathsuffix': '/live' }, 'default path matched on base path + suffix');
    assertMetered({ 'private.aforo.excludeStatusCodes': '500', 'response.status.code': '401' }, 'a configured list replaces the default (401 metered)');
    assertSkipped({ 'private.aforo.excludeStatusCodes': '500', 'response.status.code': '500' }, 'a configured list is applied');
    assertMetered({ 'private.aforo.excludeStatusCodes': 'none', 'response.status.code': '403' }, 'none meters everything');
    assertMetered({ 'private.aforo.excludePaths': 'none', 'proxy.pathsuffix': '/health' }, 'exclude_paths none');
    // Skips from the mirror.
    assertSkipped({ 'request.verb': 'OPTIONS' }, 'OPTIONS (CORS preflight)');
    assertSkipped({ 'request.verb': 'OPTIONS', 'private.aforo.excludeStatusCodes': 'none', 'private.aforo.excludePaths': 'none' }, 'OPTIONS even with exclusions off');
    assertSkipped({ 'private.aforo.quantitySource': 'response_size', 'response.header.Content-Length': '0' }, 'quantity 0');
    assertSkipped({ 'private.aforo.quantitySource': 'response_size' }, 'quantity missing');
    let ctx = createMockContext({ 'response.status.code': '401' });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.skipReason'], 'excluded status code', 'skip reason for an excluded status');
    assertEquals(ctx.vars['aforo.sendEvent'], 'false', 'aforo.sendEvent (2.1.0 name) false for an excluded request');
    ctx = createMockContext({});
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.skip'], 'false', 'aforo.skip false for a metered request');
    assertEquals(ctx.vars['aforo.skipReason'] || '', '', 'no skip reason for a metered request');
})();

// Test M3: include_metadata, MCP without an agent, long tool name
console.log('\nTest M3: include_metadata, MCP field rules');
(function() {
    assert(runPolicyEvent({}).metadata && runPolicyEvent({}).metadata.gateway === 'apigee', 'metadata sent by default');
    assert(runPolicyEvent({ 'private.aforo.includeMetadata': 'false' }).metadata === undefined, 'include_metadata=false omits metadata');
    assertEquals(runPolicyEvent({ 'private.aforo.includeMetadata': 'false' }).endpointPath, '/v1/accounts/123', 'top-level fields stay');
    assertEquals(runPolicyEvent({ 'aforo.key_id': 'key_9' }).metadata.keyId, 'key_9', 'verified JWT key_id recorded in metadata');
    assert(runPolicyEvent({ 'aforo.key_id': 'key_9', 'private.aforo.includeMetadata': 'false' }).metadata === undefined, 'no metadata at all when include_metadata=false');

    const withAgent = runPolicyEvent(MCP_CALL);
    assertEquals(withAgent.productType, 'MCP_SERVER', 'tools/call with toolName + agentId -> MCP_SERVER');
    assertEquals(withAgent.agentId, 'agent_1', 'agentId from params._meta.agent_id');
    const noAgent = runPolicyEvent(Object.assign({}, MCP_CALL, {
        'request.content': JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_docs' } }) }));
    assertEquals(noAgent.productType, 'API', 'tools/call without an agent keeps the configured type (ingestor rejects MCP_SERVER without agentId)');
    assertEquals(noAgent.metricName, 'mcp_server.tool_invocations', 'and keeps the MCP metric');
    assertSkipped(Object.assign({}, MCP_CALL, { 'request.content': JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 't'.repeat(65), _meta: { agent_id: 'a' } } }) }), 'toolName > 64 chars');
    assertEquals(runPolicyEvent(Object.assign({ 'private.aforo.mcpEnabled': 'true', 'aforo.mcpEnabled': null }, { 'request.verb': 'POST',
        'request.content': MCP_CALL['request.content'] })).productType, 'MCP_SERVER', 'mcp_enabled read from the KVM variable');
    assert(typeof runPolicyEvent({}).occurredAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(runPolicyEvent({}).occurredAt),
        'occurredAt is an ISO-8601 UTC string');
})();

// Test M4: transient-only retry (408 added), 429 never re-sent, body logged
console.log('\nTest M4: retry policy');
(function() {
    function first(failedFlag, status, agoMs) {
        const vars = { 'servicecallout.AforoMeteringSendEvent.failed': failedFlag,
            'aforo.meteringSendStartMs': String(Date.now() - (agoMs === undefined ? 100 : agoMs)) };
        if (status !== null) vars['aforo.calloutResponse.status.code'] = status;
        return runScript(GATE_SRC, vars).vars;
    }
    assertEquals(first(false, 408)['aforo.meteringRetry'], 'true', '408 -> retried (transient)');
    assertEquals(first(false, 408, 2500)['aforo.meteringRetry'], 'false', '408 after the retry window -> not retried (delay bound)');
    assertEquals(first(false, 429)['aforo.meteringRetry'], 'false', '429 -> not re-sent (cannot wait for Retry-After on the request path)');
    assertEquals(first(false, 400)['aforo.meteringRetry'], 'false', '400 -> not re-sent');
    assertEquals(first(false, 202)['aforo.meteringFirstAttempt'], 'delivered', '202 -> delivered');
    assert(!/waitForComplete|sleep|setTimeout|httpClient/.test(GATE_SRC + LOG_SRC), 'no wait and no extra HTTP call in the gate or the log');

    let r = runScript(LOG_SRC, { 'messageid': 'msg-9', 'aforo.meteringRetry': 'false',
        'servicecallout.AforoMeteringSendEvent.failed': false, 'aforo.calloutResponse.status.code': 400,
        'aforo.calloutResponse.content': '{"success":false,"error":{"message":"Unknown metric: nope"}}' });
    assert(r.printed.length === 1 && r.printed[0].indexOf('Unknown metric: nope') >= 0, 'a 4xx drop logs the ingestor response body');
    r = runScript(LOG_SRC, { 'messageid': 'msg-9', 'aforo.meteringRetry': 'false',
        'servicecallout.AforoMeteringSendEvent.failed': false, 'aforo.calloutResponse.status.code': 400,
        'aforo.calloutResponse.content': 'x'.repeat(5000) });
    assert(r.printed[0].length < 800, 'the logged body is capped');
    r = runScript(LOG_SRC, { 'messageid': 'msg-9', 'aforo.meteringRetry': 'false',
        'servicecallout.AforoMeteringSendEvent.failed': false, 'aforo.calloutResponse.status.code': 429,
        'aforo.calloutResponse.header.Retry-After': '30' });
    assertEquals(r.vars['aforo.meteringDeliveryRetryAfter'], '30', 'Retry-After of a 429 is recorded');
    assert(r.printed[0].indexOf('retry-after=30') >= 0, 'and printed');
    r = runScript(LOG_SRC, { 'messageid': 'msg-9', 'aforo.meteringRetry': 'true',
        'servicecallout.AforoMeteringSendEventRetry1.failed': false, 'aforo.calloutResponseRetry1.status.code': 408 });
    assertEquals(r.vars['aforo.meteringDeliveryReason'], 'timeout', '408 on the retry -> reason timeout');
    assert(!/apiKey|api_key/.test(LOG_SRC), 'the failure log never touches the API key');
})();

// Test M5: margin guard and compound scripts after the merge
console.log('\nTest M5: margin guard config + compound identity');
(function() {
    const MG_SRC = fs.readFileSync(path.join(BUNDLE_DIR, 'resources/jsc/aforo-margin-guard.js'), 'utf8');
    function mg(vars) {
        const ctx = plainContext(vars);
        let called = null;
        const context = ctx;  // eslint-disable-line no-unused-vars
        function Request(url, verb, headers) { this.url = url; this.headers = headers; }  // eslint-disable-line no-unused-vars
        const httpClient = { send: function(req) { called = req; return {  // eslint-disable-line no-unused-vars
            waitForComplete: function() {}, isSuccess: function() { return true; },
            getResponse: function() { return { status: 200, content: JSON.stringify({ allowed: false, level: 'L3_BLOCK' }) }; } }; } };
        eval(MG_SRC);
        return { vars: ctx.vars, called: called };
    }
    let r = mg({ 'private.aforo.marginGuardEnabled': 'true', 'private.aforo.marginGuardUrl': 'https://p', 'private.aforo.tenantId': 't1', 'aforo.customer_id': 'c1' });
    assert(r.called && r.called.url.indexOf('tenantId=t1') > 0 && r.called.url.indexOf('scopeId=c1') > 0, 'margin guard runs from KVM (private.*) settings');
    assertEquals(r.vars['aforo.marginGuard.blocked'], 'true', 'L3 block sets blocked');
    assertEquals(r.vars['aforo.marginGuard.header'], 'blocked', 'header value set by the script (no template expression)');
    r = mg({ 'aforo.marginGuardEnabled': 'true', 'aforo.marginGuardUrl': 'https://p', 'aforo.tenant_id': 'tj', 'private.aforo.tenantId': 't1', 'aforo.customerId': 'c2' });
    assert(r.called && r.called.url.indexOf('tenantId=tj') > 0 && r.called.url.indexOf('scopeId=c2') > 0, 'proxy-set aforo.* settings still work; JWT tenant wins');
    r = mg({ 'private.aforo.marginGuardUrl': 'https://p', 'private.aforo.tenantId': 't1', 'aforo.customer_id': 'c1' });
    assertEquals(r.called, null, 'margin guard off by default');
    const flow = fs.readFileSync(path.join(BUNDLE_DIR, 'sharedflows/default.xml'), 'utf8');
    assert(/<Name>AforoMarginGuardRaiseFault<\/Name>\s*<Condition>[^<]*aforo\.marginGuard\.blocked = "true"[^<]*<\/Condition>/.test(flow),
        'RaiseFault step is conditional (it never fires on an allowed request)');

    function compound(overrides) {
        const ctx = plainContext(compoundVars(overrides));
        (function() { const context = ctx; eval(COMPOUND_SRC); })();  // eslint-disable-line no-unused-vars
        return ctx.vars;
    }
    let cv = compound({ 'aforo.customer_id': null, 'apiproxy.consumerkey': 'secret-key', 'developer.app.name': 'app-1' });
    assertEquals(JSON.parse(cv['aforo.compound_event']).customerId, 'app-1', 'compound: developer app, never the consumer key');
    assertEquals(JSON.parse(cv['aforo.compound_event']).productType, 'API', 'compound: productType default API');
    assertEquals(cv['aforo.compound_event_ready'], 'true', 'compound: ready with an identity');
    cv = compound({ 'aforo.customer_id': null, 'apiproxy.consumerkey': 'secret-key' });
    assertEquals(cv['aforo.compound_event_ready'], 'false', 'compound: no identity -> not ready to send');
    assert(cv['aforo.compound_event'].indexOf('secret-key') === -1, 'compound: the consumer key is not in the event');
})();

// Test: the bundle deploys on Apigee X / hybrid
// Every KVM there is encrypted, and a Get whose assignTo lacks "private."
// is rejected. And VerifyJWT must not run unless JWT validation is set up,
// or it faults and ends the flow before the metering steps.
(function testBundleIsApigeeXSafe() {
    console.log('\nTest: bundle is deployable on Apigee X');
    const bundle = path.join(__dirname, '..', 'sharedflowbundle');
    const policies = fs.readdirSync(path.join(bundle, 'policies'));
    let gets = 0;
    policies.forEach(function (f) {
        const xml = fs.readFileSync(path.join(bundle, 'policies', f), 'utf8');
        if (xml.indexOf('<KeyValueMapOperations') < 0) return;
        (xml.match(/<Get assignTo="[^"]+"/g) || []).forEach(function (g) {
            gets++;
            assertEquals(/assignTo="private\./.test(g), true, f + ': ' + g + ' is private.*');
        });
    });
    assertEquals(gets > 10, true, 'found the KVM Get elements (' + gets + ')');

    const flow = fs.readFileSync(path.join(bundle, 'sharedflows', 'default.xml'), 'utf8');
    // JWT validation is opt-in: jwt_validation_enabled = "true", or
    // aforo_jwks_uri set and the flag not "false". Default (neither): off.
    const JWT_ON = '(private.aforo.jwtValidationEnabled = "true") or ((private.aforo_jwks_uri != null) and (private.aforo.jwtValidationEnabled != "false"))';
    ['AforoJwtValidation', 'AforoJwtAssignHeaders'].forEach(function (step) {
        const m = flow.match(new RegExp('<Step>(?:(?!</Step>)[\\s\\S])*<Name>' + step + '</Name>((?:(?!</Step>)[\\s\\S])*)</Step>'));
        assertEquals(!!m && m[1].indexOf('<Condition>' + JWT_ON + '</Condition>') >= 0, true,
            step + ' is opt-in (flag "true", or aforo_jwks_uri set and flag not "false")');
    });
    // The condition, evaluated the way Apigee does for these operators.
    function jwtOn(flag, jwks) {
        return (flag === 'true') || ((jwks !== null) && (flag !== 'false'));
    }
    assertEquals(jwtOn(null, null), false, 'JWT default: nothing configured -> VerifyJWT does not run');
    assertEquals(jwtOn('true', null), true, 'jwt_validation_enabled = true -> runs (2.1.0 switch)');
    assertEquals(jwtOn(null, 'https://x/jwks.json'), true, 'aforo_jwks_uri alone -> runs (working-repo switch)');
    assertEquals(jwtOn('false', 'https://x/jwks.json'), false, 'jwt_validation_enabled = false turns it off even with a JWKS URI');
    const jwtRead = fs.readFileSync(path.join(bundle, 'policies', 'AforoJwtReadConfig.xml'), 'utf8');
    assertEquals(/<KeyValueMapOperations[^>]*continueOnError="true"/.test(jwtRead), true, 'AforoJwtReadConfig cannot fail the API call');
    const verify = fs.readFileSync(path.join(bundle, 'policies', 'AforoJwtValidation.xml'), 'utf8');
    assertEquals(/<Algorithm>RS256<\/Algorithm>/.test(verify) && /<JWKS>/.test(verify), true, 'VerifyJWT pins RS256 and a JWKS (no alg from the token)');
    assertEquals(/<VerifyJWT[^>]*continueOnError="true"/.test(verify), false, 'a failed VerifyJWT faults; it never continues with unverified claims');

    // Structure: the bundle imports only when the flow, the descriptor and
    // the files agree in both directions.
    const descriptor = fs.readFileSync(path.join(bundle, 'aforo-metering.xml'), 'utf8');
    (flow.match(/<Name>([^<]+)<\/Name>/g) || []).forEach(function (n) {
        const name = n.replace(/<\/?Name>/g, '');
        assertEquals(fs.existsSync(path.join(bundle, 'policies', name + '.xml')), true, 'policy file for step ' + name);
        assertEquals(descriptor.indexOf('<Policy>' + name + '</Policy>') >= 0, true, 'descriptor lists ' + name);
    });
    (descriptor.match(/<Policy>([^<]+)<\/Policy>/g) || []).forEach(function (n) {
        const name = n.replace(/<\/?Policy>/g, '');
        assertEquals(fs.existsSync(path.join(bundle, 'policies', name + '.xml')), true, 'descriptor policy ' + name + ' has a file');
        assertEquals(flow.indexOf('<Name>' + name + '</Name>') >= 0, true, 'descriptor policy ' + name + ' is a flow step');
    });
    policies.forEach(function (f) {
        const name = f.replace(/\.xml$/, '');
        const xml = fs.readFileSync(path.join(bundle, 'policies', f), 'utf8');
        assertEquals(descriptor.indexOf('<Policy>' + name + '</Policy>') >= 0, true, 'policy file ' + f + ' is in the descriptor');
        assertEquals(new RegExp('<[A-Za-z]+[^>]* name="' + name + '"').test(xml), true, f + ' declares name="' + name + '"');
        assertEquals(/^<<<<<<<|^>>>>>>>|^=======$/m.test(xml), false, f + ' has no merge markers');
        (xml.match(/<ResourceURL>jsc:\/\/([^<]+)<\/ResourceURL>/g) || []).forEach(function (r) {
            const js = r.replace(/<\/?ResourceURL>/g, '').replace('jsc://', '');
            assertEquals(fs.existsSync(path.join(bundle, 'resources', 'jsc', js)), true, f + ': script ' + js + ' exists');
            assertEquals(descriptor.indexOf('<Resource>jsc://' + js + '</Resource>') >= 0, true, f + ': script ' + js + ' is in the descriptor');
        });
    });
    (descriptor.match(/jsc:\/\/([^<]+)/g) || []).forEach(function (r) {
        assertEquals(fs.existsSync(path.join(bundle, 'resources', 'jsc', r.replace('jsc://', ''))), true, r + ' exists');
    });
    assertEquals(fs.existsSync(path.join(bundle, 'resources', 'jsc', 'aforo-mcp-metering.js')), false, 'aforo-mcp-metering.js stays deleted');
    // No flow variable in a step condition or a message template is one
    // the KVM read no longer sets (aforo.* without private. for KVM values).
    ['endpoint', 'apiKey', 'tenantId', 'maxRetries'].forEach(function (v) {
        assertEquals(new RegExp('[^.]aforo\\.' + v + '\\b').test(flow.replace(/private\.aforo\./g, 'P.')), false,
            'flow does not read non-private aforo.' + v);
    });
    // Rhino (ES5): no arrow functions, let/const, template strings or java.* in the shipped scripts.
    fs.readdirSync(path.join(bundle, 'resources', 'jsc')).forEach(function (f) {
        const js = fs.readFileSync(path.join(bundle, 'resources', 'jsc', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assertEquals(/=>|^\s*(let|const)\s|`|java\.util|\.trim\(\)/m.test(js), false, f + ' is ES5 / Rhino-safe');
        assertEquals(/consumerkey/i.test(js.replace(/consumer_\?key\|[^\n]*/g, '')), false, f + ' never reads the consumer key');
    });
})();

// Summary
console.log('\n── Results: ' + testsPassed + ' passed, ' + testsFailed + ' failed ──\n');
process.exit(testsFailed > 0 ? 1 : 0);
