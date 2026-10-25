/**
 * Aforo metering proxy — AWS API Gateway (REST API, Lambda proxy integration).
 *
 * API Gateway access logs carry neither request bodies nor response headers,
 * so they cannot see an MCP JSON-RPC tool name or the tokens an AI agent
 * consumed. This Lambda sits between API Gateway and the provider's upstream:
 * it forwards each call, returns the upstream's answer to the client
 * unchanged, and writes ONE usage record per call to its own log stream. A
 * CloudWatch Logs subscription filter delivers those records to the
 * aforo-metering Lambda (index.js), which turns them into usage events.
 *
 *   client ─► API Gateway (Aforo authorizer) ─► aforo-metering-proxy ─► upstream
 *                                                       │
 *                                                       └─ stdout: {"aforoUsage":1,...} ─► aforo-metering
 *
 * Upstream (one of):
 *   UPSTREAM_URL          HTTP(S) base URL. The request path is appended, and
 *                         method, query, headers and body are forwarded.
 *   UPSTREAM_FUNCTION     Lambda name/ARN, invoked synchronously with the API
 *                         Gateway proxy event; must answer an API Gateway
 *                         proxy response ({statusCode, headers, body}).
 *
 * Env:
 *   UPSTREAM_TIMEOUT_MS   default 25000 (API Gateway's own limit is 29s).
 *   UPSTREAM_FORWARD_AUTH "true" forwards the client's Authorization header;
 *                         by default it is stripped (it is an Aforo
 *                         credential, not the upstream's).
 *
 * The upstream receives X-Aforo-Customer-Id / X-Aforo-Agent-Id from the
 * authorizer context (client-sent X-Aforo-* headers are removed first).
 *
 * Identity in the record comes ONLY from event.requestContext.authorizer (set
 * by key-authorizer.js from a verified credential). Request and response
 * bodies and the Authorization header are never logged; bodies are parsed in
 * memory for the tool name / token counts only, and a parse failure never
 * changes the client's response. An upstream error or timeout answers 502
 * (recorded as status 502).
 *
 * Upstream contract for token metering: either response headers
 *   x-aforo-input-tokens, x-aforo-output-tokens, x-aforo-model,
 *   x-aforo-model-provider
 * or a JSON body with usage.input_tokens/output_tokens (Anthropic) or
 * usage.prompt_tokens/completion_tokens (OpenAI) and `model`. Session hints:
 *   x-aforo-session-id (response) — used when the client sent no x-session-id
 *   x-aforo-session-end: true (response) or x-session-end: true (request)
 */
'use strict';

const UPSTREAM_URL = (process.env.UPSTREAM_URL || '').trim();
const UPSTREAM_FUNCTION = (process.env.UPSTREAM_FUNCTION || '').trim();
const UPSTREAM_TIMEOUT_MS = positiveInt(process.env.UPSTREAM_TIMEOUT_MS, 25000);
const UPSTREAM_FORWARD_AUTH = String(process.env.UPSTREAM_FORWARD_AUTH || '').trim().toLowerCase() === 'true';

// Bodies larger than this are forwarded but not inspected.
const MAX_INSPECT_BYTES = 1024 * 1024;
const MAX_MCP_ENTRIES = 100;
const MAX_HEADER_VALUE = 256;

const TRACE_HEADERS = ['traceparent', 'tracestate', 'x-trace-id', 'x-request-id', 'x-session-id'];
// Hop-by-hop and transport headers that must not be copied across a proxy.
const HOP_HEADERS = new Set([
    'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'content-length', 'expect',
]);
const RESPONSE_DROP_HEADERS = new Set([...HOP_HEADERS, 'content-encoding']);

function positiveInt(raw, fallback) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function capString(v, max = MAX_HEADER_VALUE) {
    if (v === undefined || v === null) return '';
    return String(v).slice(0, max);
}

/** Lower-cased header map (first value wins) from a v1 proxy event. */
function lowerHeaders(event) {
    const out = {};
    const mv = event.multiValueHeaders || {};
    for (const [k, vs] of Object.entries(mv)) {
        if (Array.isArray(vs) && vs.length) out[k.toLowerCase()] = String(vs[0]);
    }
    for (const [k, v] of Object.entries(event.headers || {})) {
        if (v !== undefined && v !== null && out[k.toLowerCase()] === undefined) out[k.toLowerCase()] = String(v);
    }
    return out;
}

function authorizerContext(event) {
    const a = (event.requestContext && event.requestContext.authorizer) || {};
    const s = (v) => (v === undefined || v === null ? '' : String(v).trim());
    return {
        customerId: s(a.customerId),
        keyId: s(a.keyId),
        subscriptionId: s(a.subscriptionId),
        agentId: s(a.agentId),
    };
}

function requestBodyBuffer(event) {
    if (event.body === undefined || event.body === null) return null;
    return event.isBase64Encoded ? Buffer.from(String(event.body), 'base64') : Buffer.from(String(event.body), 'utf8');
}

/** Headers to send upstream: hop-by-hop, client X-Aforo-* and (by default) Authorization removed. */
function upstreamHeaders(event, auth) {
    const out = {};
    const add = (k, v) => {
        const lk = k.toLowerCase();
        if (HOP_HEADERS.has(lk) || lk.startsWith('x-aforo-')) return;
        if (lk === 'authorization' && !UPSTREAM_FORWARD_AUTH) return;
        out[lk] = out[lk] === undefined ? String(v) : `${out[lk]}, ${v}`;
    };
    const mv = event.multiValueHeaders;
    if (mv && Object.keys(mv).length) {
        for (const [k, vs] of Object.entries(mv)) for (const v of (Array.isArray(vs) ? vs : [vs])) add(k, v);
    } else {
        for (const [k, v] of Object.entries(event.headers || {})) if (v !== undefined && v !== null) add(k, v);
    }
    if (auth.customerId) out['x-aforo-customer-id'] = auth.customerId;
    if (auth.agentId) out['x-aforo-agent-id'] = auth.agentId;
    return out;
}

function upstreamUrl(event) {
    const base = UPSTREAM_URL.replace(/\/+$/, '');
    const url = new URL(base + (event.path || '/'));
    const mvq = event.multiValueQueryStringParameters;
    if (mvq && Object.keys(mvq).length) {
        for (const [k, vs] of Object.entries(mvq)) for (const v of (Array.isArray(vs) ? vs : [vs])) url.searchParams.append(k, v);
    } else {
        for (const [k, v] of Object.entries(event.queryStringParameters || {})) url.searchParams.append(k, v);
    }
    return url.toString();
}

function isTextContentType(ct) {
    const c = String(ct || '').toLowerCase();
    return c.startsWith('text/') || c.includes('json') || c.includes('xml') || c.includes('javascript')
        || c.includes('x-www-form-urlencoded') || c.includes('event-stream');
}

/** Forward over HTTP(S). Resolves to { statusCode, headers, multiValueHeaders, body, isBase64Encoded, bodyBuffer }. */
async function forwardHttp(event, auth) {
    const method = (event.httpMethod || 'GET').toUpperCase();
    const body = requestBodyBuffer(event);
    const res = await fetch(upstreamUrl(event), {
        method,
        headers: upstreamHeaders(event, auth),
        body: method === 'GET' || method === 'HEAD' ? undefined : (body || undefined),
        redirect: 'manual',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const headers = {};
    const multiValueHeaders = {};
    res.headers.forEach((v, k) => {
        if (RESPONSE_DROP_HEADERS.has(k) || k === 'set-cookie') return;
        headers[k] = v;
    });
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (cookies.length) multiValueHeaders['set-cookie'] = cookies;
    const text = isTextContentType(res.headers.get('content-type')) || buf.length === 0;
    const out = {
        statusCode: res.status,
        headers,
        body: text ? buf.toString('utf8') : buf.toString('base64'),
        isBase64Encoded: !text,
    };
    if (cookies.length) out.multiValueHeaders = multiValueHeaders;
    return { response: out, bodyBuffer: buf };
}

let lambdaClient = null;
function getLambdaClient() {
    if (!lambdaClient) {
        // Bundled with the nodejs18.x+ Lambda runtimes; loaded only when used.
        const { LambdaClient } = require('@aws-sdk/client-lambda');
        lambdaClient = new LambdaClient({});
    }
    return lambdaClient;
}

/** Invoke a Lambda upstream with the (sanitised) proxy event. */
async function forwardLambda(event, auth) {
    const { InvokeCommand } = lambdaClient && lambdaClient.__InvokeCommand
        ? { InvokeCommand: lambdaClient.__InvokeCommand }
        : require('@aws-sdk/client-lambda');
    const headers = upstreamHeaders({ ...event, multiValueHeaders: null }, auth);
    const multiValueHeaders = {};
    for (const [k, v] of Object.entries(headers)) multiValueHeaders[k] = [v];
    const payload = { ...event, headers, multiValueHeaders };
    const out = await getLambdaClient().send(
        new InvokeCommand({ FunctionName: UPSTREAM_FUNCTION, Payload: Buffer.from(JSON.stringify(payload)) }),
        { abortSignal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
    );
    if (out.FunctionError) throw new Error(`upstream function error: ${out.FunctionError}`);
    const res = JSON.parse(Buffer.from(out.Payload || []).toString('utf8') || 'null');
    if (!res || typeof res !== 'object' || !Number.isInteger(Number(res.statusCode))) {
        throw new Error('upstream function did not return an API Gateway proxy response');
    }
    const body = res.body === undefined || res.body === null ? '' : String(res.body);
    const response = { statusCode: Number(res.statusCode), headers: res.headers || {}, body, isBase64Encoded: !!res.isBase64Encoded };
    if (res.multiValueHeaders) response.multiValueHeaders = res.multiValueHeaders;
    const bodyBuffer = response.isBase64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
    return { response, bodyBuffer };
}

function responseHeader(response, name) {
    for (const [k, v] of Object.entries(response.headers || {})) if (k.toLowerCase() === name) return String(v);
    for (const [k, v] of Object.entries(response.multiValueHeaders || {})) {
        if (k.toLowerCase() === name && Array.isArray(v) && v.length) return String(v[0]);
    }
    return undefined;
}

function parseJson(buf) {
    if (!buf || buf.length === 0 || buf.length > MAX_INSPECT_BYTES) return null;
    try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

/** One {toolName, agentId} per JSON-RPC tools/call (single or batch); [] when none. */
function extractMcpCalls(body) {
    const msgs = Array.isArray(body) ? body : (body && typeof body === 'object' ? [body] : []);
    const out = [];
    for (const m of msgs) {
        if (out.length >= MAX_MCP_ENTRIES) break;
        if (!m || m.jsonrpc !== '2.0' || m.method !== 'tools/call') continue;
        const params = m.params && typeof m.params === 'object' ? m.params : {};
        if (typeof params.name !== 'string' || !params.name) continue;
        const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
        out.push({
            toolName: capString(params.name, 128),
            agentId: typeof meta.agent_id === 'string' ? capString(meta.agent_id, 128) : '',
        });
    }
    return out;
}

function toCount(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Token usage from x-aforo-* response headers, else an Anthropic/OpenAI JSON body; null when none. */
function extractTokens(response, bodyJson) {
    const hIn = toCount(responseHeader(response, 'x-aforo-input-tokens'));
    const hOut = toCount(responseHeader(response, 'x-aforo-output-tokens'));
    if (hIn !== null || hOut !== null) {
        return {
            input: hIn || 0,
            output: hOut || 0,
            model: capString(responseHeader(response, 'x-aforo-model') || (bodyJson && bodyJson.model) || '', 128),
            provider: capString(responseHeader(response, 'x-aforo-model-provider') || '', 64),
        };
    }
    const usage = bodyJson && typeof bodyJson === 'object' && bodyJson.usage && typeof bodyJson.usage === 'object'
        ? bodyJson.usage : null;
    if (!usage) return null;
    let input = null;
    let output = null;
    let provider = '';
    if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
        input = toCount(usage.input_tokens); output = toCount(usage.output_tokens); provider = 'anthropic';
    } else if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) {
        input = toCount(usage.prompt_tokens); output = toCount(usage.completion_tokens); provider = 'openai';
    }
    if (input === null && output === null) return null;
    return {
        input: input || 0,
        output: output || 0,
        model: capString(typeof bodyJson.model === 'string' ? bodyJson.model : '', 128),
        provider: capString(responseHeader(response, 'x-aforo-model-provider') || provider, 64),
    };
}

function isTrue(v) {
    return typeof v === 'string' && v.trim().toLowerCase() === 'true';
}

/** The usage record for one call. Never includes bodies or Authorization. */
function buildRecord(event, auth, reqHeaders, response, bodyBuffer, latencyMs, reqBodyJson) {
    const rc = event.requestContext || {};
    const rec = {
        aforoUsage: 1,
        requestId: rc.requestId || '',
        httpMethod: event.httpMethod || rc.httpMethod || '',
        resourcePath: rc.resourcePath || event.resource || '',
        path: event.path || rc.path || '',
        status: response.statusCode,
        responseLatency: latencyMs,
        responseLength: bodyBuffer ? bodyBuffer.length : 0,
        stage: rc.stage || '',
        customerId: auth.customerId,
        keyId: auth.keyId,
        subscriptionId: auth.subscriptionId,
        agentId: auth.agentId,
        requestHeaders: {},
    };
    for (const h of TRACE_HEADERS) if (reqHeaders[h] !== undefined) rec.requestHeaders[h] = capString(reqHeaders[h]);

    try {
        const sessionId = reqHeaders['x-session-id'] || responseHeader(response, 'x-aforo-session-id');
        if (sessionId) rec.sessionId = capString(sessionId);
        if (isTrue(responseHeader(response, 'x-aforo-session-end')) || isTrue(reqHeaders['x-session-end'])) {
            rec.sessionBoundary = 'SESSION_END';
        }
        const calls = extractMcpCalls(reqBodyJson);
        if (calls.length) {
            // A verified agent id (authorizer) always wins over params._meta.
            rec.mcp = calls.map((c) => ({ toolName: c.toolName, agentId: auth.agentId || c.agentId }));
        }
        const ct = responseHeader(response, 'content-type') || '';
        const bodyJson = ct.toLowerCase().includes('json') || !ct ? parseJson(bodyBuffer) : null;
        const tokens = extractTokens(response, bodyJson);
        if (tokens) rec.tokens = tokens;
    } catch (err) {
        console.warn(`[aforo-metering-proxy] usage enrichment skipped: ${err.message}`);
    }
    return rec;
}

function writeRecord(rec) {
    // Raw stdout (not console.log) so the line has no Lambda prefix and the
    // subscription filter / metering Lambda read it as plain JSON.
    process.stdout.write(JSON.stringify(rec) + '\n');
}

const BAD_GATEWAY = {
    statusCode: 502,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Bad Gateway' }),
    isBase64Encoded: false,
};

async function handler(event) {
    event = event || {};
    const started = Date.now();
    const auth = authorizerContext(event);
    const reqHeaders = lowerHeaders(event);

    let response;
    let bodyBuffer = null;
    try {
        if (!UPSTREAM_URL && !UPSTREAM_FUNCTION) throw new Error('neither UPSTREAM_URL nor UPSTREAM_FUNCTION is set');
        const out = UPSTREAM_URL ? await forwardHttp(event, auth) : await forwardLambda(event, auth);
        response = out.response;
        bodyBuffer = out.bodyBuffer;
    } catch (err) {
        console.error(`[aforo-metering-proxy] upstream failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
        response = BAD_GATEWAY;
        bodyBuffer = Buffer.from(BAD_GATEWAY.body);
    }
    const latency = Date.now() - started;

    try {
        let reqBodyJson = null;
        if ((event.httpMethod || '').toUpperCase() === 'POST') {
            try { reqBodyJson = parseJson(requestBodyBuffer(event)); } catch { reqBodyJson = null; }
        }
        writeRecord(buildRecord(event, auth, reqHeaders, response, bodyBuffer, latency, reqBodyJson));
    } catch (err) {
        console.error(`[aforo-metering-proxy] could not write the usage record: ${err.message}`);
    }
    return response;
}

module.exports = {
    handler,
    extractMcpCalls,
    extractTokens,
    buildRecord,
    upstreamHeaders,
    upstreamUrl,
    _setLambdaClient: (client, InvokeCommand) => {
        lambdaClient = client;
        if (client && InvokeCommand) client.__InvokeCommand = InvokeCommand;
    },
};
