/**
 * @file In-process fake MCP servers the SSE and Streamable HTTP proxy tests
 * sit in front of. They answer `tools/call` (single or batch) with a result
 * that names the tool, so a test can tell which call a response belongs to.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

function answer(msg: any): any {
  if (!msg || typeof msg !== 'object' || msg.id === undefined) return undefined;
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } };
  }
  if (msg.method === 'tools/call') {
    return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `ran ${msg.params?.name}` }] } };
  }
  return { jsonrpc: '2.0', id: msg.id, result: {} };
}

/** Answers for a single message or a batch; undefined when nothing needs an answer. */
export function answerAll(body: any): any {
  if (Array.isArray(body)) {
    const out = body.map(answer).filter((r) => r !== undefined);
    return out.length ? out : undefined;
  }
  return answer(body);
}

async function readJson(req: IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of req) text += chunk.toString();
  return text ? JSON.parse(text) : undefined;
}

export interface FakeUpstream {
  url: string;
  /** Requests the upstream received: method, path and headers (lower-case). */
  seen: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body?: any }>;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function closer(server: Server, streams: Set<ServerResponse>): () => Promise<void> {
  return () => new Promise<void>((resolve) => {
    for (const s of streams) s.end();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/**
 * The 2024-11-05 HTTP+SSE transport: `GET /sse` opens a stream whose first
 * event names a per-connection POST endpoint; responses to POSTs come back on
 * that connection's stream.
 */
export async function startLegacySseUpstream(): Promise<FakeUpstream> {
  const streams = new Map<string, ServerResponse>();
  const all = new Set<ServerResponse>();
  const seen: FakeUpstream['seen'] = [];
  let next = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    if (req.method === 'GET' && url.pathname === '/sse') {
      seen.push({ method: 'GET', path: url.pathname + url.search, headers: req.headers });
      const id = `c${++next}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
      streams.set(id, res);
      all.add(res);
      req.on('close', () => { streams.delete(id); all.delete(res); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const body = await readJson(req);
      seen.push({ method: 'POST', path: url.pathname + url.search, headers: req.headers, body });
      const stream = streams.get(url.searchParams.get('sessionId') ?? '');
      if (!stream) {
        res.writeHead(404).end('no such session');
        return;
      }
      res.writeHead(202).end('Accepted');
      const reply = answerAll(body);
      if (reply !== undefined) stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  return { url: `${await listen(server)}/sse`, seen, close: closer(server, all) };
}

/**
 * The 2025-03-26 Streamable HTTP transport at `/mcp`. `streamResponses: true`
 * answers POSTs as an SSE stream, split across several writes so the proxy
 * must reassemble events that span chunks.
 */
export async function startStreamableUpstream(options: { streamResponses?: boolean } = {}): Promise<FakeUpstream> {
  const seen: FakeUpstream['seen'] = [];
  const all = new Set<ServerResponse>();
  let next = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method === 'DELETE') {
      seen.push({ method: 'DELETE', path: url.pathname, headers: req.headers });
      res.writeHead(200).end();
      return;
    }
    if (req.method === 'GET') {
      seen.push({ method: 'GET', path: url.pathname, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      all.add(res);
      req.on('close', () => all.delete(res));
      return;
    }
    const body = await readJson(req);
    seen.push({ method: 'POST', path: url.pathname, headers: req.headers, body });
    const sessionHeader = (body && !Array.isArray(body) && body.method === 'initialize')
      ? { 'Mcp-Session-Id': `up-${++next}` } : {};
    const reply = answerAll(body);
    if (reply === undefined) { res.writeHead(202, sessionHeader).end(); return; }
    if (options.streamResponses) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', ...sessionHeader });
      const text = `event: message\ndata: ${JSON.stringify(reply)}\n\n`;
      const cut = Math.floor(text.length / 2);
      res.write(text.slice(0, cut));
      setTimeout(() => { res.write(text.slice(cut)); res.end(); }, 5);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...sessionHeader });
    res.end(JSON.stringify(reply));
  });
  return { url: `${await listen(server)}/mcp`, seen, close: closer(server, all) };
}
