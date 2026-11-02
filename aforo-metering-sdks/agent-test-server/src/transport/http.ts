// HTTP transport — REST endpoints for the AI_AGENT test server.
//
// Endpoints:
//   POST   /agent/session            → create a session
//   GET    /agent/session/{id}       → session snapshot
//   DELETE /agent/session/{id}       → end + return final counters
//   POST   /agent/invoke             → call a capability against a session
//   GET    /agent/capabilities       → list the 5 canonical capabilities
//   GET    /health                   → docker HEALTHCHECK path (uptime included)
//
// Design notes (mirror mcp-test-server/http.ts):
//   - Returns Promise<http.Server> that resolves on 'listening' so callers
//     can't hit the address()-returns-null race.
//   - Body capped at maxBodyBytes (default 1 MiB); oversize → 413 with a
//     structured error envelope, no socket destroy (so the response can
//     actually reach the client).
//   - Session id on create is echoed back via `X-Session-Id` response header
//     AND a Location header, per the addendum spec.
//   - Response 'error' events (client disconnected) are swallowed so a load
//     test that half-closes connections can't crash the process.

import http from 'node:http';
import { AgentTestServer, type DispatchResult } from '../server.js';
import {
  ErrorCode,
  type CreateSessionRequest,
  type ErrorResponse,
  type InvokeRequest,
} from '../types.js';

export interface HttpTransportOptions {
  port: number;
  host?: string;
  server: AgentTestServer;
  /** Echo request/response envelopes to stderr for CI debugging. */
  verbose?: boolean;
  /** Max request body size in bytes. Defaults to 1 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 1 << 20;
const JSON_HEADER = { 'Content-Type': 'application/json' } as const;

export function startHttp(opts: HttpTransportOptions): Promise<http.Server> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

  const httpServer = http.createServer(async (req, res) => {
    // Swallow client-hung-up mid-response — otherwise Node turns those into
    // uncaughtException under load.
    res.on('error', () => { /* client disconnected — ignore */ });

    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    try {
      // ── GET /health ────────────────────────────────────────────────────
      if (method === 'GET' && (url === '/health' || url === '/')) {
        const body = JSON.stringify({
          status: 'UP',
          uptimeSeconds: opts.server.uptimeSec(),
          server: opts.server.info(),
        });
        res.writeHead(200, JSON_HEADER);
        res.end(body);
        return;
      }

      // ── GET /agent/capabilities ────────────────────────────────────────
      if (method === 'GET' && url === '/agent/capabilities') {
        res.writeHead(200, JSON_HEADER);
        res.end(JSON.stringify({ capabilities: opts.server.capabilities() }));
        return;
      }

      // ── Session lifecycle ──────────────────────────────────────────────
      // Match /agent/session and /agent/session/{id} separately; the id can
      // legally contain characters URI-escaped so parse via URL.pathname.
      if (url === '/agent/session' && method === 'POST') {
        const body = await readJson(req, res, maxBodyBytes, opts.verbose);
        if (body === undefined) return;
        // Server-side runtime validation checks agentId and returns 400
        // missing_field if absent — the DTO type is enforced at that layer,
        // not here. Cast through unknown so TS strict mode is honest about
        // the transport-boundary trust boundary.
        const result = opts.server.createSession(body as unknown as CreateSessionRequest);
        writeDispatch(res, result, { setSessionHeaders: true });
        return;
      }

      // /agent/session/{id} — GET or DELETE
      const sessionMatch = url.match(/^\/agent\/session\/([^/?#]+)$/);
      if (sessionMatch) {
        // decodeURIComponent throws URIError on malformed input like "%GG".
        // Guard so the client gets a clean 400 malformed_body instead of
        // Node's default empty 500 from the uncaught exception.
        let sessionId: string;
        try {
          sessionId = decodeURIComponent(sessionMatch[1]);
        } catch {
          writeErr(res, 400, ErrorCode.MalformedBody, 'session id in URL is not a valid URI component');
          return;
        }
        if (method === 'GET') {
          const result = opts.server.getSession(sessionId);
          writeDispatch(res, result);
          return;
        }
        if (method === 'DELETE') {
          const result = opts.server.endSession(sessionId);
          writeDispatch(res, result);
          return;
        }
        writeErr(res, 405, ErrorCode.MethodNotAllowed, `method not allowed: ${method}`);
        return;
      }

      // ── POST /agent/invoke ─────────────────────────────────────────────
      if (url === '/agent/invoke' && method === 'POST') {
        const body = await readJson(req, res, maxBodyBytes, opts.verbose);
        if (body === undefined) return;
        const result = await opts.server.invoke(body as unknown as InvokeRequest);
        writeDispatch(res, result);
        return;
      }

      writeErr(res, 404, ErrorCode.NotFound, `not found: ${method} ${url}`);
    } catch (err) {
      // Defense in depth — the server methods surface known failure modes
      // via DispatchResult{kind:'error'}. Reaching here means an unhandled
      // exception escaped the dispatch layer (e.g. crypto.randomBytes failed,
      // an unexpected input shape triggered a coercion bug). Return a
      // structured 500 so downstream drivers can key off `internal_error`
      // programmatically instead of parsing an empty Node default body.
      // Never leak stack traces on the wire.
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        writeErr(res, 500, ErrorCode.InternalError, `unhandled server error: ${message}`);
      }
      if (opts.verbose) {
        process.stderr.write(`[http] uncaught in handler: ${err instanceof Error ? err.stack : String(err)}\n`);
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

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Read a JSON body OR write the error response and return undefined so the
 * caller can bail cleanly. Handles: oversized body (413), invalid JSON
 * (400), array-at-root (400 — this server takes single objects only).
 */
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
  if (verbose) process.stderr.write(`[http] → ${raw}\n`);

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

/** Write a DispatchResult back over HTTP. */
function writeDispatch<T>(
  res: http.ServerResponse,
  result: DispatchResult<T>,
  opts: { setSessionHeaders?: boolean } = {},
): void {
  if (result.kind === 'error') {
    writeErr(res, result.status, result.code, result.message);
    return;
  }
  const headers: Record<string, string> = { ...JSON_HEADER };
  if (opts.setSessionHeaders) {
    // createSession result has sessionId — the type is generic here so cast
    // through unknown to keep TypeScript honest.
    const sessionId = (result.value as unknown as { sessionId?: string }).sessionId;
    if (sessionId) {
      headers['X-Session-Id'] = sessionId;
      headers['Location'] = `/agent/session/${encodeURIComponent(sessionId)}`;
    }
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify(result.value));
}

/** Write a structured error envelope. */
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
