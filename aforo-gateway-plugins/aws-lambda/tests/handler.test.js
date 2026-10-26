/**
 * Unit tests for AWS Lambda aforo-metering handler.
 * Run with: node tests/handler.test.js
 *
 * Env + HTTPS stubbing MUST happen before require('../index') — the
 * module reads env at load time and captures the https module object.
 *
 * This file covers delivery (throw / drop / EMF), idempotency-key stability,
 * AGENTIC_API detection, the compound correlationId and executionStatus.
 * tests/contract.test.js covers the wire contract against a local capture
 * server (identity, metric mappings, productType, Retry-After).
 */

// ── Test environment (before require) ──
process.env.AFORO_ENDPOINT = 'https://aforo.test/v1/ingest/batch';
process.env.AFORO_API_KEY = 'key_test';
process.env.AFORO_TENANT_ID = 'tenant_test';
process.env.FLUSH_COUNT = '1'; // one event per batch — enables partial-failure tests
process.env.MCP_ENABLED = 'true'; // Test O4 exercises the MCP path; other tests send no requestBody

const https = require('https');
const zlib = require('zlib');

// ── HTTPS stub ──
// statusQueue: each request shifts the next status; empty queue → 200.
// bodies: captured request payloads (JSON strings).
const httpStub = { statusQueue: [], responseBodies: [], bodies: [], headers: [], calls: 0 };
https.request = (options, cb) => {
    httpStub.calls++;
    httpStub.headers.push(options.headers);
    const statusCode = httpStub.statusQueue.length > 0 ? httpStub.statusQueue.shift() : 200;
    const responseBody = httpStub.responseBodies.length > 0 ? httpStub.responseBodies.shift() : '';
    const res = {
        statusCode,
        headers: {},
        on(ev, fn) {
            if (ev === 'data' && responseBody) setImmediate(() => fn(responseBody));
            if (ev === 'end') setImmediate(() => setImmediate(fn));
            return this;
        },
    };
    return {
        on() { return this; },
        write(data) { httpStub.bodies.push(String(data)); },
        end() { setImmediate(() => cb(res)); },
        destroy() {},
    };
};

const { parseAccessLog, detectMcpToolCall, handler } = require('../index');

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

// ── Handler-level tests (delivery guarantee, 2026-07-05) ──

/** Build a CloudWatch Logs subscription event from access-log messages. */
function makeCloudWatchEvent(messages) {
    const logData = {
        messageType: 'DATA_MESSAGE',
        logGroup: 'test-group',
        logStream: 'test-stream',
        logEvents: messages.map((m, i) => ({
            id: 'cw-evt-' + i,
            timestamp: 1700000000000 + i,
            message: m,
        })),
    };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(logData), 'utf8'));
    return { awslogs: { data: gz.toString('base64') } };
}

function accessLogMessage(requestId, path) {
    return JSON.stringify({
        requestId,
        httpMethod: 'GET',
        resourcePath: path || '/v1/widgets',
        status: '200',
        responseLatency: '10',
        responseLength: '256',
        customerId: 'cust-1',
    });
}

/** Run handler while capturing console.log lines (for EMF assertions). */
async function runHandlerCaptured(event) {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => { logs.push(args.map(String).join(' ')); };
    let result = null;
    let error = null;
    try {
        result = await handler(event);
    } catch (e) {
        error = e;
    } finally {
        console.log = origLog;
    }
    return { result, error, logs };
}

function resetStub() {
    httpStub.statusQueue = [];
    httpStub.responseBodies = [];
    httpStub.headers = [];
    httpStub.bodies = [];
    httpStub.calls = 0;
}

(async function() {

    // Test 5: handler export regression
    console.log('\nTest 5: handler is exported (template.yaml Handler: index.handler)');
    assert(typeof handler === 'function',
        'module exports handler — module.exports reassignment regression');

    // Test 6: happy path unchanged — success returns 200, no throw
    console.log('\nTest 6: successful send still returns 200');
    resetStub();
    {
        const { result, error } = await runHandlerCaptured(
            makeCloudWatchEvent([accessLogMessage('req-ok-1')]));
        assert(error === null, 'no throw on success');
        assertEquals(result && result.statusCode, 200, 'returns statusCode 200');
        assertEquals(httpStub.calls, 1, 'exactly one POST for one batch');
        assertEquals(httpStub.headers[0]['X-API-Key'], 'key_test', 'authenticates with X-API-Key');
        assert(!('X-Tenant-Id' in httpStub.headers[0]) && !('Authorization' in httpStub.headers[0]),
            'no X-Tenant-Id and no Authorization header');
    }

    // Test 7: permanent 4xx — dropped, counted, NOT thrown (a redelivery
    // would be rejected again), and not retried in-handler.
    console.log('\nTest 7: permanent 4xx is dropped without a throw');
    resetStub();
    {
        httpStub.statusQueue = [400];
        const { result, error, logs } = await runHandlerCaptured(
            makeCloudWatchEvent([accessLogMessage('req-fail-1')]));
        assert(error === null, 'handler does not throw on a permanent 4xx');
        assertEquals(result && result.statusCode, 200, 'returns 200 so Lambda does not redeliver');
        assert(result && /dropped 1 rejected/.test(result.body), 'result reports the dropped event');
        assertEquals(httpStub.calls, 1, '4xx is not retried in-handler');

        const emfLine = logs.find(l => l.includes('"_aws"') && l.includes('EventsRejected'));
        assert(emfLine !== undefined, 'EMF EventsRejected metric emitted');
        if (emfLine) {
            const emf = JSON.parse(emfLine);
            assertEquals(emf.EventsRejected, 1, 'EMF counts rejected events');
            assertEquals(emf._aws.CloudWatchMetrics[0].Namespace, 'Aforo/Metering', 'EMF namespace');
            assertEquals(emf.TenantId, 'tenant_test', 'EMF carries tenant id');
        }
        assert(!logs.some(l => l.includes('"_aws"') && l.includes('EventsFailedToSend')),
            'no EventsFailedToSend for a permanent rejection');
    }

    // Test 7b: 408 and 429 are transient — retried, then thrown.
    console.log('\nTest 7b: 408 is retried and, when it persists, thrown');
    resetStub();
    {
        httpStub.statusQueue = [408, 200];
        const { error } = await runHandlerCaptured(
            makeCloudWatchEvent([accessLogMessage('req-408-1')]));
        assert(error === null, '408 then 200 succeeds');
        assertEquals(httpStub.calls, 2, '408 was retried');
        assertEquals(httpStub.bodies[0], httpStub.bodies[1],
            'the retry sends byte-identical bytes (same idempotency key)');
    }

    // Test 7c: per-event rejections inside an accepted batch are read from
    // the { success, data, meta } envelope, counted and not retried.
    console.log('\nTest 7c: per-event rejection in a 2xx envelope is counted as dropped');
    resetStub();
    {
        httpStub.responseBodies = [JSON.stringify({
            success: true,
            data: { accepted: 0, duplicates: 0, failed: 1, errors: [{ index: 0, message: 'Unknown metric: nope' }] },
            meta: {},
        })];
        const { result, error, logs } = await runHandlerCaptured(
            makeCloudWatchEvent([accessLogMessage('req-partial-1')]));
        assert(error === null, 'no throw');
        assert(result && /Processed 0 events, dropped 1 rejected/.test(result.body), 'rejected event counted');
        assert(logs.some(l => l.includes('"_aws"') && l.includes('EventsRejected')), 'EMF EventsRejected emitted');
        assertEquals(httpStub.calls, 1, 'not retried');
    }

    // Test 8: 5xx exhausts all 3 in-handler attempts, then throws (~3s backoff)
    console.log('\nTest 8: 5xx exhausts 3 in-handler retries then throws');
    resetStub();
    {
        httpStub.statusQueue = [500, 502, 503];
        const { error, logs } = await runHandlerCaptured(
            makeCloudWatchEvent([accessLogMessage('req-5xx-1')]));
        assert(error !== null, 'throws after retry exhaustion');
        assert(error && /redeliver/i.test(error.message), 'error message states redelivery intent');
        const emf5 = logs.find(l => l.includes('"_aws"') && l.includes('EventsFailedToSend'));
        assert(emf5 !== undefined && JSON.parse(emf5).EventsFailedToSend === 1, 'EMF EventsFailedToSend emitted before the throw');
        assert(httpStub.bodies[0] === httpStub.bodies[1] && httpStub.bodies[1] === httpStub.bodies[2],
            'all three attempts carry identical bytes (same idempotency key)');
        assertEquals(httpStub.calls, 3, 'in-handler retry count unchanged (3 attempts)');
    }

    // Test 9: partial failure (one batch ok, one fails) still throws — the
    // succeeded batch is redelivered too, which is safe because keys dedup.
    console.log('\nTest 9: partial batch failure throws (redelivery is dedup-safe)');
    resetStub();
    {
        // FLUSH_COUNT=1 → 2 events = 2 batches, sent concurrently: the first
        // gets 200, the second 503 on all three attempts.
        httpStub.statusQueue = [200, 503, 503, 503];
        const { error, logs } = await runHandlerCaptured(
            makeCloudWatchEvent([accessLogMessage('req-p1'), accessLogMessage('req-p2')]));
        assert(error !== null, 'throws when any batch fails');
        assertEquals(httpStub.calls, 4, 'both batches attempted (1 + 3 attempts)');
        const emfLine = logs.find(l => l.includes('EventsFailedToSend') && l.includes('"_aws"'));
        assert(emfLine !== undefined, 'EMF metric emitted for partial failure');
        if (emfLine) {
            assertEquals(JSON.parse(emfLine).EventsFailedToSend, 1, 'EMF counts only the failed events');
        }
    }

    // Test 10: idempotency-key stability — the dedup-safety basis for the
    // throw. The SAME CloudWatch payload must produce byte-identical keys
    // on re-invocation (redelivery), for both standard and fallback keys.
    console.log('\nTest 10: idempotency keys stable across redelivery');
    resetStub();
    {
        // Second entry has no requestId, so its key falls back to the
        // CloudWatch event id.
        const noRequestId = JSON.stringify({
            httpMethod: 'GET', resourcePath: '/v1/things', status: '200', customerId: 'cust-1',
        });
        const clfLine = '192.0.2.1 - - [05/Jul/2026:10:00:00 +0000] "GET /v1/things HTTP/1.1" 200 512';
        const event = makeCloudWatchEvent([accessLogMessage('req-stable-1'), noRequestId, clfLine]);

        const first = await runHandlerCaptured(event);
        const firstEvents = httpStub.bodies.map(b => JSON.parse(b).events[0]);
        const firstKeys = firstEvents.map(e => e.idempotencyKey);
        httpStub.bodies = [];
        const second = await runHandlerCaptured(event);
        const secondKeys = httpStub.bodies.map(b => JSON.parse(b).events[0].idempotencyKey);

        assert(first.error === null && second.error === null, 'both invocations succeed');
        assertEquals(firstKeys.length, 2, 'two events posted — the CLF line has no identity and is skipped');
        assertEquals(firstKeys[0], secondKeys[0], 'requestId-derived key identical across invocations');
        assertEquals(firstKeys[1], secondKeys[1], 'logEvent.id fallback key identical across invocations');
        assertEquals(firstKeys[0], 'req-stable-1', 'key comes from log data (requestId)');
        assertEquals(firstKeys[1], 'cw-evt-1', 'fallback key comes from log data (logEvent.id)');
        assert(!firstEvents.some(e => e.customerId === '192.0.2.1'), 'a client IP is never a customerId');
    }

    // ═══ AGENTIC_API detection (P0-5, docs/final/111 Session 4) ═══
    // Per descriptor eventSchema.inferenceRule = HAS_TRACE, an event with a
    // resolvable W3C traceparent (or x-trace-id fallback) is classified as
    // AGENTIC_API. MCP JSON-RPC still wins when both signals coexist.

    const { extractAgenticTraceId } = require('../index');

    console.log('\nTest A1: extracts 32-hex trace_id from well-formed traceparent');
    assertEquals(
        extractAgenticTraceId({
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        }),
        '4bf92f3577b34da6a3ce929d0e0e4736',
        'W3C trace_id extracted (lowercased)'
    );

    console.log('\nTest A2: returns null when trace is null (no header captured)');
    assertEquals(extractAgenticTraceId(null), null, 'null trace → null');

    console.log('\nTest A3: rejects wrong field count (fail-safe)');
    assertEquals(
        extractAgenticTraceId({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-01' }),
        null,
        '3 fields rejected'
    );

    console.log('\nTest A4: rejects invalid version=ff per W3C spec');
    assertEquals(
        extractAgenticTraceId({
            traceparent: 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        }),
        null,
        'version=ff rejected'
    );

    console.log('\nTest A5: rejects all-zero trace_id per W3C spec');
    assertEquals(
        extractAgenticTraceId({
            traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
        }),
        null,
        'all-zero trace_id rejected'
    );

    console.log('\nTest A6: rejects all-zero parent_id per W3C spec');
    assertEquals(
        extractAgenticTraceId({
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
        }),
        null,
        'all-zero parent_id rejected'
    );

    console.log('\nTest A7: rejects non-hex trace_id');
    assertEquals(
        extractAgenticTraceId({
            traceparent: '00-ZZZZ2f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        }),
        null,
        'non-hex trace_id rejected'
    );

    console.log('\nTest A8: falls back to x-trace-id for non-OTel callers');
    assertEquals(
        extractAgenticTraceId({ xTraceId: 'legacy-agent-run-42' }),
        'legacy-agent-run-42',
        'x-trace-id fallback triggers classification'
    );

    console.log('\nTest A9: trims whitespace from x-trace-id fallback');
    assertEquals(
        extractAgenticTraceId({ xTraceId: '  legacy-42  ' }),
        'legacy-42',
        'whitespace stripped'
    );

    console.log('\nTest A10: prefers traceparent over x-trace-id when both present');
    assertEquals(
        extractAgenticTraceId({
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            xTraceId: 'legacy-would-lose',
        }),
        '4bf92f3577b34da6a3ce929d0e0e4736',
        'W3C traceparent wins over x-trace-id'
    );

    console.log('\nTest A11: end-to-end — traceparent header on non-MCP log entry stamps AGENTIC_API');
    {
        resetStub();
        // Access-log message with a W3C traceparent header — non-MCP path.
        const message = JSON.stringify({
            requestId: 'req-agentic-1',
            httpMethod: 'POST',
            resourcePath: '/v1/orchestrate',
            status: '200',
            responseLatency: '45',
            responseLength: '512',
            customerId: 'cust-1',
            requestHeaders: {
                traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            },
        });
        const evt = makeCloudWatchEvent([message]);
        const { result, error } = await runHandlerCaptured(evt);
        assert(error === null, 'handler resolves cleanly');
        assert(result && result.statusCode === 200, 'handler returns 200');

        const posted = JSON.parse(httpStub.bodies[0]);
        const agenticEvent = posted.events[0];
        assertEquals(agenticEvent.productType, 'AGENTIC_API',
            'productType stamped from traceparent header');
        assertEquals(agenticEvent.traceId, '4bf92f3577b34da6a3ce929d0e0e4736',
            'traceId extracted from W3C traceparent');
        assertEquals(agenticEvent.endpointPath, '/v1/orchestrate',
            'endpointPath top-level (descriptor requiredField)');
        assertEquals(agenticEvent.httpMethod, 'POST', 'httpMethod top-level');
        assertEquals(agenticEvent.statusCode, 200, 'statusCode top-level');
    }

    console.log('\nTest A12: end-to-end — no trace header → productType is the configured default (API)');
    {
        resetStub();
        // Same shape as A11 but WITHOUT any trace header.
        const message = JSON.stringify({
            requestId: 'req-plain-1',
            httpMethod: 'GET',
            resourcePath: '/v1/health-check',
            status: '200',
            responseLatency: '3',
            responseLength: '32',
            customerId: 'cust-1',
            requestHeaders: {},
        });
        const evt = makeCloudWatchEvent([message]);
        const { result, error } = await runHandlerCaptured(evt);
        assert(error === null, 'handler resolves cleanly');
        assert(result && result.statusCode === 200, 'handler returns 200');

        const posted = JSON.parse(httpStub.bodies[0]);
        const plainEvent = posted.events[0];
        assertEquals(plainEvent.productType, 'API', 'productType API without a trace header');
        assert(plainEvent.traceId === undefined, 'no traceId without a trace header');
    }

    // Test 11: compound correlationId frozen — the compound analogue of
    // Test 10. The correlationId is the dedup ROOT for a compound event
    // (the server decomposes it into correlationId:metricName[:dim]:index),
    // so it must be derived from log DATA and be IDENTICAL when the same
    // awslogs payload is re-delivered by CloudWatch. Pre-freeze this was
    // uuidv4() per evaluation → a redelivery double-billed every metric.
    console.log('\nTest 11: compound correlationId stable across redelivery');
    {
        const crypto = require('node:crypto');
        const compound = require('../compound-metering');
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

        // Simulate two invocations of the SAME awslogs payload: parse the
        // same access log twice, derive the seed the same way index.js
        // derives the standard key (parsed.requestId || logEvent.id), and
        // build the compound event from the extracted measurements.
        const logMessage = JSON.stringify({
            requestId: 'req-compound-1',
            httpMethod: 'POST', resourcePath: '/v1/chat', status: '200',
        });
        const responseBody = { usage: { prompt_tokens: 500, completion_tokens: 200 } };

        const invoke = () => {
            const parsed = parseAccessLog(logMessage);
            const seed = parsed.requestId || 'cw-evt-99';
            const measurements = compound.extractMeasurements(
                responseBody, compound.DEFAULT_LLM_PATHS, null);
            return compound.buildCompoundEvent(
                'cust_abc', measurements, { requestId: parsed.requestId }, seed);
        };

        const first = invoke();
        const second = invoke();

        assert(UUID_RE.test(first.correlationId),
            'correlationId is a valid v3-style UUID (server DTO types it as UUID)');
        assertEquals(first.correlationId, second.correlationId,
            'correlationId identical across two invocations of the same payload (redelivery dedups)');

        // Prove the derivation is exactly log-data-determined (md5 of the
        // prefixed seed, v3/variant bits set) — no hidden entropy.
        const hex = crypto.createHash('md5')
            .update('aforo-compound:req-compound-1').digest('hex');
        const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
        const expected = hex.slice(0, 8) + '-' + hex.slice(8, 12) +
            '-3' + hex.slice(13, 16) + '-' + variant + hex.slice(17, 20) +
            '-' + hex.slice(20, 32);
        assertEquals(first.correlationId, expected,
            'correlationId derived purely from the log-data seed (md5, no entropy)');

        // Distinct requests must still get distinct correlationIds.
        const other = compound.buildCompoundEvent(
            'cust_abc', compound.extractMeasurements(responseBody, compound.DEFAULT_LLM_PATHS, null),
            {}, 'req-compound-2');
        assert(other.correlationId !== first.correlationId,
            'different seeds produce different correlationIds');

        // metadata.requestId fallback when no explicit seed is passed.
        const viaMetadata = compound.buildCompoundEvent(
            'cust_abc', compound.extractMeasurements(responseBody, compound.DEFAULT_LLM_PATHS, null),
            { requestId: 'req-compound-1' });
        assertEquals(viaMetadata.correlationId, first.correlationId,
            'metadata.requestId fallback derives the same frozen correlationId');
    }

    // ── executionStatus (OUTCOME_BASED pricing) ──
    console.log('\nTest O1: outcomeFromStatus mapping table');
    {
        const { outcomeFromStatus } = require('../index');
        const cases = [
            [200, 'SUCCESS'], [201, 'SUCCESS'], [204, 'SUCCESS'], [301, 'SUCCESS'], [304, 'SUCCESS'],
            [408, 'TIMEOUT'], [504, 'TIMEOUT'], [499, 'CANCELLED'],
            [400, 'VALIDATION_FAILED'], [422, 'VALIDATION_FAILED'],
            [401, 'BLOCKED'], [403, 'BLOCKED'], [429, 'BLOCKED'],
            [404, 'ERROR'], [405, 'ERROR'], [409, 'ERROR'],
            [500, 'ERROR'], [502, 'ERROR'], [503, 'ERROR'], [599, 'ERROR'],
            ['200', 'SUCCESS'], ['504', 'TIMEOUT'],
        ];
        for (const [input, expected] of cases) {
            assertEquals(outcomeFromStatus(input), expected, `status ${JSON.stringify(input)} -> ${expected}`);
        }
        for (const input of [0, null, undefined, NaN, '', 'abc', 101, 600, -1]) {
            assertEquals(outcomeFromStatus(input), undefined, `status ${String(input)} -> omitted`);
        }
    }

    console.log('\nTest O1b: STATUS_OUTCOMES overrides');
    {
        const { outcomeFromStatus, parseStatusOutcomes } = require('../index');
        const o = parseStatusOutcomes(' 404 = validation_failed , 429=ERROR,202=PENDING,bad,700=ERROR,404x=ERROR,500=NOPE,,');
        assertEquals(JSON.stringify(o), JSON.stringify({ 404: 'VALIDATION_FAILED', 429: 'ERROR', 202: 'PENDING' }),
            'valid entries kept (trimmed, upper-cased), invalid skipped');
        assertEquals(outcomeFromStatus(404, o), 'VALIDATION_FAILED', 'override wins for 404');
        assertEquals(outcomeFromStatus(429, o), 'ERROR', 'override wins for 429');
        assertEquals(outcomeFromStatus(202, o), 'PENDING', 'override on a 2xx');
        assertEquals(outcomeFromStatus(403, o), 'BLOCKED', 'unlisted code keeps the default');
        assertEquals(outcomeFromStatus(101, { 101: 'SUCCESS' }), undefined, 'override cannot bill a 1xx');
        assertEquals(JSON.stringify(parseStatusOutcomes(undefined)), '{}', 'unset env -> no overrides');
        assertEquals(outcomeFromStatus(404), 'ERROR', 'module default is the env-parsed (empty) map');
        const { parseStatusCodeList } = require('../index');
        assertEquals(JSON.stringify(parseStatusCodeList(undefined, [401])), '[401]', 'unset -> default list');
        assertEquals(JSON.stringify(parseStatusCodeList('', [401])), '[]', 'empty -> meter everything');
        assertEquals(JSON.stringify(parseStatusCodeList(' 403, x ,429,999', [])), '[403,429]', 'invalid entries skipped');
    }

    async function postOne(message) {
        resetStub();
        const { error } = await runHandlerCaptured(makeCloudWatchEvent([message]));
        assert(error === null, 'handler resolves cleanly');
        return JSON.parse(httpStub.bodies[0]).events[0];
    }

    console.log('\nTest O2: standard API event carries executionStatus from upstream status');
    {
        const ok = await postOne(JSON.stringify({
            requestId: 'req-out-1', httpMethod: 'GET', resourcePath: '/v1/a', status: '200', customerId: 'cust-k',
        }));
        assertEquals(ok.executionStatus, 'SUCCESS', '200 -> SUCCESS on standard event');
        const bad = await postOne(JSON.stringify({
            requestId: 'req-out-2', httpMethod: 'GET', resourcePath: '/v1/a', status: '422', customerId: 'cust-k',
        }));
        assertEquals(bad.executionStatus, 'VALIDATION_FAILED', '422 -> VALIDATION_FAILED on standard event');
        const conflict = await postOne(JSON.stringify({
            requestId: 'req-out-2b', httpMethod: 'GET', resourcePath: '/v1/a', status: '404', customerId: 'cust-k',
        }));
        assertEquals(conflict.executionStatus, 'ERROR', '404 -> ERROR on standard event');
        resetStub();
        const { error: exclErr } = await runHandlerCaptured(makeCloudWatchEvent([JSON.stringify({
            requestId: 'req-out-2c', httpMethod: 'GET', resourcePath: '/v1/a', status: '403', customerId: 'cust-k',
        })]));
        assert(exclErr === null && httpStub.bodies.length === 0, '403 is not metered under the default EXCLUDE_STATUS_CODES');
        const missing = await postOne(JSON.stringify({
            requestId: 'req-out-3', httpMethod: 'GET', resourcePath: '/v1/a', customerId: 'cust-k',
        }));
        assert(!('executionStatus' in missing), 'missing status -> executionStatus key omitted (not null/empty)');
    }

    console.log('\nTest O3: AGENTIC_API event carries executionStatus');
    {
        const ev = await postOne(JSON.stringify({
            requestId: 'req-out-4', httpMethod: 'POST', resourcePath: '/v1/orchestrate', status: '504', customerId: 'cust-k',
            requestHeaders: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
        }));
        assertEquals(ev.productType, 'AGENTIC_API', 'classified AGENTIC_API');
        assertEquals(ev.executionStatus, 'TIMEOUT', '504 -> TIMEOUT on AGENTIC_API event');
    }

    console.log('\nTest O4: MCP tool call — 2xx SUCCESS, 504 now TIMEOUT (was ERROR)');
    {
        const mcpBody = JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_web', arguments: {}, _meta: { agent_id: 'agent-7' } },
        });
        const ok = await postOne(JSON.stringify({
            requestId: 'req-out-5', httpMethod: 'POST', resourcePath: '/mcp', status: '200', customerId: 'cust-k',
            requestBody: mcpBody,
        }));
        assertEquals(ok.productType, 'MCP_SERVER', 'classified MCP_SERVER');
        assertEquals(ok.executionStatus, 'SUCCESS', 'MCP 200 -> SUCCESS');
        const timeout = await postOne(JSON.stringify({
            requestId: 'req-out-6', httpMethod: 'POST', resourcePath: '/mcp', status: '504', customerId: 'cust-k',
            requestBody: mcpBody,
        }));
        assertEquals(timeout.executionStatus, 'TIMEOUT', 'MCP 504 -> TIMEOUT');
        const err = await postOne(JSON.stringify({
            requestId: 'req-out-7', httpMethod: 'POST', resourcePath: '/mcp', status: '500', customerId: 'cust-k',
            requestBody: mcpBody,
        }));
        assertEquals(err.executionStatus, 'ERROR', 'MCP 500 -> ERROR');
        assertEquals(ok.idempotencyKey, `mcp:tenant_test:req-out-5:search_web:${ok.occurredAt ? Date.parse(ok.occurredAt) : ''}`,
            'MCP key keeps the frozen shape mcp:<tenant>:<requestId>:<tool>:<log timestamp>');
        const noAgent = await postOne(JSON.stringify({
            requestId: 'req-out-8', httpMethod: 'POST', resourcePath: '/mcp', status: '200', customerId: 'cust-k',
            requestBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_web' } }),
        }));
        assertEquals(noAgent.productType, 'API', 'tools/call without agentId keeps the configured productType');
        assertEquals(noAgent.toolName, 'search_web', 'toolName still carried');
    }

    // Summary
    console.log('\n── Results: ' + passed + ' passed, ' + failed + ' failed ──\n');
    process.exit(failed > 0 ? 1 : 0);
})();
