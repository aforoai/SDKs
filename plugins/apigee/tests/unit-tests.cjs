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
        'developer.app.name': 'cust_abc',
        'developer.email': '',
        'aforo.mcpEnabled': 'false',
        'aforo.mcpProductId': '',
        'aforo.metricNamePattern': '{method} {path}',
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
    };
}

function runPolicy(ctx) {
    // Apigee JS scripts access a global `context` object. Eval the
    // policy source in a scope where `context` is our mock.
    const context = ctx;  // eslint-disable-line no-unused-vars
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

    assertEquals(event.productType, 'MCP_SERVER', 'MCP detection triggered');
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
})();

// Summary
console.log('\n── Results: ' + testsPassed + ' passed, ' + testsFailed + ' failed ──\n');
process.exit(testsFailed > 0 ? 1 : 0);
