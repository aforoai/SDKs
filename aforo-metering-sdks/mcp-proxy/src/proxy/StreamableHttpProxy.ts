/**
 * @file Streamable HTTP transport proxy.
 * HTTP server accepting POST/GET/DELETE, forwarding to the upstream MCP endpoint.
 * Uses the Mcp-Session-Id header for session scoping; a request without one
 * gets its own short-lived session.
 *
 * Client ──HTTP──► Proxy :3100/mcp ──HTTP──► Server :8080/mcp
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Principal } from '../types.js';
import { readBody } from '../auth/ListenerGuard.js';
import { SseParser, sseMessage } from '../util/sse.js';
import { logger } from '../util/logger.js';
import { upstreamDeadline, readCappedText, upstreamFailure, DEFAULT_UPSTREAM_TIMEOUT_MS } from '../util/upstream.js';
import { BaseProxy } from './BaseProxy.js';

/** Request headers passed to the upstream (never Authorization: the proxy's token is not the server's). */
const FORWARDED_HEADERS = ['mcp-protocol-version', 'last-event-id'];

export class StreamableHttpProxy extends BaseProxy {
  private server: Server | null = null;
  private readonly streams = new Set<AbortController>();

  async start(): Promise<void> {
    const { upstream, listen } = this.config;
    if (!upstream) throw new Error('upstream URL is required for streamable-http transport');

    const port = listen?.port ?? 3100;
    const host = listen?.host ?? '127.0.0.1';

    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server!.once('error', (err) => {
        logger.error('HTTP server error', { error: err.message });
        reject(err);
      });
      this.server!.listen(port, host, () => {
        logger.info('Streamable HTTP proxy listening', { host, port: this.port, upstream });
        this.markServing();
        resolve();
      });
    });
  }

  /** The port actually bound (useful with port 0). */
  get port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const decision = this.guard!.admit(req, res);
    if (!decision.ok) return;
    if (req.method === 'POST') {
      void this.handlePost(req, res, decision.principal);
    } else if (req.method === 'GET') {
      // SSE stream for server-initiated messages
      this.handleGetSse(req, res);
    } else if (req.method === 'DELETE') {
      // Session termination
      this.handleDelete(req, res);
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain', ...this.guard!.corsHeaders(req) });
      res.end('Method Not Allowed');
    }
  }

  private upstreamHeaders(req: IncomingMessage, mcpSessionId: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;
    return headers;
  }

  private async handlePost(req: IncomingMessage, res: ServerResponse, principal?: Principal): Promise<void> {
    const cors = this.guard!.corsHeaders(req);
    const body = await readBody(req, res, this.guard!.maxBodyBytes, cors);
    if (body === null) return;

    const mcpSessionId = headerValue(req, 'mcp-session-id');
    // No Mcp-Session-Id (e.g. initialize): this request is its own session, ended when it is answered.
    const sessionId = this.sessionManager.getOrCreate(mcpSessionId);
    const ephemeral = !mcpSessionId;
    const finish = () => { if (ephemeral) this.sessionManager.endSession(sessionId); };

    let deadline: ReturnType<typeof upstreamDeadline> | undefined;
    try {
      const result = await this.handleClientMessage(body, sessionId, principal);
      const echo = mcpSessionId ? { 'Mcp-Session-Id': mcpSessionId } : {};

      if (!result.forward) {
        // Every call in the message was refused by the quota check.
        res.writeHead(200, { 'Content-Type': 'application/json', ...echo, ...cors });
        res.end(result.response);
        finish();
        return;
      }

      deadline = upstreamDeadline(this.config.aforo.responseTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS);
      const upstreamRes = await fetch(this.config.upstream!, {
        method: 'POST',
        headers: {
          ...this.upstreamHeaders(req, mcpSessionId),
          'Content-Type': req.headers['content-type'] ?? 'application/json',
          'Accept': req.headers['accept'] ?? 'application/json, text/event-stream',
        },
        body: result.raw,
        signal: deadline.signal,
      });

      const contentType = upstreamRes.headers.get('content-type') ?? '';
      const responseMcpSessionId = upstreamRes.headers.get('mcp-session-id');
      const sessionHeader = responseMcpSessionId ? { 'Mcp-Session-Id': responseMcpSessionId } : {};

      if (contentType.includes('text/event-stream') && upstreamRes.body) {
        res.writeHead(upstreamRes.status, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...sessionHeader,
          ...cors,
        });
        if (result.response) res.write(sseMessage(result.response));
        // A streamed answer lives as long as the server keeps it open; the deadline covered the headers.
        deadline.done();
        await this.pipeSse(upstreamRes.body, res, sessionId);
        finish();
        return;
      }

      // Regular JSON response (or an empty 202 for notifications).
      const responseBody = await readCappedText(upstreamRes);
      deadline.done();
      this.handleServerMessage(responseBody, sessionId);
      const merged = result.response ? mergeResponses(responseBody, result.response) : undefined;
      res.writeHead(merged !== undefined ? 200 : upstreamRes.status, {
        'Content-Type': merged !== undefined ? 'application/json' : (contentType || 'application/json'),
        ...sessionHeader,
        ...cors,
      });
      res.end(merged ?? responseBody);
      finish();
    } catch (err) {
      deadline?.done();
      const failure = upstreamFailure(err, deadline?.signal);
      logger.error('POST proxy error', { error: (err as Error).message, status: failure.status });
      if (!res.headersSent) res.writeHead(failure.status, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: failure.error }));
      finish();
    }
  }

  /** Copy an upstream SSE body to the client unchanged, metering each event's data. */
  private async pipeSse(body: ReadableStream<Uint8Array>, res: ServerResponse, sessionId: string, abort?: AbortController): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
        for (const event of parser.push(chunk)) {
          if (event.data !== undefined) this.handleServerMessage(event.data, sessionId);
        }
      }
    } catch (err) {
      if (!abort?.signal.aborted) logger.error('Stream pipe error', { error: (err as Error).message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  private handleGetSse(req: IncomingMessage, res: ServerResponse): void {
    const cors = this.guard!.corsHeaders(req);
    const mcpSessionId = headerValue(req, 'mcp-session-id');
    const sessionId = this.sessionManager.getOrCreate(mcpSessionId);
    const abort = new AbortController();
    this.streams.add(abort);
    res.on('close', () => {
      abort.abort();
      this.streams.delete(abort);
      if (!mcpSessionId) this.sessionManager.endSession(sessionId);
    });

    void (async () => {
      try {
        const upstreamRes = await fetch(this.config.upstream!, {
          method: 'GET',
          headers: { ...this.upstreamHeaders(req, mcpSessionId), 'Accept': 'text/event-stream' },
          signal: abort.signal,
        });
        if (!upstreamRes.ok || !upstreamRes.body) {
          res.writeHead(upstreamRes.status, { 'Content-Type': upstreamRes.headers.get('content-type') ?? 'text/plain', ...cors });
          res.end(await upstreamRes.text());
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...(mcpSessionId ? { 'Mcp-Session-Id': mcpSessionId } : {}),
          ...cors,
        });
        await this.pipeSse(upstreamRes.body, res, sessionId, abort);
      } catch (err) {
        if (!abort.signal.aborted) logger.error('Upstream GET SSE failed', { error: (err as Error).message });
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json', ...cors });
        if (!res.writableEnded) res.end();
      }
    })();
  }

  private handleDelete(req: IncomingMessage, res: ServerResponse): void {
    const cors = this.guard!.corsHeaders(req);
    const mcpSessionId = headerValue(req, 'mcp-session-id');
    if (mcpSessionId) this.sessionManager.endSession(this.sessionManager.getOrCreate(mcpSessionId));

    const deadline = upstreamDeadline(this.config.aforo.responseTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS);
    fetch(this.config.upstream!, { method: 'DELETE', headers: this.upstreamHeaders(req, mcpSessionId), signal: deadline.signal })
      .then(async (upstreamRes) => {
        const text = await readCappedText(upstreamRes);
        deadline.done();
        res.writeHead(upstreamRes.status, cors);
        res.end(text);
      })
      .catch((err) => {
        deadline.done();
        const failure = upstreamFailure(err, deadline.signal);
        logger.error('DELETE proxy error', { error: (err as Error).message, status: failure.status });
        if (!res.headersSent) res.writeHead(failure.status, cors);
        res.end();
      });
  }

  protected async cleanup(): Promise<void> {
    for (const abort of this.streams) abort.abort();
    if (this.server) {
      const server = this.server;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * The upstream's answer plus the proxy's refusals, as one JSON-RPC batch
 * response. Returns undefined when the upstream body is not JSON-RPC (it is
 * then sent as is and the refusals are lost to the client, which is logged).
 */
function mergeResponses(upstreamBody: string, refusals: string): string | undefined {
  const refused = JSON.parse(refusals) as unknown;
  const refusedList = Array.isArray(refused) ? refused : [refused];
  if (!upstreamBody.trim()) return JSON.stringify(refusedList);
  try {
    const parsed = JSON.parse(upstreamBody) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return JSON.stringify([...list, ...refusedList]);
  } catch {
    logger.warn('Upstream answer is not JSON; refused calls could not be added to it', { refused: refusedList.length });
    return undefined;
  }
}
