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
})();

// Test 6: customer identity
console.log('\nTest 6: customerId from verified JWT only; never developer app name/email');
(function() {
    let ctx = createMockContext({});
    runPolicy(ctx);
    assertEquals(eventOf(ctx).customerId, 'cust_abc', 'customerId = aforo.customer_id (VerifyJWT claim)');

    ctx = createMockContext({ 'aforo.customer_id': null });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.sendEvent'], 'false', 'no verified customer → not sent');
    assertEquals(ctx.vars['aforo.skipReason'], 'no customerId', 'skip reason recorded');
    assertEquals(ctx.getStoredPayload(), '', 'developer.app.name / email not used as customer');

    ctx = createMockContext({ 'aforo.customer_id': null,
        'aforo.customerIdSource': 'flow_variable:verifyapikey.VerifyKey.app.aforo_customer_id',
        'verifyapikey.VerifyKey.app.aforo_customer_id': 'cust_from_app' });
    runPolicy(ctx);
    assertEquals(eventOf(ctx).customerId, 'cust_from_app', 'customer_id_source flow_variable fallback');

    ctx = createMockContext({ 'aforo.customer_id': null,
        'aforo.customerIdSource': 'flow_variable:request.header.x-customer-id',
        'request.header.x-customer-id': 'spoofed' });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.sendEvent'], 'false', 'client-controlled request.* variable refused');

    ctx = createMockContext({ 'aforo.customer_id': 'x'.repeat(65) });
    runPolicy(ctx);
    assertEquals(ctx.vars['aforo.sendEvent'], 'false', 'customerId > 64 chars not sent');
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
    assert(/<Get assignTo="aforo\.productType">\s*<Key><Parameter>product_type<\/Parameter>/.test(xml), 'KVM product_type read into aforo.productType');
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
    assert(/<Name>AforoMeteringSendEvent<\/Name>\s*<Condition>aforo\.sendEvent = "true"<\/Condition>/.test(flow), 'send gated on aforo.sendEvent');
    const raise = fs.readFileSync(path.join(bundle, 'policies/AforoMarginGuardRaiseFault.xml'), 'utf8');
    assert(!/\?/.test(raise.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '')), 'no ternary in RaiseFault templates');
})();

// Summary
console.log('\n── Results: ' + testsPassed + ' passed, ' + testsFailed + ' failed ──\n');
process.exit(testsFailed > 0 ? 1 : 0);
