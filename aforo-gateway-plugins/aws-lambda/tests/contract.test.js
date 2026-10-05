/**
 * Wire-contract tests for the AWS Lambda aforo-metering handler, against a
 * local capture server: auth header, identity, metric mappings, productType,
 * retry / Retry-After / deadline, and the 2.2.0 merged behaviour.
 * Run with: node tests/contract.test.js  (npm test runs this and
 * tests/handler.test.js).
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
        const next = nextStatuses.length ? nextStatuses.shift() : 202;
        const status = typeof next === 'object' ? next.status : next;
        res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, next.headers || {}));
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

console.log('\nAWS Lambda Aforo Metering — Contract Tests\n');

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
    assert(evs.every(e => e.productType === 'API'), 'productType defaults to API on every event');

    console.log('\nTest 9: 400 is dropped without retry (no poison pill, no throw)');
    captured.length = 0; nextStatuses = [400];
    const r400 = await handler(cwEvent([{ requestId: 'b1', httpMethod: 'GET', resourcePath: '/a', status: '200', customerId: 'c' }]), ctx);
    assertEquals(captured.length, 1, 'exactly one attempt on 400');
    assertEquals(r400.statusCode, 200, 'handler completes');

    console.log('\nTest 10: 429 is retried');
    captured.length = 0; nextStatuses = [429];
    await handler(cwEvent([{ requestId: 'c1', httpMethod: 'GET', resourcePath: '/a', status: '200', customerId: 'c' }]), ctx);
    assertEquals(captured.length, 2, '429 then 202 → two attempts');

    console.log('\nTest 10a: 429 Retry-After is honoured; one beyond the cap ends the attempts');
    captured.length = 0; nextStatuses = [{ status: 429, headers: { 'Retry-After': '1' } }];
    let t = Date.now();
    await handler(cwEvent([{ requestId: 'c2', httpMethod: 'GET', resourcePath: '/a', status: '200', customerId: 'c' }]), ctx);
    assertEquals(captured.length, 2, '429 then 202 → two attempts');
    assert(Date.now() - t >= 950, 'waited the Retry-After second before retrying');
    captured.length = 0; nextStatuses = [{ status: 429, headers: { 'Retry-After': '3600' } }];
    let threw429 = false;
    t = Date.now();
    try {
        await handler(cwEvent([{ requestId: 'c3', httpMethod: 'GET', resourcePath: '/a', status: '200', customerId: 'c' }]), ctx);
    } catch { threw429 = true; }
    assertEquals(captured.length, 1, 'no retry when Retry-After exceeds the cap');
    assert(threw429 && Date.now() - t < 1000, 'fails transiently at once so Lambda re-delivers later');
    nextStatuses = [];

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

    console.log('\nTest 13a: FLUSH_COUNT is capped at the ingestor limit of 1000');
    delete require.cache[require.resolve('../index')];
    process.env.FLUSH_COUNT = '5000';
    assertEquals(require('../index').FLUSH_COUNT, 1000, 'FLUSH_COUNT=5000 → 1000');
    delete process.env.FLUSH_COUNT;

    console.log('\nTest 13b: PRODUCT_TYPE is configurable; MCP_SERVER only with toolName + agentId');
    delete require.cache[require.resolve('../index')];
    process.env.PRODUCT_TYPE = '  agentic_api ';
    process.env.MCP_ENABLED = 'true';
    let m = require('../index');
    const le = { id: 'p', timestamp: 0 };
    const base = { method: 'GET', path: '/a', status: 200, customerId: 'c', requestId: 'p1' };
    assertEquals(m.buildUsageEvent(base, le).event.productType, 'AGENTIC_API', 'PRODUCT_TYPE trimmed and upper-cased');
    const call = (meta) => JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'search', _meta: meta } });
    const withAgent = m.buildUsageEvent({ ...base, method: 'POST', requestBody: call({ agent_id: 'a1' }) }, le).event;
    assertEquals(withAgent.productType, 'MCP_SERVER', 'tools/call with agentId → MCP_SERVER');
    const noAgent = m.buildUsageEvent({ ...base, method: 'POST', requestBody: call({}) }, le).event;
    assertEquals(noAgent.productType, 'AGENTIC_API', 'tools/call without agentId keeps PRODUCT_TYPE');
    delete require.cache[require.resolve('../index')];
    process.env.PRODUCT_TYPE = 'AI_AGENT';
    m = require('../index');
    assert(m.buildUsageEvent(base, le).skip.startsWith('productType AI_AGENT missing'), 'AI_AGENT without agentId/sessionId skipped');
    const forged = m.buildUsageEvent({ ...base, headers: { 'x-agent-id': 'forged', 'x-session-id': 's' } }, le);
    assert(forged.skip && forged.skip.startsWith('productType AI_AGENT missing'), 'X-Agent-Id header never used as agentId');
    delete require.cache[require.resolve('../index')];
    process.env.PRODUCT_TYPE = 'NEW_TYPE';
    assertEquals(require('../index').buildUsageEvent(base, le).event.productType, 'NEW_TYPE', 'unknown type passed through');
    delete process.env.PRODUCT_TYPE;
    delete process.env.MCP_ENABLED;

    console.log('\nTest 13: response_size quantity 0 is skipped');
    // Re-load with QUANTITY_SOURCE=response_size.
    delete require.cache[require.resolve('../index')];
    process.env.QUANTITY_SOURCE = 'response_size';
    const { buildUsageEvent } = require('../index');
    const zero = buildUsageEvent({ method: 'GET', path: '/a', status: 204, customerId: 'c', responseLength: 0, requestId: 'z' },
        { id: 'z', timestamp: 0 });
    assertEquals(zero.skip, 'quantity <= 0', 'zero-byte response not metered');
    delete process.env.QUANTITY_SOURCE;

    // ── 2.2.0: merged behaviour ──
    const reload = (env) => {
        delete require.cache[require.resolve('../index')];
        const saved = {};
        for (const [k, v] of Object.entries(env)) {
            saved[k] = process.env[k];
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        const mod = require('../index');
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        return mod;
    };
    const le2 = { id: 'cw-1', timestamp: 1700000000000 };
    const entry = { method: 'GET', path: '/v1/users/42', status: 200, customerId: 'c', requestId: 'q1' };

    console.log('\nTest 14: metric precedence — mapping, then METRIC_NAME_PATTERN, then DEFAULT_METRIC');
    {
        const mappings = JSON.stringify([
            { matchType: 'PREFIX', value: '/v1/sms', metricName: 'sms_sent' },
            { matchType: 'CONTAINS', value: 'sms', metricName: 'never_reached' },
        ]);
        let m = reload({ METRIC_MAPPINGS: mappings, METRIC_NAME_PATTERN: '{method} {path}', DEFAULT_METRIC: 'fallback_metric' });
        assertEquals(m.buildUsageEvent({ ...entry, path: '/v1/sms/send' }, le2).event.metricName, 'sms_sent',
            'a mapping wins over the pattern, and the first matching rule wins');
        assertEquals(m.buildUsageEvent(entry, le2).event.metricName, 'GET /v1/users/42',
            'no mapping → the explicitly configured pattern');
        m = reload({ METRIC_MAPPINGS: mappings, METRIC_NAME_PATTERN: undefined, DEFAULT_METRIC: 'fallback_metric' });
        assertEquals(m.buildUsageEvent(entry, le2).event.metricName, 'fallback_metric', 'no mapping, no pattern → DEFAULT_METRIC');
        m = reload({ METRIC_MAPPINGS: undefined, METRIC_NAME_PATTERN: undefined, DEFAULT_METRIC: undefined });
        assertEquals(m.buildUsageEvent(entry, le2).event.metricName, 'api_calls', 'nothing configured → api_calls');
    }

    console.log('\nTest 15: a metric name that is empty or longer than 255 chars is dropped, not sent');
    {
        let m = reload({ METRIC_MAPPINGS: JSON.stringify([{ matchType: 'PREFIX', value: '/v1', metricName: 'x'.repeat(256) }]) });
        assertEquals(m.buildUsageEvent(entry, le2).skip, 'invalid metricName', '256-char mapped metric dropped');
        m = reload({ METRIC_MAPPINGS: undefined, DEFAULT_METRIC: '   ' });
        assertEquals(m.buildUsageEvent(entry, le2).skip, 'invalid metricName', 'blank metric dropped');
        m = reload({ METRIC_MAPPINGS: JSON.stringify([{ matchType: 'PREFIX', value: '/v1', metricName: 'x'.repeat(255) }]) });
        assertEquals(m.buildUsageEvent(entry, le2).event.metricName.length, 255, '255-char metric is sent');
    }

    console.log('\nTest 16: customer comes from verified identity only');
    {
        let m = reload({ CUSTOMER_ID_SOURCE: undefined });
        const iam = m.parseAccessLog(JSON.stringify({ requestId: 'i1', httpMethod: 'GET', resourcePath: '/a', status: '200',
            caller: 'AIDAEXAMPLE', apiKey: 'sk_live_secret', principalId: 'aforo-user', customerId: '-' }));
        assertEquals(m.buildUsageEvent(iam, le2).event.customerId, 'AIDAEXAMPLE', 'IAM caller used when the authorizer set no customerId');
        const both = m.parseAccessLog(JSON.stringify({ requestId: 'i2', httpMethod: 'GET', resourcePath: '/a', status: '200',
            caller: 'AIDAEXAMPLE', customerId: 'cust-9' }));
        assertEquals(m.buildUsageEvent(both, le2).event.customerId, 'cust-9', 'authorizer customerId wins over the IAM caller');
        const keyOnly = m.parseAccessLog(JSON.stringify({ requestId: 'i3', httpMethod: 'GET', resourcePath: '/a', status: '200',
            apiKey: 'sk_live_secret', 'identity.apiKey': 'sk_live_secret', principalId: 'aforo-user', ip: '192.0.2.9' }));
        assertEquals(m.buildUsageEvent(keyOnly, le2).skip, 'no customerId', 'API key value / principalId / IP never become the customer');
        assert(!JSON.stringify(keyOnly).includes('sk_live_secret'), 'the API key value is not even parsed');
        m = reload({ CUSTOMER_ID_SOURCE: 'authorizer' });
        assertEquals(m.buildUsageEvent(iam, le2).skip, 'no customerId', 'CUSTOMER_ID_SOURCE=authorizer ignores the IAM caller');
        m = reload({ CUSTOMER_ID_SOURCE: 'header' });
        assertEquals(m.normalizeCustomerIdSource('header'), 'authorizer', 'removed value "header" falls back to authorizer');
        assertEquals(m.buildUsageEvent({ ...entry, customerId: '', headers: { 'x-customer-id': 'forged' } }, le2).skip,
            'no customerId', 'a request header is never an identity');
    }

    console.log('\nTest 17: traceparent → AGENTIC_API only when PRODUCT_TYPE is API');
    {
        const traced = { ...entry, headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } };
        let m = reload({ PRODUCT_TYPE: undefined });
        const ev = m.buildUsageEvent(traced, le2).event;
        assertEquals(ev.productType, 'AGENTIC_API', 'default PRODUCT_TYPE + traceparent → AGENTIC_API');
        assertEquals(ev.traceId, '4bf92f3577b34da6a3ce929d0e0e4736', 'traceId top-level');
        assertEquals(m.buildUsageEvent(entry, le2).event.productType, 'API', 'no trace → API');
        m = reload({ PRODUCT_TYPE: 'partner_api' });
        assertEquals(m.buildUsageEvent(traced, le2).event.productType, 'PARTNER_API', 'an explicit non-API PRODUCT_TYPE is kept');
    }

    console.log('\nTest 18: EXCLUDE_STATUS_CODES — a list replaces the default; none meters everything');
    {
        let m = reload({ EXCLUDE_STATUS_CODES: undefined });
        assertEquals(m.buildUsageEvent({ ...entry, status: 401 }, le2).skip, 'excluded status', '401 skipped by default');
        m = reload({ EXCLUDE_STATUS_CODES: '404' });
        assertEquals(m.buildUsageEvent({ ...entry, status: 404 }, le2).skip, 'excluded status', 'configured 404 skipped');
        assertEquals(m.buildUsageEvent({ ...entry, status: 401 }, le2).event.executionStatus, 'BLOCKED', '401 now metered as BLOCKED');
        m = reload({ EXCLUDE_STATUS_CODES: 'none' });
        assertEquals(m.buildUsageEvent({ ...entry, status: 429 }, le2).event.executionStatus, 'BLOCKED', '"none" meters 429');
        m = reload({ EXCLUDE_STATUS_CODES: '', STATUS_OUTCOMES: '404=ERROR,404=validation_failed' });
        assertEquals(m.buildUsageEvent({ ...entry, status: 404 }, le2).event.executionStatus, 'VALIDATION_FAILED',
            'STATUS_OUTCOMES override applies; last duplicate wins');
    }

    console.log('\nTest 19: the same idempotency key on every retry and on redelivery');
    {
        const m = reload({});
        const evt = cwEvent([{ requestId: 'idem-1', httpMethod: 'GET', resourcePath: '/a', status: '200', customerId: 'c' }]);
        captured.length = 0; nextStatuses = [503, 202];
        await m.handler(evt, ctx);
        assertEquals(captured.length, 2, 'one retry');
        assertEquals(captured[0].body.events[0].idempotencyKey, 'idem-1', 'key is the requestId');
        assertEquals(JSON.stringify(captured[1].body), JSON.stringify(captured[0].body), 'the retry body is identical');
        captured.length = 0; nextStatuses = [];
        await m.handler(evt, ctx);
        assertEquals(captured[0].body.events[0].idempotencyKey, 'idem-1', 'a redelivered log payload rebuilds the same key');
    }

    console.log('\nTest 20: Retry-After never sleeps past the Lambda deadline');
    {
        const m = reload({});
        captured.length = 0; nextStatuses = [{ status: 429, headers: { 'Retry-After': '20' } }, 202];
        const t1 = Date.now();
        let threw20 = false;
        try {
            await m.handler(cwEvent([{ requestId: 'ra-1', httpMethod: 'GET', resourcePath: '/a', status: '200', customerId: 'c' }]),
                { getRemainingTimeInMillis: () => 5000 });
        } catch { threw20 = true; }
        assert(threw20, 'a Retry-After beyond the remaining time fails the invocation (Lambda redelivers)');
        assert(Date.now() - t1 < 1500, 'did not sleep for the 20 s Retry-After');
        assertEquals(captured.length, 1, 'no second attempt');
        nextStatuses = [];
    }

    console.log('\nTest 21: compound event — frozen correlationId, both call shapes');
    {
        const c = require('../compound-metering');
        const ms = [{ metricName: 'input-tokens', quantity: 5 }];
        const a = c.buildCompoundEvent('cust', ms, {}, 'req-77');
        const b = c.buildCompoundEvent('cust', ms, {}, 'req-77');
        assertEquals(a.correlationId, b.correlationId, 'same seed → same correlationId');
        assert(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a.correlationId), 'correlationId is UUID-shaped');
        assertEquals(a.productType, 'API', 'productType defaults to API');
        assertEquals(c.buildCompoundEvent('cust', ms, {}, 'req-77', ' ai_agent ').productType, 'AI_AGENT', '5th argument sets productType');
        const legacy1 = c.buildCompoundEvent('cust', ms, { requestId: 'r-1' }, 'AI_AGENT');
        const legacy2 = c.buildCompoundEvent('cust', ms, { requestId: 'r-2' }, 'AI_AGENT');
        assertEquals(legacy1.productType, 'AI_AGENT', '2.1.0 call shape: 4th argument read as productType');
        assert(legacy1.correlationId !== legacy2.correlationId, '…and never used as a shared seed');
        assertEquals(legacy1.correlationId, c.buildCompoundEvent('cust', ms, { requestId: 'r-1' }).correlationId,
            'seed falls back to metadata.requestId');
        const opt = c.buildCompoundEvent('cust', ms, {}, { correlationSeed: 'req-77', productType: 'mcp_server' });
        assertEquals(opt.correlationId, a.correlationId, 'options object carries the seed');
        assertEquals(opt.productType, 'MCP_SERVER', 'options object carries the productType');
        assertEquals(c.buildCompoundEvent('', ms, {}, 'req-77'), null, 'no customer → no event');
        assertEquals(c.buildCompoundEvent('x'.repeat(65), ms, {}, 'req-77'), null, 'customerId over 64 chars → no event');
    }

    server.close();
}

handlerTests().catch(err => { failed++; console.error('  FAIL: handler tests threw', err); server.close(); })
    .finally(() => {
        console.log('\n── Results: ' + passed + ' passed, ' + failed + ' failed ──\n');
        process.exit(failed > 0 ? 1 : 0);
    });
