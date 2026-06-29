/**
 * Unit tests for AWS Lambda aforo-metering handler.
 * Run with: node tests/handler.test.js
 */

const { parseAccessLog, detectMcpToolCall } = require('../index');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log('  PASS: ' + msg); }
    else { failed++; console.error('  FAIL: ' + msg); }
}

function assertEquals(actual, expected, msg) {
    if (actual === expected) { passed++; console.log('  PASS: ' + msg); }
    else { failed++; console.error('  FAIL: ' + msg + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

console.log('\nAWS Lambda Aforo Metering — Unit Tests\n');

// Test 1: Parse JSON access log with headers
console.log('Test 1: Parse JSON access log with trace headers');
(function() {
    const log = JSON.stringify({
        requestId: 'req-001',
        httpMethod: 'GET',
        resourcePath: '/v1/users/42',
        status: '200',
        responseLatency: '55',
        responseLength: '1024',
        stage: 'prod',
        resource: '/v1/users/{id}',
        requestHeaders: {
            'traceparent': '00-abc123def456-span789-01',
            'tracestate': 'vendor=value',
            'x-trace-id': 'legacy-trace',
            'x-request-id': 'req-legacy',
        },
    });

    const parsed = parseAccessLog(log);
    assert(parsed !== null, 'parses JSON access log');
    assertEquals(parsed.method, 'GET', 'extracts method');
    assertEquals(parsed.path, '/v1/users/42', 'extracts path');
    assertEquals(parsed.status, 200, 'extracts status');
    assertEquals(parsed.headers['traceparent'], '00-abc123def456-span789-01', 'extracts traceparent');
    assertEquals(parsed.headers['tracestate'], 'vendor=value', 'extracts tracestate');
    assertEquals(parsed.headers['x-trace-id'], 'legacy-trace', 'extracts x-trace-id');
    assertEquals(parsed.headers['x-request-id'], 'req-legacy', 'extracts x-request-id');
})();

// Test 2: Parse JSON access log without headers
console.log('\nTest 2: Parse JSON access log without trace headers');
(function() {
    const log = JSON.stringify({
        requestId: 'req-002',
        httpMethod: 'POST',
        resourcePath: '/v1/orders',
        status: '201',
    });

    const parsed = parseAccessLog(log);
    assert(parsed !== null, 'parses log');
    assertEquals(parsed.headers['traceparent'], undefined, 'traceparent undefined when absent');
})();

// Test 3: MCP detection
console.log('\nTest 3: MCP tools/call detection');
(function() {
    const body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'search_docs', _meta: { agent_id: 'agent-001' } },
    });

    const result = detectMcpToolCall(body);
    assert(result !== null, 'detects MCP tools/call');
    assertEquals(result.toolName, 'search_docs', 'extracts tool name');
    assertEquals(result.agentId, 'agent-001', 'extracts agent ID');
})();

// Test 4: Non-MCP body returns null
console.log('\nTest 4: Non-MCP body returns null');
(function() {
    const body = JSON.stringify({ action: 'create', data: {} });
    const result = detectMcpToolCall(body);
    assertEquals(result, null, 'non-MCP body returns null');
})();

// Summary
console.log('\n── Results: ' + passed + ' passed, ' + failed + ' failed ──\n');
process.exit(failed > 0 ? 1 : 0);
