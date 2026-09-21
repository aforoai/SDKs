/**
 * Unit tests for AWS Lambda aforo-metering handler.
 * Run with: node tests/handler.test.js
 */

const http = require('http');
const zlib = require('zlib');

// Configure the module before it is loaded (it reads env at require time).
// AFORO_ENDPOINT is pointed at a local capture server started below.
process.env.AFORO_API_KEY = 'test-ingest-key';
process.env.METRIC_MAPPINGS = JSON.stringify([
    { matchType: 'PREFIX', value: '/v1/sms', metricName: 'sms_sent' },
    { matchType: 'EXACT', value: '/v1/otp/verify', metricName: 'otp_verified' },
    { matchType: 'CONTAINS', value: '/calls/', metricName: 'call_minutes' },
]);
process.env.DEFAULT_METRIC = 'api_calls';

const captured = [];
let nextStatuses = [];
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        captured.push({ headers: req.headers, url: req.url, body: JSON.parse(body) });
        const status = nextStatuses.length ? nextStatuses.shift() : 202;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status }));
    });
});

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

// ── Metric resolution (no network) ──
console.log('\nTest 5: Metric resolution — mappings, then default; never route-shaped by default');
(function() {
    const { resolveMetricName, parseMetricMappings } = require('../index');
    assertEquals(resolveMetricName({ method: 'POST', path: '/v1/sms/send' }), 'sms_sent', 'PREFIX mapping');
    assertEquals(resolveMetricName({ method: 'POST', path: '/v1/otp/verify' }), 'otp_verified', 'EXACT mapping');
    assertEquals(resolveMetricName({ method: 'POST', path: '/v1/otp/verify/x' }), 'api_calls', 'EXACT does not prefix-match');
    assertEquals(resolveMetricName({ method: 'GET', path: '/v2/calls/9' }), 'call_minutes', 'CONTAINS mapping');
    assertEquals(resolveMetricName({ method: 'GET', path: '/v1/users/42' }), 'api_calls', 'unmapped → DEFAULT_METRIC, not "GET /v1/users/42"');
    assertEquals(resolveMetricName({ method: 'GET', path: '/x' }, [], '{method} {path}', 'd'), 'GET /x', 'pattern only when explicitly set');
    assertEquals(parseMetricMappings('not json').length, 0, 'invalid METRIC_MAPPINGS ignored');
    assertEquals(parseMetricMappings('[{"matchType":"REGEX","value":"x","metricName":"m"}]').length, 0, 'unknown matchType rule dropped');
})();

console.log('\nTest 6: parseAccessLog never uses the API key or client IP as customer');
(function() {
    const p = parseAccessLog(JSON.stringify({ requestId: 'r', httpMethod: 'GET', resourcePath: '/a', status: '200',
        apiKey: 'SECRET-KEY-VALUE', 'identity.apiKey': 'SECRET', caller: 'arn:aws:iam::1:user/x' }));
    assertEquals(p.customerId, '', 'no customerId from apiKey/caller');
    const p2 = parseAccessLog(JSON.stringify({ requestId: 'r', customerId: '-' }));
    assertEquals(p2.customerId, '', '"-" (unset $context variable) treated as empty');
    const clf = parseAccessLog('10.0.0.1 - - [01/Jan/2026:00:00:00 +0000] "GET /a HTTP/1.1" 200 12');
    assertEquals(clf.customerId, '', 'CLF client IP is not a customer');
})();

// ── Handler-level tests against a local capture server ──
function cwEvent(entries) {
    const logData = {
        messageType: 'DATA_MESSAGE',
        logGroup: '/aws/apigateway/test',
        logEvents: entries.map((e, i) => ({ id: 'ev' + i, timestamp: 1767225600000 + i, message: JSON.stringify(e) })),
    };
    return { awslogs: { data: zlib.gzipSync(Buffer.from(JSON.stringify(logData))).toString('base64') } };
}
const ctx = { getRemainingTimeInMillis: () => 20000 };

async function handlerTests() {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.AFORO_ENDPOINT = `http://127.0.0.1:${server.address().port}/v1/ingest/batch`;
    delete require.cache[require.resolve('../index')];
    const { handler } = require('../index');

    console.log('\nTest 7: handler is exported (index.handler resolvable by Lambda)');
    assertEquals(typeof handler, 'function', 'module.exports.handler is a function');

    console.log('\nTest 8: handler sends X-API-Key only, skips OPTIONS / no-customer / zero quantity');
    captured.length = 0;
    await handler(cwEvent([
        { requestId: 'a1', httpMethod: 'POST', resourcePath: '/v1/sms/send', status: '200', customerId: 'cust_1', responseLength: '10' },
        { requestId: 'a2', httpMethod: 'OPTIONS', resourcePath: '/v1/sms/send', status: '204', customerId: 'cust_1' },
        { requestId: 'a3', httpMethod: 'GET', resourcePath: '/v1/users/1', status: '200', customerId: '-' },
        { requestId: 'a4', httpMethod: 'GET', resourcePath: '/v1/users/1', status: '200', apiKey: 'SECRET' },
        { requestId: 'a5', httpMethod: 'GET', resourcePath: '/v1/users/2', status: '200', customerId: 'x'.repeat(65) },
        { requestId: 'a6', httpMethod: 'GET', resourcePath: '/v1/users/3', status: '200', customerId: 'cust_2' },
    ]), ctx);
    assertEquals(captured.length, 1, 'one POST');
    const req = captured[0];
    assertEquals(req.url, '/v1/ingest/batch', 'posts to /v1/ingest/batch');
    assertEquals(req.headers['x-api-key'], 'test-ingest-key', 'X-API-Key header carries the key');
    assertEquals(req.headers['authorization'], undefined, 'no Authorization header');
    assertEquals(req.headers['x-tenant-id'], undefined, 'no X-Tenant-Id header');
    const evs = req.body.events;
    assertEquals(evs.length, 2, 'only the two billable, attributed events are sent');
    assertEquals(evs.map(e => e.idempotencyKey).join(','), 'a1,a6', 'OPTIONS, blank, key-only and >64-char customers skipped');
    assertEquals(evs[0].customerId, 'cust_1', 'customerId from authorizer context');
    assertEquals(evs[0].metricName, 'sms_sent', 'mapped metric');
    assertEquals(evs[1].metricName, 'api_calls', 'default metric');
    assert(!JSON.stringify(req.body).includes('SECRET'), 'API key value never appears in the payload');
    assert(evs.every(e => e.quantity > 0 && !isNaN(Date.parse(e.occurredAt))), 'quantity > 0 and ISO occurredAt');

    console.log('\nTest 9: 400 is dropped without retry (no poison pill, no throw)');
    captured.length = 0; nextStatuses = [400];
    const r400 = await handler(cwEvent([{ requestId: 'b1', httpMethod: 'GET', resourcePath: '/a', status: '200', customerId: 'c' }]), ctx);
    assertEquals(captured.length, 1, 'exactly one attempt on 400');
    assertEquals(r400.statusCode, 200, 'handler completes');

    console.log('\nTest 10: 429 is retried');
    captured.length = 0; nextStatuses = [429];
    await handler(cwEvent([{ requestId: 'c1', httpMethod: 'GET', resourcePath: '/a', status: '200', customerId: 'c' }]), ctx);
    assertEquals(captured.length, 2, '429 then 202 → two attempts');

    console.log('\nTest 11: persistent 5xx throws so Lambda async retry re-delivers');
    captured.length = 0; nextStatuses = [503, 503, 503];
    let threw = false;
    try {
        await handler(cwEvent([{ requestId: 'd1', httpMethod: 'GET', resourcePath: '/a', status: '200', customerId: 'c' }]), ctx);
    } catch { threw = true; }
    assert(threw, 'handler throws on transient failure');
    assertEquals(captured.length, 3, 'three attempts');

    console.log('\nTest 12: retries stop at the Lambda deadline');
    captured.length = 0; nextStatuses = [503, 503, 503];
    const t0 = Date.now();
    try {
        await handler(cwEvent([{ requestId: 'e1', httpMethod: 'GET', resourcePath: '/a', status: '200', customerId: 'c' }]),
            { getRemainingTimeInMillis: () => 2000 });
    } catch { /* expected */ }
    assert(Date.now() - t0 < 1500, 'returned before the deadline instead of sleeping through it');
    assertEquals(captured.length, 1, 'no retry that could not finish in time');
    nextStatuses = [];

    console.log('\nTest 13: response_size quantity 0 is skipped');
    // Re-load with QUANTITY_SOURCE=response_size.
    delete require.cache[require.resolve('../index')];
    process.env.QUANTITY_SOURCE = 'response_size';
    const { buildUsageEvent } = require('../index');
    const zero = buildUsageEvent({ method: 'GET', path: '/a', status: 204, customerId: 'c', responseLength: 0, requestId: 'z' },
        { id: 'z', timestamp: 0 });
    assertEquals(zero.skip, 'quantity <= 0', 'zero-byte response not metered');
    delete process.env.QUANTITY_SOURCE;

    server.close();
}

handlerTests().catch(err => { failed++; console.error('  FAIL: handler tests threw', err); server.close(); })
    .finally(() => {
        console.log('\n── Results: ' + passed + ' passed, ' + failed + ' failed ──\n');
        process.exit(failed > 0 ? 1 : 0);
    });
