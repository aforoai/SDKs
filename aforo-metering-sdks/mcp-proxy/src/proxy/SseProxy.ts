/**
 * @file SSE transport proxy (the 2024-11-05 HTTP+SSE MCP transport).
 * Acts as an SSE server to the client and an SSE client to the upstream MCP server.
 *
 * Client ──SSE──► Proxy :3100 ──SSE──► Server :8080/sse
 *
 * Each client SSE connection is its own session (G305). The upstream's first
 * event on a connection (`event: endpoint`) names the URL that client POSTs
 * its messages to; the proxy remembers which connection that URL belongs to,
 * so a POST is metered in its connection's session and JSON-RPC ids from two
 * clients never collide. Responses come back on the connection's stream.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Principal } from '../types.js';
import { readBody } from '../auth/ListenerGuard.js';
import { BoundedMap } from '../util/BoundedMap.js';
import { SseParser, sseMessage } from '../util/sse.js';
import { logger } from '../util/logger.js';
import { upstreamDeadline, readCappedText, upstreamFailure, DEFAULT_UPSTREAM_TIMEOUT_MS } from '../util/upstream.js';
import { BaseProxy } from './BaseProxy.js';

interface Connection {
  sessionId: string;
  res: ServerResponse;
  upstream: AbortController;
  endpoints: Set<string>;
}

/** Most SSE connections open at once. */
const MAX_CONNECTIONS = 10_000;

export class SseProxy extends BaseProxy {
  private server: Server | null = null;
  private readonly connections = new Map<string, Connection>();
  /** POST endpoint (path + query) → the connection it belongs to. */
  private readonly endpoints = new BoundedMap<string, string>({ maxEntries: MAX_CONNECTIONS * 2 });

  async start(): Promise<void> {
    const { upstream, listen } = this.config;
    if (!upstream) throw new Error('upstream URL is required for SSE transport');

    const port = listen?.port ?? 3100;
    const host = listen?.host ?? '127.0.0.1';

    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server!.once('error', (err) => {
        logger.error('SSE server error', { error: err.message });
        reject(err);
      });
      this.server!.listen(port, host, () => {
        logger.info('SSE proxy listening', { host, port: this.port, upstream });
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
    const principal = decision.principal;
    const url = new URL(req.url ?? '/', 'http://proxy');

    if (req.method === 'GET' && (url.pathname === '/sse' || url.pathname === '/')) {
      this.handleSseConnection(req, res);
    } else if (req.method === 'POST') {
      void this.handlePostMessage(req, res, principal);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...this.guard!.corsHeaders(req) });
      res.end('Not Found');
    }
  }

  private handleSseConnection(req: IncomingMessage, clientRes: ServerResponse): void {
    if (this.connections.size >= MAX_CONNECTIONS) {
      clientRes.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' }).end('Too many open SSE connections');
      return;
    }
    const upstream = this.config.upstream!;
    const upstreamOrigin = new URL(upstream).origin;
    const sessionId = this.sessionManager.getOrCreate();
    const connection: Connection = { sessionId, res: clientRes, upstream: new AbortController(), endpoints: new Set() };
    this.connections.set(sessionId, connection);

    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...this.guard!.corsHeaders(req),
    });
    logger.info('SSE client connected', { sessionId });

    const close = () => {
      if (!this.connections.has(sessionId)) return;
      this.connections.delete(sessionId);
      for (const endpoint of connection.endpoints) this.endpoints.delete(endpoint);
      connection.upstream.abort();
      this.sessionManager.endSession(sessionId);
      if (!clientRes.writableEnded) clientRes.end();
      logger.info('SSE client disconnected', { sessionId });
    };
    clientRes.on('close', close);

    void (async () => {
      try {
        const upstreamRes = await fetch(upstream, {
          headers: { 'Accept': 'text/event-stream' },
          signal: connection.upstream.signal,
        });
        if (!upstreamRes.ok || !upstreamRes.body) {
          logger.error('Upstream SSE connection failed', { status: upstreamRes.status });
          close();
          return;
        }
        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            if (event.event === 'endpoint' && event.data !== undefined) {
              const endpoint = this.registerEndpoint(event.data.trim(), upstreamOrigin, connection);
              clientRes.write(`event: endpoint\ndata: ${endpoint}\n\n`);
              continue;
            }
            clientRes.write(event.raw);
            if (event.data !== undefined) this.handleServerMessage(event.data, sessionId);
          }
        }
        logger.info('Upstream SSE stream ended', { sessionId });
      } catch (err) {
        if (!connection.upstream.signal.aborted) {
          logger.error('Upstream SSE read failed', { error: (err as Error).message, sessionId });
        }
      }
      close();
    })();
  }

  /**
   * Remember which connection an upstream POST endpoint belongs to. An
   * absolute endpoint on the upstream's origin is handed to the client as a
   * relative one, so the client's POSTs come through the proxy (and are
   * metered) instead of going straight to the server.
   */
  private registerEndpoint(data: string, upstreamOrigin: string, connection: Connection): string {
    let endpoint = data;
    try {
      const resolved = new URL(data, upstreamOrigin);
      if (resolved.origin === upstreamOrigin) endpoint = resolved.pathname + resolved.search;
    } catch {
      // Not a URL; forwarded as is.
    }
    connection.endpoints.add(endpoint);
    this.endpoints.set(endpoint, connection.sessionId);
    return endpoint;
  }

  private async handlePostMessage(req: IncomingMessage, res: ServerResponse, principal?: Principal): Promise<void> {
    const cors = this.guard!.corsHeaders(req);
    const path = req.url ?? '/';
    const sessionId = this.endpoints.get(path);
    const connection = sessionId ? this.connections.get(sessionId) : undefined;
    if (!sessionId || !connection) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: 'Unknown message endpoint: open the SSE stream first and POST to the endpoint it names' }));
      return;
    }

    const body = await readBody(req, res, this.guard!.maxBodyBytes, cors);
    if (body === null) return;

    let deadline: ReturnType<typeof upstreamDeadline> | undefined;
    try {
      const result = await this.handleClientMessage(body, sessionId, principal);
      // Calls the proxy refused are answered on the client's stream, like every response.
      if (result.response && !connection.res.writableEnded) connection.res.write(sseMessage(result.response));
      if (!result.forward) {
        res.writeHead(202, { 'Content-Type': 'text/plain', ...cors }).end('Accepted');
        return;
      }

      deadline = upstreamDeadline(this.config.aforo.responseTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS);
      const upstreamRes = await fetch(`${new URL(this.config.upstream!).origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': req.headers['content-type'] ?? 'application/json' },
        body: result.raw,
        signal: deadline.signal,
      });
      const responseBody = await readCappedText(upstreamRes);
      deadline.done();
      // A server may answer on the POST itself; meter that too.
      this.handleServerMessage(responseBody, sessionId);
      res.writeHead(upstreamRes.status, {
        'Content-Type': upstreamRes.headers.get('content-type') ?? 'application/json',
        ...cors,
      });
      res.end(responseBody);
    } catch (err) {
      deadline?.done();
      const failure = upstreamFailure(err, deadline?.signal);
      logger.error('POST proxy error', { error: (err as Error).message, status: failure.status });
      if (!res.headersSent) res.writeHead(failure.status, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: failure.error }));
    }
  }

  /** Open SSE connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  protected async cleanup(): Promise<void> {
    for (const connection of [...this.connections.values()]) {
      connection.upstream.abort();
      if (!connection.res.writableEnded) connection.res.end();
    }
    if (this.server) {
      const server = this.server;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  }
}
