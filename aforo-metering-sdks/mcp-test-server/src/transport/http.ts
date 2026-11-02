// HTTP transport — plain JSON-RPC 2.0 over HTTP.
//
// One endpoint: POST /mcp with the JSON-RPC request as the body, response
// echoes the JSON-RPC envelope. This is the shape gateway plugins expect
// (Kong handler.lua detect_mcp_tool_call, AWS Lambda detectMcpToolCall,
// Azure APIM <when>, Apigee callout, MuleSoft DataWeave — all read
// tools/call out of the POST body).
//
// Also provides GET /health returning "ok" for docker HEALTHCHECK.
//
// Production-hardening (2026-07-11 self-review):
//   - Returns Promise<http.Server> that resolves on 'listening' so
//     consumers can't hit the address()-returns-null race.
//   - Body capped at MAX_BODY_BYTES (default 1 MiB) — connection is
//     closed with a 413 ParseError envelope on oversize.
//   - JSON-RPC batches (top-level array) explicitly rejected with
//     -32600 per MCP spec 2024-11-05 which forbids batches.

import http from 'node:http';
import { McpTestServer } from '../server.js';
import { JsonRpcErrorCode, type JsonRpcRequest } from '../types.js';

export interface HttpTransportOptions {
  port: number;
  host?: string;
  server: McpTestServer;
  /** Echo request/response envelopes to stderr for CI debugging. */
  verbose?: boolean;
  /** Max request body size in bytes. Defaults to 1 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 1 << 20;

export function startHttp(opts: HttpTransportOptions): Promise<http.Server> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

  const httpServer = http.createServer(async (req, res) => {
    // Swallow response 'error' events (e.g. client hung up) so they don't
    // crash the process. The default emitter would otherwise turn into an
    // uncaughtException.
    res.on('error', () => { /* client disconnected — ignore */ });

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, maxBodyBytes);
    } catch (err) {
      const code = err instanceof BodyTooLargeError ? 413 : 400;
      const message = err instanceof BodyTooLargeError
        ? `body exceeds ${maxBodyBytes} bytes`
        : 'error reading request body';
      const errBody = JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: JsonRpcErrorCode.ParseError, message },
      });
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(errBody);
      return;
    }

    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      const errBody = JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: JsonRpcErrorCode.ParseError, message: 'invalid JSON' },
      });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(errBody);
      return;
    }

    if (Array.isArray(parsed)) {
      // MCP spec 2024-11-05: JSON-RPC batch requests MUST NOT be used.
      const errBody = JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JsonRpcErrorCode.InvalidRequest,
          message: 'JSON-RPC batch requests are not supported',
        },
      });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(errBody);
      return;
    }

    if (opts.verbose) {
      process.stderr.write(`[http] → ${raw}\n`);
    }

    const response = await opts.server.handle(parsed);

    if (response === null) {
      // Notification — return 204 No Content so client knows we accepted it.
      res.writeHead(204);
      res.end();
      return;
    }

    const body = JSON.stringify(response);
    if (opts.verbose) {
      process.stderr.write(`[http] ← ${body}\n`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      httpServer.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      resolve(httpServer);
    };
    httpServer.once('listening', onListening);
    httpServer.once('error', onError);
    httpServer.listen(opts.port, opts.host ?? '0.0.0.0');
  });
}

class BodyTooLargeError extends Error {}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };

    req.on('data', (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) {
        // Reject WITHOUT destroying the request/socket — the caller still
        // needs to write the 413 response back to the client. Destroying
        // the socket first would deliver ECONNRESET instead. Pause the
        // upload; the 'data' guard above swallows anything Node buffers.
        req.pause();
        finish(() => reject(new BodyTooLargeError(`body exceeds ${maxBytes} bytes`)));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', (err) => finish(() => reject(err)));
    req.on('aborted', () => finish(() => reject(new Error('client aborted request'))));
  });
}
