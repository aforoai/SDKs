/**
 * Demo upstream for aforo-metering-proxy (UPSTREAM_FUNCTION). Handler:
 * demo-upstream.handler. Answers in API Gateway proxy-response shape.
 *
 *   POST JSON-RPC tools/call (single or batch) → JSON-RPC result(s)
 *   any other POST → Anthropic-like message with usage.input_tokens /
 *                    output_tokens (from the request body's input_tokens /
 *                    output_tokens, else 250 / 60)
 *   anything else  → {"ok":true}
 *
 * Echoes x-session-id as x-aforo-session-id, and sets x-aforo-session-end:
 * true when the request carried x-session-end: true.
 */
'use strict';

const crypto = require('crypto');

function header(event, name) {
    for (const [k, v] of Object.entries((event && event.headers) || {})) if (k.toLowerCase() === name) return v;
    return undefined;
}

function count(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

exports.handler = async (event) => {
    const headers = { 'content-type': 'application/json' };
    const sessionId = header(event, 'x-session-id');
    if (sessionId) headers['x-aforo-session-id'] = String(sessionId);
    if (String(header(event, 'x-session-end') || '').toLowerCase() === 'true') headers['x-aforo-session-end'] = 'true';

    let body = null;
    if (event && event.body) {
        try {
            body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
        } catch { body = null; }
    }
    const method = String((event && event.httpMethod) || 'GET').toUpperCase();

    const isCall = (m) => m && m.jsonrpc === '2.0' && m.method === 'tools/call';
    const rpcResult = (m) => ({
        jsonrpc: '2.0', id: m.id === undefined ? null : m.id,
        result: { content: [{ type: 'text', text: `demo result for ${(m.params && m.params.name) || 'tool'}` }], isError: false },
    });
    if (method === 'POST' && (isCall(body) || (Array.isArray(body) && body.some(isCall)))) {
        const out = Array.isArray(body) ? body.filter(isCall).map(rpcResult) : rpcResult(body);
        return { statusCode: 200, headers, body: JSON.stringify(out), isBase64Encoded: false };
    }
    if (method === 'POST') {
        const b = body && typeof body === 'object' ? body : {};
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-6',
                content: [{ type: 'text', text: 'Hello from the Aforo demo upstream.' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: count(b.input_tokens, 250), output_tokens: count(b.output_tokens, 60) },
            }),
            isBase64Encoded: false,
        };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }), isBase64Encoded: false };
};
