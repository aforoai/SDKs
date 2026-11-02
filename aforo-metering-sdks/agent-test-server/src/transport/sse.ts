// SSE transport — server-sent events per-session stream.
//
// Endpoints on /agent/stream/{sessionId}:
//   GET /agent/stream/{sessionId} — open a per-session SSE stream. Each
//   invocation against that session is fanned out to every connected
//   listener as an `event: invocation` payload with the InvokeResponse.
//
// The invoke path itself continues to live at POST /agent/invoke — the
// SSE stream is a broadcast tap, not a request/response channel. This
// matches how a real dashboard would tail a live agent session (subscribe
// once, see each capability call as it lands) without duplicating the
// wire protocol.
//
// Uses the same body-size-cap + swallowed-error-event patterns as http.ts.

import http from 'node:http';
import { AgentTestServer } from '../server.js';
import {
  ErrorCode,
  type CreateSessionRequest,
  type ErrorResponse,
  type InvokeRequest,
  type InvokeResponse,
} from '../types.js';

export interface SseTransportOptions {
  port: number;
  host?: string;
  server: AgentTestServer;
  verbose?: boolean;
  /** Max request body size in bytes. Defaults to 1 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 1 << 20;
const HEARTBEAT_MS = 30_000;
const JSON_HEADER = { 'Content-Type': 'application/json' } as const;

interface StreamRegistry {
  /** Map sessionId → open SSE responses subscribed to that session. */
  streams: Map<string, Set<http.ServerResponse>>;
}

export function startSse(opts: SseTransportOptions): Promise<http.Server> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const registry: StreamRegistry = { streams: new Map() };

  const httpServer = http.createServer(async (req, res) => {
    res.on('error', () => { /* client disconnected — ignore */ });

    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    try {
    if (method === 'GET' && (url === '/health' || url === '/')) {
      res.writeHead(200, JSON_HEADER);
      res.end(JSON.stringify({
        status: 'UP',
        uptimeSeconds: opts.server.uptimeSec(),
        server: opts.server.info(),
      }));
      return;
    }

    // GET /agent/stream/{sessionId}
    const streamMatch = url.match(/^\/agent\/stream\/([^/?#]+)$/);
    if (streamMatch && method === 'GET') {
      // decodeURIComponent throws URIError on malformed input like "%GG".
      // Guard so the client gets a clean 400 malformed_body instead of
      // Node's default empty 500 from the uncaught exception.
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(streamMatch[1]);
      } catch {
        writeErr(res, 400, ErrorCode.MalformedBody, 'session id in URL is not a valid URI component');
        return;
      }
      // Do NOT require the session to exist yet — a dashboard might
      // subscribe before the session opens. But do echo whether it's
      // currently active in the initial comment so the client knows.
      const existing = opts.server.getSession(sessionId);
      const initialStatus = existing.kind === 'ok' ? existing.value.status : 'pending';

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Session-Id': sessionId,
      });
      safeWrite(res, `: session ${sessionId} subscribed (status=${initialStatus})\n\n`);
      subscribe(registry, sessionId, res);

      const heartbeat = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(heartbeat);
          unsubscribe(registry, sessionId, res);
          return;
        }
        safeWrite(res, ':heartbeat\n\n');
      }, HEARTBEAT_MS);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe(registry, sessionId, res);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }

    // POST /agent/invoke — invoke + broadcast to matching session streams
    if (url === '/agent/invoke' && method === 'POST') {
      const body = await readJson(req, res, maxBodyBytes, opts.verbose);
      if (body === undefined) return;
      // Runtime validation happens server-side (returns 400 missing_field
      // if agentId / sessionId / capability are absent). Cast through
      // unknown so TS strict mode is honest about the trust boundary.
      const result = await opts.server.invoke(body as unknown as InvokeRequest);
      if (result.kind === 'ok') {
        // Fan out to subscribers of this session before responding — the
        // dashboard sees the event even if the requesting client hangs up
        // before reading the response.
        broadcastInvocation(registry, result.value.sessionId, result.value, opts.verbose);
        res.writeHead(200, JSON_HEADER);
        res.end(JSON.stringify(result.value));
      } else {
        writeErr(res, result.status, result.code, result.message);
      }
      return;
    }

    // POST /agent/session — allow session creation on the same server so a
    // single-transport SSE deployment stays useful without a separate HTTP.
    if (url === '/agent/session' && method === 'POST') {
      const body = await readJson(req, res, maxBodyBytes, opts.verbose);
      if (body === undefined) return;
      const result = opts.server.createSession(body as unknown as CreateSessionRequest);
      if (result.kind === 'ok') {
        res.writeHead(200, {
          ...JSON_HEADER,
          'X-Session-Id': result.value.sessionId,
          Location: `/agent/session/${encodeURIComponent(result.value.sessionId)}`,
        });
        res.end(JSON.stringify(result.value));
      } else {
        writeErr(res, result.status, result.code, result.message);
      }
      return;
    }

    // DELETE /agent/session/{id} — end + broadcast an end event
    const sessionEndMatch = url.match(/^\/agent\/session\/([^/?#]+)$/);
    if (sessionEndMatch && method === 'DELETE') {
      // decodeURIComponent throws on malformed URI — guard as above.
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(sessionEndMatch[1]);
      } catch {
        writeErr(res, 400, ErrorCode.MalformedBody, 'session id in URL is not a valid URI component');
        return;
      }
      const result = opts.server.endSession(sessionId);
      if (result.kind === 'ok') {
        broadcastSessionEnd(registry, sessionId, opts.verbose);
        res.writeHead(200, JSON_HEADER);
        res.end(JSON.stringify(result.value));
      } else {
        writeErr(res, result.status, result.code, result.message);
      }
      return;
    }

    writeErr(res, 404, ErrorCode.NotFound, `not found: ${method} ${url}`);
    } catch (err) {
      // Defense in depth — mirrors http.ts. Reaching here means an
      // unhandled exception escaped the dispatch layer. Return a structured
      // 500 so the caller can key off `internal_error`. Never leak stacks.
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        writeErr(res, 500, ErrorCode.InternalError, `unhandled server error: ${message}`);
      }
      if (opts.verbose) {
        process.stderr.write(`[sse] uncaught in handler: ${err instanceof Error ? err.stack : String(err)}\n`);
      }
    }
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

function subscribe(reg: StreamRegistry, sessionId: string, res: http.ServerResponse): void {
  let set = reg.streams.get(sessionId);
  if (!set) {
    set = new Set();
    reg.streams.set(sessionId, set);
  }
  set.add(res);
}

function unsubscribe(reg: StreamRegistry, sessionId: string, res: http.ServerResponse): void {
  const set = reg.streams.get(sessionId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) reg.streams.delete(sessionId);
}

function broadcastInvocation(
  reg: StreamRegistry,
  sessionId: string,
  invocation: InvokeResponse,
  verbose?: boolean,
): void {
  const streams = reg.streams.get(sessionId);
  if (!streams) return;
  const payload = `event: invocation\ndata: ${JSON.stringify(invocation)}\n\n`;
  let count = 0;
  for (const stream of streams) {
    if (stream.writableEnded || stream.destroyed) continue;
    if (safeWrite(stream, payload)) count += 1;
  }
  if (verbose && count > 0) {
    process.stderr.write(`[sse ${sessionId}] invocation → ${count} stream(s)\n`);
  }
}

function broadcastSessionEnd(reg: StreamRegistry, sessionId: string, verbose?: boolean): void {
  const streams = reg.streams.get(sessionId);
  if (!streams) return;
  const payload = `event: session_end\ndata: ${JSON.stringify({ sessionId })}\n\n`;
  for (const stream of streams) {
    if (stream.writableEnded || stream.destroyed) continue;
    safeWrite(stream, payload);
  }
  if (verbose) {
    process.stderr.write(`[sse ${sessionId}] session_end → ${streams.size} stream(s)\n`);
  }
}

function safeWrite(res: http.ServerResponse, chunk: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    return res.write(chunk);
  } catch {
    return false;
  }
}

async function readJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes: number,
  verbose?: boolean,
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readBody(req, maxBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      writeErr(res, 413, ErrorCode.BodyTooLarge, `body exceeds ${maxBytes} bytes`);
    } else {
      writeErr(res, 400, ErrorCode.MalformedBody, 'error reading request body');
    }
    return undefined;
  }
  if (verbose) process.stderr.write(`[sse] → ${raw}\n`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeErr(res, 400, ErrorCode.MalformedBody, 'invalid JSON');
    return undefined;
  }
  if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
    writeErr(res, 400, ErrorCode.MalformedBody, 'request body must be a JSON object');
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function writeErr(res: http.ServerResponse, status: number, code: string, message: string): void {
  const body: ErrorResponse = { error: { code, message } };
  res.writeHead(status, JSON_HEADER);
  res.end(JSON.stringify(body));
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
