/**
 * @file SSE transport proxy.
 * Acts as an SSE server to the client and an SSE client to the upstream MCP server.
 *
 * Client ──SSE──► Proxy :3100 ──SSE──► Server :8080/sse
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { logger } from '../util/logger.js';
import { BaseProxy } from './BaseProxy.js';
import { parseMessage, isRequest, isResponse, extractToolCall, extractToolResponse, isMeteredMethod } from '../interceptor/MessageInterceptor.js';

export class SseProxy extends BaseProxy {
  private server: Server | null = null;
  private sessionId: string = '';

  async start(): Promise<void> {
    const { upstream, listen } = this.config;
    if (!upstream) throw new Error('upstream URL is required for SSE transport');

    const port = listen?.port ?? 3100;
    const host = listen?.host ?? '127.0.0.1';

    this.sessionId = this.sessionManager.getOrCreate();

    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(port, host, () => {
        logger.info('SSE proxy listening', { host, port, upstream });
        resolve();
      });

      this.server!.on('error', (err) => {
        logger.error('SSE server error', { error: err.message });
        reject(err);
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && (url.pathname === '/sse' || url.pathname === '/')) {
      this.handleSseConnection(req, res);
    } else if (req.method === 'POST') {
      this.handlePostMessage(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  private handleSseConnection(_req: IncomingMessage, clientRes: ServerResponse): void {
    const upstream = this.config.upstream!;
    const connSessionId = this.sessionManager.getOrCreate();

    // Set up SSE response to client
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    logger.info('SSE client connected', { sessionId: connSessionId });

    // Connect to upstream as SSE client
    const connectUpstream = () => {
      fetch(upstream, {
        headers: { 'Accept': 'text/event-stream' },
      }).then(async (upstreamRes) => {
        if (!upstreamRes.ok || !upstreamRes.body) {
          logger.error('Upstream SSE connection failed', { status: upstreamRes.status });
          clientRes.end();
          return;
        }

        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const read = async (): Promise<void> => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              logger.info('Upstream SSE stream ended');
              clientRes.end();
              return;
            }

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            // Parse SSE events
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';

            for (const part of parts) {
              // Forward the SSE event to client
              clientRes.write(part + '\n\n');

              // Extract JSON-RPC data for telemetry
              const dataLine = part.split('\n').find(l => l.startsWith('data: '));
              if (dataLine) {
                const raw = dataLine.substring(6);
                this.handleServerMessage(raw, connSessionId);
              }
            }

            await read();
          } catch (err) {
            if (!clientRes.writableEnded) {
              logger.error('Upstream read error', { error: (err as Error).message });
              clientRes.end();
            }
          }
        };

        await read();

      }).catch(err => {
        logger.error('Failed to connect to upstream SSE', { error: (err as Error).message, upstream });
        if (!clientRes.writableEnded) {
          clientRes.end();
        }
      });
    };

    connectUpstream();

    clientRes.on('close', () => {
      logger.info('SSE client disconnected', { sessionId: connSessionId });
      this.sessionManager.endSession(connSessionId);
    });
  }

  private handlePostMessage(req: IncomingMessage, res: ServerResponse): void {
    const upstream = this.config.upstream!;
    const upstreamBase = new URL(upstream).origin;
    const targetUrl = `${upstreamBase}${req.url ?? '/'}`;

    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        // Intercept client message
        const result = await this.handleClientMessage(body, this.sessionId);

        if (!result.forward && result.response) {
          // Quota denied
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(result.response);
          return;
        }

        // Forward to upstream
        const upstreamRes = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': req.headers['content-type'] ?? 'application/json',
          },
          body,
        });

        const responseBody = await upstreamRes.text();

        // Track server response for telemetry
        this.handleServerMessage(responseBody, this.sessionId);

        // Forward response to client
        res.writeHead(upstreamRes.status, {
          'Content-Type': upstreamRes.headers.get('content-type') ?? 'application/json',
        });
        res.end(responseBody);

      } catch (err) {
        logger.error('POST proxy error', { error: (err as Error).message });
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Gateway' }));
      }
    });
  }

  protected async cleanup(): Promise<void> {
    if (this.server) {
      return new Promise(resolve => {
        this.server!.close(() => resolve());
      });
    }
  }
}
