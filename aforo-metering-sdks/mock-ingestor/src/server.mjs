// Fault-injecting mock of the Aforo usage-ingestor (wave 5, G312).
//
// Zero dependencies, so every language's test suite can start it with plain
// `node`. It speaks the contract in ../../contract/ingest-contract.json:
// POST /v1/ingest/batch (and the /api/v1 alias) validated against
// schemas.ingestEvent and transportPolicy.batch, plus POST /api/v1/quota/check.
// Tests script faults over /__control/* and read back what was received.

import zlib from 'node:zlib';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONTRACT_PATH = path.resolve(HERE, '../../contract/ingest-contract.json');

const INGEST_PATHS = new Set(['/v1/ingest/batch', '/api/v1/ingest/batch']);
const QUOTA_PATH = '/api/v1/quota/check';

/** Loads the parts of the contract the mock enforces. */
export function loadContract(contractPath = DEFAULT_CONTRACT_PATH) {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const schema = contract.schemas?.ingestEvent;
  const policy = contract.transportPolicy;
  if (!schema || !policy) {
    throw new Error(`contract ${contractPath} has no schemas.ingestEvent / transportPolicy (need contract v2)`);
  }
  return {
    required: schema.required,
    properties: schema.properties,
    maxEvents: policy.batch.maxEvents,
    maxRequestBodyBytes: policy.batch.maxRequestBodyBytes,
  };
}

/** Problem-detail JSON, the shape the real ingestor uses for errors (not wrapped). */
function problem(status, title, detail) {
  return { type: 'about:blank', title, status, detail };
}

/** Validates one event; returns a message or null. Lengths are UTF-16 code units, like Java. */
export function validateEvent(event, rules) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return 'event must be an object';
  }
  for (const field of rules.required) {
    const v = event[field];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      return `${field} is required`;
    }
  }
  for (const [field, spec] of Object.entries(rules.properties)) {
    const v = event[field];
    if (v === undefined || v === null) continue;
    if (spec.type === 'string') {
      if (typeof v !== 'string') return `${field} must be a string`;
      if (spec.maxLength !== undefined && v.length > spec.maxLength) {
        return `${field} must be at most ${spec.maxLength} characters`;
      }
      if (spec.enum && !spec.enum.includes(v.toUpperCase())) return `${field} is not one of ${spec.enum.join(', ')}`;
      if (spec.format === 'date-time' && Number.isNaN(Date.parse(v))) return `${field} must be an ISO-8601 instant`;
    } else if (spec.type === 'number' || spec.type === 'integer') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${field} must be a number`;
      if (spec.exclusiveMinimum !== undefined && !(v > spec.exclusiveMinimum)) return `${field} must be positive`;
    }
  }
  return null;
}

/**
 * Starts the mock. Resolves to { url, port, close(), state() }.
 *
 * @param {object} [opts]
 * @param {number} [opts.port=0]        0 = any free port
 * @param {string} [opts.host='127.0.0.1']
 * @param {string} [opts.apiKey]        when set, X-API-Key must equal it (else any non-blank key)
 * @param {string} [opts.contractPath]
 */
export async function startMockIngestor(opts = {}) {
  const rules = loadContract(opts.contractPath);
  const st = freshState();
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, problem(500, 'Mock error', String(err?.message ?? err)));
      else res.destroy();
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  function freshState() {
    return {
      faults: [],
      quota: { decision: 'ALLOW', reason: 'Passed', delayMs: 0 },
      requests: [],
      events: [],
      keys: new Map(),
      duplicates: 0,
      inFlight: 0,
      maxInFlight: 0,
      quotaChecks: [],
    };
  }

  function send(res, status, body, headers = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json',
      'Content-Length': Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  }

  async function readBody(req, limit) {
    const chunks = [];
    let total = 0;
    let over = false;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) over = true; // keep reading so the client sees the 413, not a reset
      else chunks.push(chunk);
    }
    return { over, total, buf: over ? null : Buffer.concat(chunks) };
  }

  function nextFault(kind) {
    const i = st.faults.findIndex((f) => (f.match ?? 'ingest') === kind);
    if (i < 0) return null;
    const f = st.faults[i];
    if (f.times !== -1) {
      f.times = (f.times ?? 1) - 1;
      if (f.times <= 0) st.faults.splice(i, 1);
    }
    return f;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname.startsWith('/__control/')) return control(url.pathname, req, res);
    if (req.method === 'POST' && INGEST_PATHS.has(url.pathname)) return ingest(url.pathname, req, res);
    if (req.method === 'POST' && url.pathname === QUOTA_PATH) return quota(req, res);
    return send(res, 404, problem(404, 'Not Found', `${req.method} ${url.pathname} is not mapped`));
  }

  async function control(pathname, req, res) {
    if (pathname === '/__control/health') return send(res, 200, { ok: true });
    if (pathname === '/__control/state' && req.method === 'GET') return send(res, 200, publicState());
    if (pathname === '/__control/reset' && req.method === 'POST') {
      Object.assign(st, freshState());
      return send(res, 200, { ok: true });
    }
    const { buf } = await readBody(req, 1 << 20);
    const body = buf && buf.length ? JSON.parse(buf.toString('utf8')) : {};
    if (pathname === '/__control/faults' && req.method === 'POST') {
      const list = Array.isArray(body.faults) ? body.faults : [body];
      for (const f of list) st.faults.push({ ...f });
      return send(res, 200, { queued: st.faults.length });
    }
    if (pathname === '/__control/faults' && req.method === 'DELETE') {
      st.faults = [];
      return send(res, 200, { queued: 0 });
    }
    if (pathname === '/__control/quota' && req.method === 'POST') {
      st.quota = { decision: 'ALLOW', reason: 'Passed', delayMs: 0, ...body };
      return send(res, 200, st.quota);
    }
    return send(res, 404, problem(404, 'Not Found', pathname));
  }

  function publicState() {
    return {
      requests: st.requests,
      events: st.events,
      acceptedCount: st.events.length,
      uniqueKeys: st.keys.size,
      duplicates: st.duplicates,
      maxInFlight: st.maxInFlight,
      inFlight: st.inFlight,
      faultsRemaining: st.faults.length,
      quotaChecks: st.quotaChecks,
    };
  }

  async function applyTimingFault(fault, req, res) {
    if (!fault) return false;
    if (fault.delayMs) await sleep(fault.delayMs);
    if (fault.reset) {
      req.socket.destroy();
      return true;
    }
    if (fault.hang) {
      // Never answer; the client's timeout must fire. Closed on close().
      return true;
    }
    return false;
  }

  async function ingest(pathname, req, res) {
    st.inFlight += 1;
    st.maxInFlight = Math.max(st.maxInFlight, st.inFlight);
    const record = {
      at: new Date().toISOString(),
      path: pathname,
      contentType: req.headers['content-type'] ?? null,
      contentEncoding: req.headers['content-encoding'] ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      apiKeyPresent: Boolean(req.headers['x-api-key']),
      authorizationPresent: Boolean(req.headers['authorization']),
      bytes: 0,
      eventCount: 0,
      status: 0,
      idempotencyKeys: [],
    };
    st.requests.push(record);
    let hung = false;
    try {
      const { over, total, buf } = await readBody(req, rules.maxRequestBodyBytes);
      record.bytes = total;
      // Record what was sent before any fault is applied, so a test can
      // prove a retried batch carried the same keys as the failed attempt.
      // Like usage-ingestor's GzipRequestFilter (wave 8): gzip is decoded with the same
      // size cap on the decoded body; identity or no header is plain; anything else is 415.
      const coding = String(record.contentEncoding ?? '').trim().toLowerCase();
      let decoded = buf;
      let decodeError = null;
      if (buf && (coding === 'gzip' || coding === 'x-gzip')) {
        try {
          decoded = zlib.gunzipSync(buf, { maxOutputLength: rules.maxRequestBodyBytes });
        } catch (err) {
          decoded = null;
          decodeError = err && err.code === 'ERR_BUFFER_TOO_LARGE' ? 'too-large' : 'corrupt';
        }
      }
      record.decodedBytes = decoded ? decoded.length : null;
      if (decoded && (coding === '' || coding === 'identity' || coding === 'gzip' || coding === 'x-gzip')) {
        try {
          const peek = JSON.parse(decoded.toString('utf8'));
          if (Array.isArray(peek?.events)) {
            record.eventCount = peek.events.length;
            record.idempotencyKeys = peek.events.map((e) => e?.idempotencyKey ?? null);
          }
        } catch {
          // Malformed JSON is answered 400 below; nothing to record.
        }
      }
      const fault = nextFault('ingest');
      if (await applyTimingFault(fault, req, res)) {
        record.status = fault.reset ? -1 : -2;
        // A hung request stays in flight until the client gives up.
        hung = !fault.reset;
        return;
      }
      const reply = (status, body, headers) => {
        record.status = status;
        send(res, status, body, headers);
      };
      if (fault?.stallBody || fault?.dripMs) {
        // Headers and part of a 202 body, then either nothing more (stallBody)
        // or one byte every dripMs: the client's TOTAL deadline must fire.
        record.status = -3;
        hung = true;
        const text = JSON.stringify({ success: true, data: { accepted: 0, duplicates: 0, failed: 0, errors: [] }, meta: {} });
        res.writeHead(202, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.write(text.slice(0, 5));
        if (fault.dripMs) {
          let i = 5;
          const timer = setInterval(() => {
            if (i >= text.length || res.destroyed) {
              clearInterval(timer);
              if (!res.destroyed) res.end();
              return;
            }
            res.write(text[i]);
            i += 1;
          }, fault.dripMs);
          res.on('close', () => clearInterval(timer));
        }
        return;
      }
      if (fault?.status) {
        const headers = {};
        if (fault.retryAfter !== undefined) headers['Retry-After'] = String(fault.retryAfter);
        if (fault.location !== undefined) headers.Location = String(fault.location);
        return reply(fault.status, fault.body ?? problem(fault.status, 'Injected fault', `status ${fault.status}`), headers);
      }
      const key = req.headers['x-api-key'];
      if (!key || (opts.apiKey && key !== opts.apiKey)) return reply(401, problem(401, 'Unauthorized', 'missing or invalid X-API-Key'));
      if (over) return reply(413, problem(413, 'Payload Too Large', `request body exceeds ${rules.maxRequestBodyBytes} bytes`));
      if (coding !== '' && coding !== 'identity' && coding !== 'gzip' && coding !== 'x-gzip') {
        return reply(415, problem(415, 'Unsupported Content-Encoding', 'Send the body uncompressed or with Content-Encoding: gzip.'),
          { 'Accept-Encoding': 'gzip' });
      }
      if (decodeError === 'too-large') return reply(413, problem(413, 'Payload Too Large', `request body exceeds ${rules.maxRequestBodyBytes} bytes`));
      if (decodeError) return reply(400, problem(400, 'Bad Request', 'malformed gzip body'));
      if (!String(record.contentType ?? '').toLowerCase().includes('application/json')) {
        return reply(415, problem(415, 'Unsupported Media Type', 'Content-Type must be application/json'));
      }
      let parsed;
      try {
        parsed = JSON.parse(decoded.toString('utf8'));
      } catch {
        return reply(400, problem(400, 'Bad Request', 'malformed JSON'));
      }
      const events = parsed?.events;
      if (!Array.isArray(events) || events.length === 0) return reply(400, problem(400, 'Bad Request', 'events: At least one event is required'));
      if (events.length > rules.maxEvents) return reply(400, problem(400, 'Bad Request', `events: Maximum ${rules.maxEvents} events per batch`));
      record.eventCount = events.length;
      record.idempotencyKeys = events.map((e) => e?.idempotencyKey ?? null);

      const injected = new Map((fault?.perEvent ?? []).map((p) => [p.index, p]));
      const errors = [];
      let accepted = 0;
      let duplicates = 0;
      events.forEach((event, index) => {
        const inj = injected.get(index);
        if (inj) {
          errors.push({ index, message: inj.message ?? 'injected failure', retryable: Boolean(inj.retryable) });
          return;
        }
        const msg = validateEvent(event, rules);
        if (msg) {
          errors.push({ index, message: msg, retryable: false });
          return;
        }
        const dedupKey = `${key}\u0000${event.idempotencyKey}`;
        if (st.keys.has(dedupKey)) {
          duplicates += 1;
          st.duplicates += 1;
          return;
        }
        st.keys.set(dedupKey, true);
        st.events.push(event);
        accepted += 1;
      });
      return reply(202, {
        success: true,
        data: { accepted, duplicates, failed: errors.length, errors, killedSessionIds: fault?.killedSessionIds ?? [] },
        meta: {},
      });
    } finally {
      if (hung && !req.socket.destroyed) {
        req.socket.once('close', () => {
          st.inFlight -= 1;
        });
      } else {
        st.inFlight -= 1;
      }
    }
  }

  async function quota(req, res) {
    const { buf } = await readBody(req, 1 << 20);
    let body = {};
    try {
      body = buf && buf.length ? JSON.parse(buf.toString('utf8')) : {};
    } catch {
      return send(res, 400, problem(400, 'Bad Request', 'malformed JSON'));
    }
    st.quotaChecks.push(body);
    const fault = nextFault('quota');
    if (await applyTimingFault(fault, req, res)) return;
    if (fault?.status) return send(res, fault.status, problem(fault.status, 'Injected fault', `status ${fault.status}`));
    if (st.quota.delayMs) await sleep(st.quota.delayMs);
    const { decision, reason, retryAfterMs, limit, currentUsage } = st.quota;
    return send(res, 200, { success: true, data: { decision, reason, retryAfterMs, limit, currentUsage }, meta: {} });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const host = opts.host ?? '127.0.0.1';
  return {
    port,
    url: `http://${host === '::1' ? '[::1]' : host}:${port}`,
    state: publicState,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r()));
    },
  };
}
