/**
 * @file Front door of the SSE and Streamable HTTP listeners (G302).
 *
 * Every request must:
 * 1. carry a Host header naming this proxy (localhost / 127.0.0.1 / [::1], the
 *    listen host, or an `allowedHosts` entry) — a DNS-rebinding page reaches the
 *    proxy under the attacker's host name and is refused here;
 * 2. carry no `Origin`, or one listed in `allowedOrigins` (CORS answers name
 *    that origin; there is no wildcard);
 * 3. present `Authorization: Bearer <token>` matching a configured token,
 *    unless `allowUnauthenticated` is set on a loopback listener.
 *
 * Tokens are compared by their SHA-256 digest, so lookup time does not depend
 * on how many leading characters match. A token can map to the customer its
 * calls are billed to (`authTokensFile`).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ListenConfig, Principal } from '../types.js';

export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const MIN_TOKEN_LENGTH = 16;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];
const CORS_ALLOW_HEADERS = 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID';

export type GuardDecision =
  | { ok: true; principal?: Principal }
  | { ok: false; status: number; message: string; headers?: Record<string, string> };

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Host name of a Host header value, without the port; lower-cased. */
export function hostName(header: string): string {
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }
  const colon = value.lastIndexOf(':');
  return colon > 0 && value.indexOf(':') === colon ? value.slice(0, colon) : value;
}

export function isLoopbackHost(host: string | undefined): boolean {
  const h = stripBrackets((host ?? '').trim().toLowerCase());
  return LOOPBACK_HOSTS.includes(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Read `{ "<token>": "<customerId>", ... }`. Throws with a clear message on a bad file. */
export function loadTokenFile(path: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read auth tokens file ${path}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Auth tokens file ${path} must be a JSON object of "<token>": "<customerId>"`);
  }
  const out: Record<string, string> = {};
  for (const [token, customer] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof customer !== 'string' || !customer.trim()) {
      throw new Error(`Auth tokens file ${path}: every token must map to a non-blank customer id`);
    }
    out[token] = customer.trim();
  }
  return out;
}

export class ListenerGuard {
  private readonly principals = new Map<string, Principal>();
  private readonly allowUnauthenticated: boolean;
  private readonly allowedHosts: Set<string>;
  private readonly allowedOrigins: Set<string>;
  readonly maxBodyBytes: number;
  /** True when at least one token names a customer. */
  readonly tokensMapCustomers: boolean;

  constructor(listen: ListenConfig | undefined) {
    const config = listen ?? { port: 3100 };
    const host = config.host ?? '127.0.0.1';

    const tokens: Record<string, string | undefined> = {};
    if (config.authToken !== undefined) tokens[config.authToken] = undefined;
    const mapped = { ...(config.authTokens ?? {}), ...(config.authTokensFile ? loadTokenFile(config.authTokensFile) : {}) };
    for (const [token, customer] of Object.entries(mapped)) tokens[token] = customer;
    for (const [token, customer] of Object.entries(tokens)) {
      if (typeof token !== 'string' || token.trim().length < MIN_TOKEN_LENGTH || token !== token.trim()) {
        throw new Error(`Every listener auth token must be at least ${MIN_TOKEN_LENGTH} characters with no surrounding spaces`);
      }
      const hash = digest(token);
      this.principals.set(hash, { label: `token#${hash.slice(0, 8)}`, ...(customer ? { customerId: customer } : {}) });
    }
    this.tokensMapCustomers = Object.values(tokens).some((c) => typeof c === 'string' && c.length > 0);

    this.allowUnauthenticated = config.allowUnauthenticated === true;
    if (this.principals.size === 0 && !this.allowUnauthenticated) {
      throw new Error(
        'The HTTP listener needs authentication: set listen.authToken (--auth-token / AFORO_PROXY_AUTH_TOKEN) or ' +
        'listen.authTokensFile (--auth-tokens-file). To accept unauthenticated requests on a loopback address, set ' +
        'listen.allowUnauthenticated (--allow-unauthenticated).',
      );
    }
    if (this.allowUnauthenticated && this.principals.size === 0 && !isLoopbackHost(host)) {
      throw new Error(`allowUnauthenticated is only allowed on a loopback listen host (got ${host})`);
    }

    this.allowedHosts = new Set([...LOOPBACK_HOSTS, ...(config.allowedHosts ?? []).map((h) => stripBrackets(h.trim().toLowerCase()))]);
    const listenHost = stripBrackets(host.trim().toLowerCase());
    if (listenHost !== '0.0.0.0' && listenHost !== '::') this.allowedHosts.add(listenHost);
    this.allowedOrigins = new Set((config.allowedOrigins ?? []).map((o) => o.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean));
    this.maxBodyBytes = config.maxBodyBytes && config.maxBodyBytes > 0 ? Math.floor(config.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES;
  }

  /** CORS headers for an allowed origin (empty when the request has none). */
  corsHeaders(req: IncomingMessage): Record<string, string> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!origin || !this.allowedOrigins.has(origin.replace(/\/+$/, '').toLowerCase())) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      'Vary': 'Origin',
    };
  }

  /** Host, Origin and bearer checks for one request. */
  check(req: IncomingMessage): GuardDecision {
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== 'string' || !this.allowedHosts.has(hostName(hostHeader))) {
      return { ok: false, status: 421, message: 'Host not allowed' };
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !this.allowedOrigins.has(origin.replace(/\/+$/, '').toLowerCase())) {
      return { ok: false, status: 403, message: 'Origin not allowed' };
    }
    const auth = req.headers.authorization;
    const match = typeof auth === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
    if (match) {
      const principal = this.principals.get(digest(match[1]));
      if (principal) return { ok: true, principal };
      return { ok: false, status: 401, message: 'Invalid bearer token', headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } };
    }
    if (this.allowUnauthenticated) return { ok: true };
    return { ok: false, status: 401, message: 'Bearer token required', headers: { 'WWW-Authenticate': 'Bearer' } };
  }

  /**
   * Run the checks and answer the request when it fails or is a CORS
   * preflight. Returns the decision; the caller continues only on `ok`.
   */
  admit(req: IncomingMessage, res: ServerResponse): GuardDecision {
    if (req.method === 'OPTIONS') {
      const hostOk = typeof req.headers.host === 'string' && this.allowedHosts.has(hostName(req.headers.host));
      const cors = this.corsHeaders(req);
      if (!hostOk || !cors['Access-Control-Allow-Origin']) {
        res.writeHead(hostOk ? 403 : 421, { 'Content-Type': 'text/plain' }).end(hostOk ? 'Origin not allowed' : 'Host not allowed');
      } else {
        res.writeHead(204, {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
          'Access-Control-Max-Age': '600',
        }).end();
      }
      return { ok: false, status: 204, message: 'preflight' };
    }
    const decision = this.check(req);
    if (!decision.ok) {
      res.writeHead(decision.status, { 'Content-Type': 'application/json', ...(decision.headers ?? {}), ...this.corsHeaders(req) });
      res.end(JSON.stringify({ error: decision.message }));
    }
    return decision;
  }
}

/** Read a request body, refusing more than `limit` bytes. Resolves null after answering 413. */
export function readBody(req: IncomingMessage, res: ServerResponse, limit: number, headers: Record<string, string> = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) over = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) {
        res.writeHead(413, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify({ error: `Request body over ${limit} bytes` }));
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolve(null));
  });
}
