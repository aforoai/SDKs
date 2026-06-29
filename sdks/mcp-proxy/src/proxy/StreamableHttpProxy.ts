/**
 * @file Streamable HTTP transport proxy.
 * HTTP server accepting POST to /mcp, forwarding to upstream /mcp.
 * Uses Mcp-Session-Id header for session scoping.
 *
 * Client ──HTTP──► Proxy :3100/mcp ──HTTP──► Server :8080/mcp
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { logger } from '../util/logger.js';
import { BaseProxy } from './BaseProxy.js';

export class StreamableHttpProxy extends BaseProxy {
  private server: Server | null = null;

  async start(): Promise<void> {
    const { upstream, listen } = this.config;
    if (!upstream) throw new Error('upstream URL is required for streamable-http transport');

    const port = listen?.port ?? 3100;
    const host = listen?.host ?? '127.0.0.1';

    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(port, host, () => {
        logger.info('Streamable HTTP proxy listening', { host, port, upstream });
        resolve();
      });

      this.server!.on('error', (err) => {
        logger.error('HTTP server error', { error: err.message });
        reject(err);
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'POST') {
      this.handlePost(req, res);
    } else if (req.method === 'GET') {
      // SSE upgrade for server-initiated messages
      this.handleGetSse(req, res);
    } else if (req.method === 'DELETE') {
      // Session termination
      this.handleDelete(req, res);
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  }

  private handlePost(req: IncomingMessage, res: ServerResponse): void {
    const upstream = this.config.upstream!;
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;
    const sessionId = this.sessionManager.getOrCreate(mcpSessionId);

    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        // Intercept client message
        const result = await this.handleClientMessage(body, sessionId);

        if (!result.forward && result.response) {
          // Quota denied
          res.writeHead(200, {
            'Content-Type': 'application/json',
            ...(mcpSessionId ? { 'Mcp-Session-Id': mcpSessionId } : {}),
          });
          res.end(result.response);
          return;
        }

        // Forward to upstream
        const headers: Record<string, string> = {
          'Content-Type': req.headers['content-type'] ?? 'application/json',
          'Accept': req.headers['accept'] ?? 'application/json, text/event-stream',
        };
        if (mcpSessionId) {
          headers['Mcp-Session-Id'] = mcpSessionId;
        }

        const upstreamRes = await fetch(upstream, {
          method: 'POST',
          headers,
          body,
        });

        const contentType = upstreamRes.headers.get('content-type') ?? '';
        const responseMcpSessionId = upstreamRes.headers.get('mcp-session-id');

        if (contentType.includes('text/event-stream') && upstreamRes.body) {
          // Streaming response — forward SSE chunks
          const responseHeaders: Record<string, string> = {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          };
          if (responseMcpSessionId) {
            responseHeaders['Mcp-Session-Id'] = responseMcpSessionId;
          }
          res.writeHead(upstreamRes.status, responseHeaders);

          const reader = upstreamRes.body.getReader();
          const decoder = new TextDecoder();

          const pipe = async (): Promise<void> => {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }

            const chunk = decoder.decode(value, { stream: true });
            res.write(chunk);

            // Extract JSON-RPC data lines for telemetry
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                this.handleServerMessage(line.substring(6), sessionId);
              }
            }

            await pipe();
          };

          pipe().catch(err => {
            logger.error('Stream pipe error', { error: (err as Error).message });
            if (!res.writableEnded) res.end();
          });
        } else {
          // Regular JSON response
          const responseBody = await upstreamRes.text();
          this.handleServerMessage(responseBody, sessionId);

          const responseHeaders: Record<string, string> = {
            'Content-Type': contentType || 'application/json',
          };
          if (responseMcpSessionId) {
            responseHeaders['Mcp-Session-Id'] = responseMcpSessionId;
          }
          res.writeHead(upstreamRes.status, responseHeaders);
          res.end(responseBody);
        }

      } catch (err) {
        logger.error('POST proxy error', { error: (err as Error).message });
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Gateway' }));
      }
    });
  }

  private handleGetSse(req: IncomingMessage, res: ServerResponse): void {
    const upstream = this.config.upstream!;
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;
    const sessionId = this.sessionManager.getOrCreate(mcpSessionId);

    // Set up SSE response to client
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...(mcpSessionId ? { 'Mcp-Session-Id': mcpSessionId } : {}),
    });

    // Connect to upstream GET for server-initiated SSE
    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
    };
    if (mcpSessionId) {
      headers['Mcp-Session-Id'] = mcpSessionId;
    }

    fetch(upstream, { method: 'GET', headers }).then(async (upstreamRes) => {
      if (!upstreamRes.body) { res.end(); return; }

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();

      const pipe = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }

        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);

        // Track for telemetry
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            this.handleServerMessage(line.substring(6), sessionId);
          }
        }

        await pipe();
      };

      pipe().catch(() => { if (!res.writableEnded) res.end(); });

    }).catch(err => {
      logger.error('Upstream GET SSE failed', { error: (err as Error).message });
      if (!res.writableEnded) res.end();
    });

    res.on('close', () => {
      this.sessionManager.endSession(sessionId);
    });
  }

  private handleDelete(req: IncomingMessage, res: ServerResponse): void {
    const upstream = this.config.upstream!;
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

    // Forward DELETE to upstream
    const headers: Record<string, string> = {};
    if (mcpSessionId) {
      headers['Mcp-Session-Id'] = mcpSessionId;
      this.sessionManager.endSession(mcpSessionId);
    }

    fetch(upstream, { method: 'DELETE', headers }).then(async (upstreamRes) => {
      res.writeHead(upstreamRes.status);
      res.end(await upstreamRes.text());
    }).catch(err => {
      logger.error('DELETE proxy error', { error: (err as Error).message });
      res.writeHead(502);
      res.end();
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
