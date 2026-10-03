// Streamable HTTP transport — the MCP spec's SSE-style transport.
//
// Two endpoints on the same URL:
//   POST /mcp — client → server JSON-RPC (may open a session)
//   GET  /mcp — server → client Server-Sent Events stream (session lifetime)
//
// Sessions are identified by the Mcp-Session-Id header, which the server
// mints on the first request that doesn't already carry one. Every response
// echoes the header back. The mcp-proxy StreamableHttpProxy speaks this
// exact shape.
//
// Keep-alive: sends `:heartbeat\n\n` every 30s so intermediate proxies
// (Kong, CloudFront) don't idle-timeout the SSE connection.

import http from 'node:http';
import crypto from 'node:crypto';
import { McpTestServer } from '../server.js';
import { JsonRpcErrorCode, type JsonRpcRequest, type JsonRpcResponse } from '../types.js';

export interface SseTransportOptions {
  port: number;
  host?: string;
  server: McpTestServer;
  verbose?: boolean;
  /** Max request body size in bytes. Defaults to 1 MiB. */
  maxBodyBytes?: number;
}

interface Session {
  id: string;
  createdAt: number;
  /** Live SSE response streams keyed by request id — one per GET /mcp. */
  streams: Set<http.ServerResponse>;
}

const HEARTBEAT_MS = 30_000;
const SESSION_HEADER = 'mcp-session-id';

export function startSse(opts: SseTransportOptions): Promise<http.Server> {
  const sessions = new Map<string, Session>();
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

  const httpServer = http.createServer(async (req, res) => {
    // Swallow late response 'error' events (client hung up mid-stream) so
    // they never become an uncaughtException under load.
    res.on('error', () => { /* client disconnected — ignore */ });

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.url !== '/mcp') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const incomingSessionId = normHeader(req.headers[SESSION_HEADER]);
    const sessionId = incomingSessionId ?? crypto.randomUUID();
    let session = sessions.get(sessionId);
    if (!session) {
      session = { id: sessionId, createdAt: Date.now(), streams: new Set() };
      sessions.set(sessionId, session);
    }

    if (req.method === 'GET') {
      // Open an SSE stream for server → client push.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Mcp-Session-Id': sessionId,
      });
      safeWrite(res, `: session ${sessionId} opened\n\n`);
      session.streams.add(res);

      const heartbeat = setInterval(() => {
        // Bail out if the stream is closed — write() would return false
        // silently, letting the interval spin forever after client crash.
        if (res.writableEnded || res.destroyed) {
          clearInterval(heartbeat);
          session?.streams.delete(res);
          return;
        }
        safeWrite(res, ':heartbeat\n\n');
      }, HEARTBEAT_MS);

      const cleanup = () => {
        clearInterval(heartbeat);
        session?.streams.delete(res);
        // Drop the session when the last stream closes.
        if (session && session.streams.size === 0) {
          sessions.delete(session.id);
        }
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }

    if (req.method === 'POST') {
      let raw: string;
      try {
        raw = await readBody(req, maxBodyBytes);
      } catch (err) {
        const code = err instanceof BodyTooLargeError ? 413 : 400;
        const message = err instanceof BodyTooLargeError
          ? `body exceeds ${maxBodyBytes} bytes`
          : 'error reading request body';
        res.writeHead(code, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: JsonRpcErrorCode.ParseError, message },
        }));
        return;
      }

      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(raw) as JsonRpcRequest;
      } catch {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: JsonRpcErrorCode.ParseError, message: 'invalid JSON' },
        }));
        return;
      }

      if (Array.isArray(parsed)) {
        // MCP spec 2024-11-05: batches are not permitted.
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: JsonRpcErrorCode.InvalidRequest,
            message: 'JSON-RPC batch requests are not supported',
          },
        }));
        return;
      }

      if (opts.verbose) {
        process.stderr.write(`[sse ${sessionId}] → ${raw}\n`);
      }

      const response = await opts.server.handle(parsed);

      // Echo the response inline on the POST — the client can also observe
      // it on any open SSE stream for this session (broadcast below).
      if (response === null) {
        res.writeHead(204, { 'Mcp-Session-Id': sessionId });
        res.end();
        broadcastNotification(session, parsed, opts.verbose);
        return;
      }

      const body = JSON.stringify(response);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sessionId,
      });
      res.end(body);

      if (opts.verbose) {
        process.stderr.write(`[sse ${sessionId}] ← ${body}\n`);
      }

      // Fan the response out over any open GET /mcp streams so a client that
      // opened a listener sees the same reply that came back on the POST.
      broadcastResponse(session, response, opts.verbose);
      return;
    }

    res.writeHead(405);
    res.end('method not allowed');
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

function broadcastResponse(session: Session, response: JsonRpcResponse, verbose?: boolean) {
  const payload = `event: message\ndata: ${JSON.stringify(response)}\n\n`;
  const alive: http.ServerResponse[] = [];
  for (const stream of session.streams) {
    if (stream.writableEnded || stream.destroyed) continue;
    if (safeWrite(stream, payload)) alive.push(stream);
  }
  if (verbose && alive.length > 0) {
    process.stderr.write(`[sse ${session.id}] fanout → ${alive.length} stream(s)\n`);
  }
}

function broadcastNotification(session: Session, req: JsonRpcRequest, verbose?: boolean) {
  const payload = `event: notification\ndata: ${JSON.stringify(req)}\n\n`;
  let count = 0;
  for (const stream of session.streams) {
    if (stream.writableEnded || stream.destroyed) continue;
    if (safeWrite(stream, payload)) count++;
  }
  if (verbose && count > 0) {
    process.stderr.write(`[sse ${session.id}] notification fanout → ${count} stream(s)\n`);
  }
}

/**
 * Write to an SSE response, returning true iff the byte hit the wire. Handles
 * both the "returned false" case (backpressure — Node buffered it) and the
 * "throw / emit error" case (write after end) uniformly: any write on a
 * closed stream returns false and does not throw. See node:http docs.
 */
function safeWrite(res: http.ServerResponse, chunk: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    return res.write(chunk);
  } catch {
    return false;
  }
}

class BodyTooLargeError extends Error {}
const DEFAULT_MAX_BODY = 1 << 20;

function normHeader(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

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
