/**
 * AI_AGENT / MCP_SERVER metering from metering-proxy records (index.js).
 * Run with: node tests/agent-mcp.test.js
 */
'use strict';

const https = require('https');
const zlib = require('zlib');

process.env.AFORO_ENDPOINT = 'https://aforo.test/v1/ingest/batch';
process.env.AFORO_API_KEY = 'key_test';

const posted = [];
https.request = (options, cb) => {
    const res = {
        statusCode: 200, headers: {},
        on(ev, fn) { if (ev === 'end') setImmediate(fn); return this; },
    };
    return {
        on() { return this; },
        write(d) { posted.push(JSON.parse(String(d))); },
        end() { setImmediate(() => cb(res)); },
        destroy() {},
    };
};

let passed = 0;
let failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  PASS: ' + msg); } else { failed++; console.error('  FAIL: ' + msg); } }
function assertEquals(a, e, msg) {
    assert(a === e, a === e ? msg : `${msg} — expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

const MANAGED = ['PRODUCT_TYPE', 'METRIC_MAPPINGS', 'DEFAULT_METRIC', 'MCP_METRIC', 'TOKEN_METRIC', 'MCP_ENABLED', 'AFORO_TENANT_ID'];
function load(env = {}) {
    delete require.cache[require.resolve('../index')];
    for (const k of MANAGED) delete process.env[k];
    Object.assign(process.env, env);
    return require('../index');
}

const le = { id: 'cw-1', timestamp: 1700000000000 };
function rec(over = {}) {
    return {
        aforoUsage: 1, requestId: 'req-1', httpMethod: 'POST', resourcePath: '/{proxy+}', path: '/v1/messages',
        status: 200, responseLatency: 42, responseLength: 300, stage: 'prod',
        customerId: 'cust-1', keyId: 'key-1', subscriptionId: 'sub-1', agentId: 'agent-1',
        requestHeaders: { 'x-trace-id': 'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1' },
        ...over,
    };
}

(async () => {
    console.log('\nAWS Lambda Aforo metering — AI_AGENT / MCP proxy records\n');

    console.log('Test M1: proxy records and Lambda-prefixed lines parse');
    let m = load();
    const line = JSON.stringify(rec({ sessionId: 's-1', sessionBoundary: 'SESSION_END', tokens: { input: 5, output: 6 } }));
    let p = m.parseAccessLog(line);
    assertEquals(p.isProxyRecord, true, 'aforoUsage record recognised');
    assertEquals(p.path, '/v1/messages', 'proxy record: real path used for mappings');
    assertEquals(p.resource, '/{proxy+}', 'resource template kept');
    assertEquals(p.agentId, 'agent-1', 'agentId carried');
    assertEquals(p.sessionId, 's-1', 'sessionId carried');
    assertEquals(p.sessionBoundary, 'SESSION_END', 'sessionBoundary carried');
    assertEquals(p.tokens.input, 5, 'tokens carried');
    p = m.parseAccessLog(`2026-10-21T10:00:00.000Z\tabc-123\tINFO\t${line}`);
    assert(p && p.isProxyRecord && p.customerId === 'cust-1', 'Lambda log prefix stripped');
    p = m.parseAccessLog(JSON.stringify({ timestamp: 'x', level: 'INFO', requestId: 'lambda-req', message: line }));
    assert(p && p.isProxyRecord && p.requestId === 'req-1', 'Lambda JSON log format wrapper unwrapped');
    assertEquals(m.parseAccessLog('REPORT RequestId: abc Duration: 3 ms'), null, 'REPORT line unparseable');
    const legacy = m.parseAccessLog(JSON.stringify({ requestId: 'r', httpMethod: 'GET', resourcePath: '/a/{id}', path: '/a/1', status: '200', customerId: 'c' }));
    assertEquals(legacy.path, '/a/{id}', 'access-log path precedence unchanged');
    assertEquals(legacy.isProxyRecord, false, 'access log is not a proxy record');

    console.log('\nTest M2: X-Ray Root= stripped from x-trace-id');
    assertEquals(m.stripXRayRoot('Root=1-5759e988-bd862e3f;Parent=53995c3f;Sampled=1'), '1-5759e988-bd862e3f', 'Root= value only');
    assertEquals(m.stripXRayRoot('  plain-id '), 'plain-id', 'plain id trimmed');
    const agentic = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec({ agentId: '' }))), le).event;
    assertEquals(agentic.productType, 'AGENTIC_API', 'API + x-trace-id → AGENTIC_API');
    assertEquals(agentic.traceId, '1-5759e988-bd862e3fe1be46a994272793', 'traceId has no Root= / Parent');

    console.log('\nTest M3: AI_AGENT call event + token event');
    m = load({ PRODUCT_TYPE: 'AI_AGENT', DEFAULT_METRIC: 'agent_calls' });
    let r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec({
        sessionId: 'sess-9', sessionBoundary: 'SESSION_END',
        tokens: { input: 250, output: 60, model: 'claude-sonnet-4-6', provider: 'anthropic' },
    }))), le);
    assertEquals(r.events.length, 2, 'two events');
    const [call, tok] = r.events;
    assertEquals(call.productType, 'AI_AGENT', 'call productType AI_AGENT');
    assertEquals(call.metricName, 'agent_calls', 'call metric from DEFAULT_METRIC');
    assertEquals(call.quantity, 1, 'call quantity 1');
    assertEquals(call.agentId, 'agent-1', 'agentId from record (authorizer)');
    assertEquals(call.sessionId, 'sess-9', 'sessionId from record');
    assertEquals(call.traceId, '1-5759e988-bd862e3fe1be46a994272793', 'traceId stripped');
    assertEquals(call.sessionBoundary, undefined, 'boundary moved off the call event when a token event follows');
    assertEquals(call.idempotencyKey, 'req-1', 'call key = requestId');
    assertEquals(call.subscriptionId, 'sub-1', 'subscriptionId carried');
    assertEquals(call.executionStatus, 'SUCCESS', 'executionStatus');
    assertEquals(tok.metricName, 'Tokens Consumed', 'token metric default');
    assertEquals(tok.quantity, 310, 'token quantity = input + output');
    assertEquals(tok.idempotencyKey, 'req-1:tokens', 'token key');
    assertEquals(tok.metadata.input_tokens, 250, 'metadata.input_tokens');
    assertEquals(tok.metadata.output_tokens, 60, 'metadata.output_tokens');
    assertEquals(tok.metadata.model_name, 'claude-sonnet-4-6', 'metadata.model_name');
    assertEquals(tok.metadata.model_provider, 'anthropic', 'metadata.model_provider');
    assertEquals(tok.productType, 'AI_AGENT', 'token event AI_AGENT');
    assertEquals(tok.sessionBoundary, 'SESSION_END', 'boundary on the token event (sent last), not duplicated');
    assertEquals(call.metadata.input_tokens, undefined, 'call event metadata untouched');

    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec({ sessionBoundary: 'SESSION_END' }))), le);
    assertEquals(r.events.length, 1, 'no tokens → one event (with boundary)');
    assertEquals(r.event.sessionBoundary, 'SESSION_END', 'boundary stays on the call event when there is no token event');

    // 2026-10-21 prod: AI_AGENT calls without a client trace produced no agentic_sessions row.
    const noTrace = { requestHeaders: {}, sessionId: 'sess-aws-1' };
    const a1 = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec(noTrace))), le).event;
    const a2 = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec({ ...noTrace, requestId: 'req-2' }))), le).event;
    assert(/^[0-9a-f]{32}$/.test(a1.traceId), 'no client trace → derived 32-hex traceId');
    assertEquals(a2.traceId, a1.traceId, 'same customer/agent/session → same traceId (one session row)');
    const a3 = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec({ ...noTrace, sessionId: 'sess-aws-2' }))), le).event;
    assert(a3.traceId !== a1.traceId, 'different session → different traceId');

    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec())), le);
    assertEquals(r.events.length, 1, 'no tokens → one event');
    assertEquals(r.event.sessionId, 'req-1', 'sessionId falls back to requestId');
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec({ tokens: { input: 0, output: 0 } }))), le);
    assertEquals(r.events.length, 1, 'zero tokens → no token event');
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec({ agentId: '', requestHeaders: { 'x-agent-id': 'forged' } }))), le);
    assert(r.skip && r.skip.includes('missing agentId'), 'no authorizer agentId → skipped with a clear reason (header ignored)');
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec({ sessionId: 'x'.repeat(200) }))), le);
    assertEquals(r.event.sessionId.length, 64, 'oversized sessionId hashed to 64 chars, not dropped');
    m = load({ PRODUCT_TYPE: 'AI_AGENT', TOKEN_METRIC: '' });
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec({ tokens: { input: 1, output: 1 } }))), le);
    assertEquals(r.events.length, 1, 'TOKEN_METRIC="" disables the token event');
    m = load({ PRODUCT_TYPE: 'AI_AGENT', TOKEN_METRIC: 'llm_tokens' });
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(rec({ tokens: { input: 1, output: 2 } }))), le);
    assertEquals(r.events[1].metricName, 'llm_tokens', 'TOKEN_METRIC configurable');

    console.log('\nTest M4: MCP from proxy records — metric from config, one event per tool call');
    m = load({ PRODUCT_TYPE: 'MCP_SERVER', MCP_METRIC: 'tool_calls' });
    const mcpRec = rec({ path: '/mcp', agentId: '', mcp: [{ toolName: 'search', agentId: 'meta-agent' }, { toolName: 'fetch', agentId: 'meta-agent' }] });
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(mcpRec)), le);
    assertEquals(r.events.length, 2, 'two tool calls → two events');
    assertEquals(r.events[0].metricName, 'tool_calls', 'MCP_METRIC used');
    assertEquals(r.events[0].toolName, 'search', 'toolName');
    assertEquals(r.events[1].toolName, 'fetch', 'second toolName');
    assertEquals(r.events[0].productType, 'MCP_SERVER', 'MCP_SERVER with toolName + agentId');
    assertEquals(r.events[0].agentId, 'meta-agent', 'agentId from mcp entry when authorizer had none');
    assertEquals(r.events[0].idempotencyKey, 'req-1:mcp:0', 'proxy MCP key');
    assertEquals(r.events[1].idempotencyKey, 'req-1:mcp:1', 'proxy MCP key index');
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify({ ...mcpRec, agentId: 'agent-jwt' })), le);
    assertEquals(r.events[0].agentId, 'agent-jwt', 'authorizer agentId wins');
    m = load({ METRIC_MAPPINGS: JSON.stringify([{ matchType: 'PREFIX', value: '/mcp', metricName: 'mapped_mcp' }]), MCP_METRIC: 'tool_calls' });
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(mcpRec)), le);
    assertEquals(r.events[0].metricName, 'mapped_mcp', 'METRIC_MAPPINGS wins over MCP_METRIC');
    m = load({ DEFAULT_METRIC: 'api_calls' });
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify(mcpRec)), le);
    assertEquals(r.events[0].metricName, 'api_calls', 'no MCP_METRIC → DEFAULT_METRIC (no hard-coded name)');

    console.log('\nTest M5: legacy access-log MCP detection keeps the frozen key, metric from config');
    m = load({ MCP_ENABLED: 'true', AFORO_TENANT_ID: 't1', MCP_METRIC: 'mcp_server.tool_invocations' });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', _meta: { agent_id: 'a1' } } });
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify({ requestId: 'r9', httpMethod: 'POST', resourcePath: '/mcp', status: '200', customerId: 'c', requestBody: body })), le);
    assertEquals(r.event.idempotencyKey, 'mcp:t1:r9:search:1700000000000', 'frozen legacy MCP key');
    assertEquals(r.event.metricName, 'mcp_server.tool_invocations', 'operator-set MCP_METRIC honoured');
    assertEquals(r.event.productType, 'MCP_SERVER', 'MCP_SERVER');
    m = load({ MCP_ENABLED: 'true' });
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify({ requestId: 'r9', httpMethod: 'POST', resourcePath: '/mcp', status: '200', customerId: 'c', requestBody: body })), le);
    assertEquals(r.event.metricName, 'api_calls', 'legacy MCP no longer hard-codes mcp_server.tool_invocations');

    console.log('\nTest M6: legacy API access-log lines unchanged');
    m = load();
    r = m.buildUsageEvent(m.parseAccessLog(JSON.stringify({ requestId: 'r1', httpMethod: 'GET', resourcePath: '/v1/x', status: '200', customerId: 'c', subscriptionId: 's' })), le);
    assertEquals(r.events.length, 1, 'one event');
    assertEquals(r.event.productType, 'API', 'API');
    assertEquals(r.event.metricName, 'api_calls', 'default metric');
    assertEquals(r.event.idempotencyKey, 'r1', 'key = requestId');
    assertEquals(r.event.agentId, undefined, 'no agent fields on API events');

    console.log('\nTest M7: end-to-end through the handler');
    m = load({ PRODUCT_TYPE: 'AI_AGENT' });
    const messages = [
        `2026-10-21T10:00:00.000Z\tlam-1\tINFO\t${JSON.stringify(rec({ requestId: 'e2e-1', tokens: { input: 10, output: 5, model: 'm', provider: 'p' } }))}`,
        'START RequestId: lam-1 Version: $LATEST',
        JSON.stringify(rec({ requestId: 'e2e-2' })),
    ];
    const payload = zlib.gzipSync(JSON.stringify({
        messageType: 'DATA_MESSAGE', logGroup: '/aws/lambda/aforo-metering-proxy',
        logEvents: messages.map((message, i) => ({ id: `ev-${i}`, timestamp: 1700000000000 + i, message })),
    })).toString('base64');
    const origLog = console.log;
    console.log = () => {};
    await m.handler({ awslogs: { data: payload } }, { getRemainingTimeInMillis: () => 30000 });
    console.log = origLog;
    const events = posted.flatMap((b) => b.events);
    assertEquals(events.length, 3, 'call + tokens + call');
    assertEquals(events.map((e) => e.idempotencyKey).join(','), 'e2e-1,e2e-1:tokens,e2e-2', 'keys');
    assert(events.every((e) => e.productType === 'AI_AGENT' && e.agentId === 'agent-1'), 'all AI_AGENT with agentId');

    for (const k of MANAGED) delete process.env[k];
    console.log('\n── Results: ' + passed + ' passed, ' + failed + ' failed ──\n');
    process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error('  FAIL: tests threw', err); process.exit(1); });
