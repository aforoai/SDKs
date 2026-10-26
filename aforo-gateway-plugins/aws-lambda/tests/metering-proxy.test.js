/**
 * Tests for metering-proxy.js.
 * Run with: node tests/metering-proxy.test.js
 *
 * A local HTTP server plays the upstream; process.stdout.write is captured
 * to read the usage record.
 */
'use strict';

const http = require('http');

const seen = [];
let mode = 'json';
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (mode === 'slow') return setTimeout(() => { try { res.end('late'); } catch { /* closed */ } }, 1500);
        if (mode === 'anthropic') {
            res.writeHead(200, { 'content-type': 'application/json', 'x-aforo-session-id': 'sess-up' });
            return res.end(JSON.stringify({ id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 250, output_tokens: 60 }, content: [{ type: 'text', text: 'SECRET-RESPONSE' }] }));
        }
        if (mode === 'openai') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ id: 'cmpl', model: 'gpt-4o', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
        }
        if (mode === 'headers') {
            res.writeHead(201, { 'content-type': 'text/plain', 'x-aforo-input-tokens': '100', 'x-aforo-output-tokens': '20',
                'x-aforo-model': 'claude-haiku-4-5', 'x-aforo-model-provider': 'anthropic', 'x-aforo-session-end': 'true', 'x-custom': 'yes' });
            return res.end('plain text');
        }
        if (mode === 'binary') {
            res.writeHead(200, { 'content-type': 'image/png' });
            return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'ok' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }));
    });
});

let passed = 0;
let failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  PASS: ' + msg); } else { failed++; console.error('  FAIL: ' + msg); } }
function assertEquals(a, e, msg) {
    assert(a === e, a === e ? msg : `${msg} — expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

function event(over = {}) {
    return {
        resource: '/{proxy+}',
        path: '/mcp',
        httpMethod: 'POST',
        headers: {
            Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.SECRET-TOKEN.sig',
            'Content-Type': 'application/json',
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            'X-Session-Id': 'sess-1',
            'X-Aforo-Customer-Id': 'forged',
        },
        multiValueHeaders: null,
        queryStringParameters: { a: '1' },
        multiValueQueryStringParameters: null,
        requestContext: {
            requestId: 'req-123', stage: 'prod', resourcePath: '/{proxy+}', httpMethod: 'POST',
            authorizer: { customerId: 'cust-1', keyId: 'key-1', subscriptionId: 'sub-1', agentId: '', principalId: 'cust-1' },
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { q: 'SECRET-BODY' }, _meta: { agent_id: 'agent-meta' } } }),
        isBase64Encoded: false,
        ...over,
    };
}

async function capture(fn) {
    const lines = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };
    try {
        const result = await fn();
        return { result, lines };
    } finally {
        process.stdout.write = orig;
    }
}

async function run() {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.UPSTREAM_URL = `http://127.0.0.1:${server.address().port}/base/`;
    process.env.UPSTREAM_TIMEOUT_MS = '500';
    const proxy = require('../metering-proxy');
    console.log('\nAWS Lambda Aforo metering proxy — Tests\n');

    console.log('Test P1: forwards to upstream and returns its response unchanged');
    mode = 'json';
    let { result, lines } = await capture(() => proxy.handler(event()));
    assertEquals(result.statusCode, 200, 'status passed through');
    assertEquals(result.headers['x-upstream'], 'ok', 'upstream header passed through');
    assertEquals(JSON.parse(result.body).result !== undefined, true, 'body passed through');
    assertEquals(result.isBase64Encoded, false, 'JSON body not base64');
    const up = seen[seen.length - 1];
    assertEquals(up.url, '/base/mcp?a=1', 'path appended to base, query forwarded');
    assertEquals(up.method, 'POST', 'method forwarded');
    assert(up.body.includes('tools/call'), 'body forwarded');
    assertEquals(up.headers.authorization, undefined, 'Authorization stripped by default');
    assertEquals(up.headers['x-aforo-customer-id'], 'cust-1', 'X-Aforo-Customer-Id from authorizer (client value replaced)');
    assertEquals(up.headers['x-aforo-agent-id'], undefined, 'no X-Aforo-Agent-Id when authorizer has none');
    assertEquals(up.headers.traceparent, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', 'other headers forwarded');

    console.log('\nTest P2: exactly one record; MCP tool call extracted; no secrets');
    assertEquals(lines.length, 1, 'exactly one stdout write');
    const rec = JSON.parse(lines[0]);
    assert(lines[0].endsWith('\n'), 'newline-terminated');
    assertEquals(rec.aforoUsage, 1, 'aforoUsage marker');
    assertEquals(rec.requestId, 'req-123', 'requestId');
    assertEquals(rec.httpMethod, 'POST', 'httpMethod');
    assertEquals(rec.path, '/mcp', 'path');
    assertEquals(rec.resourcePath, '/{proxy+}', 'resourcePath');
    assertEquals(rec.status, 200, 'status');
    assert(Number.isInteger(rec.responseLatency) && rec.responseLatency >= 0, 'responseLatency measured');
    assert(rec.responseLength > 0, 'responseLength');
    assertEquals(rec.stage, 'prod', 'stage');
    assertEquals(rec.customerId, 'cust-1', 'customerId from authorizer');
    assertEquals(rec.keyId, 'key-1', 'keyId');
    assertEquals(rec.subscriptionId, 'sub-1', 'subscriptionId');
    assertEquals(rec.agentId, '', 'agentId empty (authorizer had none)');
    assertEquals(rec.requestHeaders['x-session-id'], 'sess-1', 'x-session-id lower-cased into requestHeaders');
    assertEquals(rec.sessionId, 'sess-1', 'sessionId from request header');
    assertEquals(rec.mcp.length, 1, 'one MCP entry');
    assertEquals(rec.mcp[0].toolName, 'search', 'toolName');
    assertEquals(rec.mcp[0].agentId, 'agent-meta', '_meta.agent_id used when authorizer agentId empty');
    assertEquals(rec.tokens, undefined, 'no tokens for a JSON-RPC result');
    assert(!/SECRET|authorization|Bearer/i.test(lines[0]), 'no body, token or Authorization in the record');

    console.log('\nTest P3: batch tools/call; authorizer agentId wins');
    const batch = JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a', _meta: { agent_id: 'm' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'b' } },
    ]);
    ({ lines } = await capture(() => proxy.handler(event({
        body: Buffer.from(batch).toString('base64'), isBase64Encoded: true,
        requestContext: { ...event().requestContext, authorizer: { customerId: 'cust-1', agentId: 'agent-jwt' } },
    }))));
    let r = JSON.parse(lines[0]);
    assertEquals(r.mcp.length, 2, 'one entry per tools/call in a batch');
    assertEquals(r.mcp.map(m => m.toolName).join(','), 'a,b', 'tool names in order');
    assert(r.mcp.every(m => m.agentId === 'agent-jwt'), 'authorizer agentId wins over _meta');
    assertEquals(r.agentId, 'agent-jwt', 'record agentId from authorizer');
    assertEquals(seen[seen.length - 1].headers['x-aforo-agent-id'], 'agent-jwt', 'X-Aforo-Agent-Id sent upstream');

    console.log('\nTest P4: tokens from an Anthropic body; session id from upstream header');
    mode = 'anthropic';
    ({ result, lines } = await capture(() => proxy.handler(event({
        path: '/v1/messages', body: JSON.stringify({ prompt: 'SECRET-BODY' }),
        headers: { 'content-type': 'application/json' },
    }))));
    r = JSON.parse(lines[0]);
    assertEquals(r.tokens.input, 250, 'input_tokens');
    assertEquals(r.tokens.output, 60, 'output_tokens');
    assertEquals(r.tokens.model, 'claude-sonnet-4-6', 'model from body');
    assertEquals(r.tokens.provider, 'anthropic', 'provider inferred');
    assertEquals(r.sessionId, 'sess-up', 'sessionId from x-aforo-session-id when client sent none');
    assertEquals(r.mcp, undefined, 'no mcp for a non-JSON-RPC body');
    assert(result.body.includes('SECRET-RESPONSE') && !lines[0].includes('SECRET'), 'client gets the body, record does not');

    console.log('\nTest P5: tokens from an OpenAI body');
    mode = 'openai';
    ({ lines } = await capture(() => proxy.handler(event({ body: '{}' }))));
    r = JSON.parse(lines[0]);
    assertEquals(r.tokens.input, 11, 'prompt_tokens');
    assertEquals(r.tokens.output, 7, 'completion_tokens');
    assertEquals(r.tokens.model, 'gpt-4o', 'model');
    assertEquals(r.tokens.provider, 'openai', 'provider openai');

    console.log('\nTest P6: tokens from x-aforo-* headers; session end; non-JSON body');
    mode = 'headers';
    ({ result, lines } = await capture(() => proxy.handler(event({ body: 'not json {' }))));
    r = JSON.parse(lines[0]);
    assertEquals(result.statusCode, 201, 'status 201 passed through');
    assertEquals(result.body, 'plain text', 'text body passed through');
    assertEquals(result.headers['x-custom'], 'yes', 'custom header passed through');
    assertEquals(r.tokens.input, 100, 'header input');
    assertEquals(r.tokens.output, 20, 'header output');
    assertEquals(r.tokens.model, 'claude-haiku-4-5', 'header model');
    assertEquals(r.tokens.provider, 'anthropic', 'header provider');
    assertEquals(r.sessionBoundary, 'SESSION_END', 'x-aforo-session-end → SESSION_END');
    assertEquals(r.mcp, undefined, 'unparseable body → no mcp, response unaffected');

    console.log('\nTest P7: request x-session-end; binary response base64');
    mode = 'binary';
    ({ result, lines } = await capture(() => proxy.handler(event({ httpMethod: 'GET', body: null, headers: { 'x-session-end': 'true' } }))));
    r = JSON.parse(lines[0]);
    assertEquals(result.isBase64Encoded, true, 'binary body base64-encoded');
    assertEquals(Buffer.from(result.body, 'base64').length, 6, 'binary bytes intact');
    assertEquals(r.sessionBoundary, 'SESSION_END', 'x-session-end request header → SESSION_END');
    assertEquals(r.responseLength, 6, 'responseLength in bytes');

    console.log('\nTest P8: upstream timeout → 502, recorded as 502');
    mode = 'slow';
    const origErr = console.error;
    console.error = () => {};
    ({ result, lines } = await capture(() => proxy.handler(event())));
    console.error = origErr;
    assertEquals(result.statusCode, 502, '502 to client');
    assertEquals(lines.length, 1, 'still exactly one record');
    assertEquals(JSON.parse(lines[0]).status, 502, 'record status 502');

    console.log('\nTest P9: UPSTREAM_FORWARD_AUTH=true forwards Authorization');
    mode = 'json';
    delete require.cache[require.resolve('../metering-proxy')];
    process.env.UPSTREAM_FORWARD_AUTH = 'true';
    const fwd = require('../metering-proxy');
    delete process.env.UPSTREAM_FORWARD_AUTH;
    await capture(() => fwd.handler(event()));
    assert(String(seen[seen.length - 1].headers.authorization).startsWith('Bearer '), 'Authorization forwarded when enabled');

    console.log('\nTest P10: UPSTREAM_FUNCTION invokes a Lambda with the proxy event');
    delete require.cache[require.resolve('../metering-proxy')];
    delete process.env.UPSTREAM_URL;
    process.env.UPSTREAM_FUNCTION = 'arn:aws:lambda:us-east-1:123:function:demo';
    const lp = require('../metering-proxy');
    class FakeInvoke { constructor(input) { this.input = input; } }
    const invoked = [];
    lp._setLambdaClient({
        send: async (cmd) => {
            invoked.push(JSON.parse(Buffer.from(cmd.input.Payload).toString('utf8')));
            return { StatusCode: 200, Payload: Buffer.from(JSON.stringify({
                statusCode: 200, headers: { 'content-type': 'application/json', 'x-aforo-input-tokens': '5', 'x-aforo-output-tokens': '3' },
                body: JSON.stringify({ ok: true }),
            })) };
        },
    }, FakeInvoke);
    ({ result, lines } = await capture(() => lp.handler(event())));
    assertEquals(result.statusCode, 200, 'Lambda upstream status');
    assertEquals(result.body, '{"ok":true}', 'Lambda upstream body');
    assertEquals(invoked[0].path, '/mcp', 'original event passed');
    assertEquals(invoked[0].headers.authorization, undefined, 'Authorization stripped from the invoked event');
    assertEquals(invoked[0].headers['x-aforo-customer-id'], 'cust-1', 'x-aforo-customer-id added');
    r = JSON.parse(lines[0]);
    assertEquals(r.tokens.input + r.tokens.output, 8, 'tokens from the Lambda response headers');
    lp._setLambdaClient({ send: async () => ({ FunctionError: 'Unhandled', Payload: Buffer.from('{}') }) }, FakeInvoke);
    console.error = () => {};
    ({ result, lines } = await capture(() => lp.handler(event())));
    console.error = origErr;
    assertEquals(result.statusCode, 502, 'function error → 502');
    assertEquals(JSON.parse(lines[0]).status, 502, 'recorded as 502');

    console.log('\nTest P11: examples/demo-upstream.js behind the proxy');
    const demo = require('../examples/demo-upstream');
    lp._setLambdaClient({
        send: async (cmd) => ({ StatusCode: 200, Payload: Buffer.from(JSON.stringify(
            await demo.handler(JSON.parse(Buffer.from(cmd.input.Payload).toString('utf8'))))) }),
    }, FakeInvoke);
    ({ result, lines } = await capture(() => lp.handler(event({
        path: '/v1/messages', body: JSON.stringify({ input_tokens: 40, output_tokens: 9 }),
        headers: { 'x-session-id': 'demo-s', 'x-session-end': 'true' },
    }))));
    r = JSON.parse(lines[0]);
    assertEquals(JSON.parse(result.body).model, 'claude-sonnet-4-6', 'demo answers an Anthropic-like body');
    assertEquals(r.tokens.input, 40, 'demo input tokens from the request body');
    assertEquals(r.tokens.output, 9, 'demo output tokens from the request body');
    assertEquals(r.sessionId, 'demo-s', 'session id');
    assertEquals(r.sessionBoundary, 'SESSION_END', 'session end');
    ({ result, lines } = await capture(() => lp.handler(event())));
    r = JSON.parse(lines[0]);
    assertEquals(JSON.parse(result.body).result.isError, false, 'demo answers tools/call with a JSON-RPC result');
    assertEquals(r.mcp[0].toolName, 'search', 'tool call recorded');
    assertEquals(r.tokens, undefined, 'no tokens for a tool call');
    delete process.env.UPSTREAM_FUNCTION;
}

run().catch((err) => { failed++; console.error('  FAIL: tests threw', err); })
    .finally(() => {
        server.closeAllConnections && server.closeAllConnections();
        server.close();
        console.log('\n── Results: ' + passed + ' passed, ' + failed + ' failed ──\n');
        process.exit(failed > 0 ? 1 : 0);
    });
