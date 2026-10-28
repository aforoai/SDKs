/**
 * Aforo Node transport core (wave 5, contract v2).
 *
 * THE ONE PLACE TO EDIT. This file lives in `node/src/transport-core/` and is
 * copied, byte for byte, into every Node variant (`node-ws`, `node-mqtt`,
 * `node-grpc`, `node-graphql`, `node-mcp`, `node-agent`, `mcp-proxy`) by
 * `scripts/sync-transport.sh node`. Edit it here, then run the sync; CI fails
 * when a copy differs. Normative behaviour: `contract/TRANSPORT-SPEC.md`.
 *
 * Self-contained on purpose: no imports (not even relative ones, so every
 * module format and test runner that receives the copy can load it), only
 * Node built-ins reached through globals (`fetch`, `AbortSignal`, `Buffer`,
 * timers). Target ES2020.
 *
 * What it does, per client:
 *   - one bounded FIFO queue (evict-oldest, reported as 'overflow');
 *   - one long-lived flusher: `enqueue()` never sends, it only wakes the
 *     flusher at `flushCount`; `flush()` hands work to the flusher and waits;
 *     at most one ingest request is ever in flight;
 *   - full-jitter retries, Retry-After in both forms (capped), a total
 *     deadline per request that also covers reading the response body;
 *   - redirects are never followed (the API key must not reach another
 *     host): a 3xx keeps the batch queued and opens the breaker;
 *   - each event is serialized once, at enqueue: an event JSON cannot
 *     represent (BigInt, a cycle, NaN) is dropped there as 'invalid';
 *   - 413 splits the batch, 2xx per-event `retryable` failures are requeued,
 *     other 4xx are dropped as 'rejected';
 *   - after the last retry (or on 401/403) the batch goes back to the front
 *     of the queue with its keys and a breaker pauses the flusher;
 *   - `shutdown()` drains until a deadline and reports leftovers as
 *     'shutdown'; `enqueue()` after close reports 'closed';
 *   - no signal handlers: a process `beforeExit` hook flushes within the
 *     shutdown deadline. Apps call `shutdown()` from their own SIGTERM handler;
 *   - `onAccepted(body, events)` sees the parsed 2xx body of every accepted
 *     batch (for fields such as `killedSessionIds`); `onError` receives a
 *     `CoreTransportError` whose `kind` says what happened.
 */

/** Why events were permanently dropped. See TRANSPORT-SPEC.md "Drop reasons". */
export type CoreDropReason = 'overflow' | 'rejected' | 'invalid' | 'shutdown' | 'closed' | 'retry_exhausted';

/**
 * What an onError report is about. `outage` and `auth` keep the events queued
 * (`willRetry` true); the others describe events that are gone.
 *   - outage:   network errors, timeouts, 408/429/5xx after every retry, or
 *               per-event `retryable` failures that never cleared
 *   - auth:     HTTP 401/403, the API key is wrong or revoked
 *   - rejected: the ingestor refused the events (other 4xx, 2xx per-event errors, a single event still 413)
 *   - shutdown: still queued when the shutdown deadline passed
 *   - closed:   tracked after shutdown (reported for the first, then every 1000th)
 */
export type CoreErrorKind = 'outage' | 'auth' | 'rejected' | 'shutdown' | 'closed';

/**
 * The error every onError report receives. `message` is for people; branch on
 * `kind`. `events` are the events concerned: the queued ones for outage/auth,
 * the dropped ones otherwise (empty when the ingestor did not name them).
 */
export class CoreTransportError<E = CoreEvent> extends Error {
  readonly kind: CoreErrorKind;
  readonly events: E[];
  /** HTTP status of the answer that caused the report, when there was one. */
  readonly status?: number;
  /** True when the events are still queued and will be re-sent. */
  readonly willRetry: boolean;

  constructor(kind: CoreErrorKind, message: string, events: E[], options: { status?: number } = {}) {
    super(message);
    this.name = 'CoreTransportError';
    this.kind = kind;
    this.events = events.slice();
    if (options.status !== undefined) this.status = options.status;
    this.willRetry = kind === 'outage' || kind === 'auth';
  }
}

/** Every event the core sends carries the key the ingestor deduplicates on. */
export interface CoreEvent {
  idempotencyKey: string;
}

/** The subset of a fetch Response the core reads. */
export interface CoreResponse {
  status: number;
  ok?: boolean;
  headers: { get(name: string): string | null };
  text?(): Promise<string>;
  json?(): Promise<unknown>;
}

/** The subset of fetch the core calls. Injectable for tests. */
export type CoreFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'manual' },
) => Promise<CoreResponse>;

/** Sleep that ends early (resolving) when `signal` aborts. Injectable for tests. */
export type CoreSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface CoreLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TransportCoreOptions<E extends CoreEvent> {
  /** Ingestor base URL. Must be https:// (plain http only for localhost, 127.0.0.1, ::1, or with allowInsecureHttp). */
  baseUrl: string;
  /** Tenant API key, sent only as X-API-Key. Never logged, never in an error or onDrop payload. */
  apiKey: string;
  /** Allow plain http:// to a non-local host. Default false. */
  allowInsecureHttp?: boolean;
  /** Path appended to baseUrl. Default '/v1/ingest/batch'. */
  path?: string;
  /** Sent as User-Agent, e.g. 'aforo-node/2.0.0'. */
  userAgent?: string;
  /** Extra request headers (e.g. X-Tenant-Id). Content-Type, X-API-Key and Content-Encoding cannot be overridden. */
  headers?: Record<string, string>;
  /** Events per request. Default 500, clamped to 1..1000. */
  flushCount?: number;
  /** Flush at least this often, in ms. Default 5000. */
  flushIntervalMs?: number;
  /** Queue capacity. Default 10 000. Overflow evicts the oldest event. */
  maxQueueSize?: number;
  /** Retries per batch before the breaker opens. Default 3. */
  maxRetries?: number;
  /** Backoff base in ms. Default 500. */
  retryBaseMs?: number;
  /** Backoff cap in ms. Default 30 000. */
  retryMaxDelayMs?: number;
  /** Retry-After cap in ms. Default 60 000. */
  retryAfterMaxMs?: number;
  /** First breaker cooldown in ms. Default 5000 (doubles, full jitter). */
  breakerInitialMs?: number;
  /** Breaker cooldown cap in ms. Default 300 000. */
  breakerMaxMs?: number;
  /** Total deadline per request in ms. Default 10 000. */
  timeoutMs?: number;
  /** shutdown() deadline in ms. Default 5000. */
  shutdownTimeoutMs?: number;
  /** Split a batch whose JSON body exceeds this many bytes. Default 4 MiB. */
  targetRequestBodyBytes?: number;
  /** Flush on the process 'beforeExit' event (within shutdownTimeoutMs). Default true. */
  flushOnExit?: boolean;
  /** Receives events that are lost for good. A throw is caught and logged. */
  onDrop?: (events: E[], reason: CoreDropReason, detail?: string) => void;
  /**
   * Receives failures worth surfacing: breaker openings (`outage`, `auth`),
   * rejections, shutdown leftovers and post-close tracking. Branch on
   * `error.kind`, never on the message. A throw is caught and logged.
   */
  onError?: (error: CoreTransportError<E>) => void;
  /**
   * Called after every accepted (2xx) batch with the response body, the
   * `{success, data}` envelope already unwrapped (`undefined` when the body was
   * empty or not JSON), and the events of that batch. Use it to read fields
   * such as `killedSessionIds`. A throw is caught and logged.
   */
  onAccepted?: (body: unknown, events: E[]) => void;
  /** Log sink. Default: console with `logPrefix` (debug lines only when AFORO_DEBUG is set). */
  logger?: CoreLogger;
  /** Prefix for default log lines. Default '[aforo]'. */
  logPrefix?: string;
  /** Injectable for tests. Default: the global fetch, looked up on every request. */
  fetch?: CoreFetch;
  /** Injectable for tests. Default Date.now. */
  clock?: () => number;
  /** Injectable for tests. Default: an unref'd timer that ends when the signal aborts. */
  sleep?: CoreSleep;
  /** Injectable for tests. Default Math.random. */
  random?: () => number;
}

/** What one flush cycle did. */
export interface CoreFlushResult {
  /** Events the ingestor accepted (including duplicates it already had). */
  sent: number;
  /** Events dropped for good in this cycle. */
  failed: number;
  /** Events put back on the queue (outage or per-event retryable). */
  requeued: number;
  /** Events still queued when the cycle ended. */
  queued: number;
}

/** What shutdown() did. */
export interface CoreShutdownResult extends CoreFlushResult {
  /** Events still queued at the deadline, reported as 'shutdown'. */
  leftover: number;
  /** True when the deadline passed before the queue was empty. */
  timedOut: boolean;
}

export const CORE_DEFAULTS = Object.freeze({
  path: '/v1/ingest/batch',
  flushCount: 500,
  maxBatchEvents: 1000,
  flushIntervalMs: 5000,
  maxQueueSize: 10000,
  maxRetries: 3,
  retryBaseMs: 500,
  retryMaxDelayMs: 30000,
  retryAfterMaxMs: 60000,
  breakerInitialMs: 5000,
  breakerMaxMs: 300000,
  timeoutMs: 10000,
  shutdownTimeoutMs: 5000,
  targetRequestBodyBytes: 4 * 1024 * 1024,
});

const RETRY_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);
const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);
/** Smallest breaker cooldown, so a 401/3xx loop can never spin. */
const BREAKER_FLOOR_MS = 250;

/** A 3xx (or the opaque-redirect status 0 some fetch implementations return for redirect: 'manual'). */
function isRedirect(status: number): boolean {
  return status === 0 || (status >= 300 && status < 400);
}

/** Host of a Location header, for the log line. Never the full URL (it could carry a query string). */
function redirectTarget(location: string | null | undefined, base: string): string {
  if (!location) return 'no Location header';
  try {
    return new URL(location, base).host || 'an unknown host';
  } catch {
    return 'an unparseable Location header';
  }
}

/**
 * JSON for one event, or a reason why it has none. BigInt and cycles make
 * JSON.stringify throw; NaN and Infinity would silently become null, which
 * the ingestor would then reject or misread, so they are refused here too.
 */
function serializeEvent(event: unknown): { json: string } | { error: string } {
  try {
    const json = JSON.stringify(event, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new TypeError(`a number field is ${String(value)}, which JSON cannot represent`);
      }
      return value;
    });
    if (typeof json !== 'string') return { error: 'the event is not a JSON object' };
    return { json };
  } catch (err) {
    const e = err as { message?: string };
    return { error: `the event cannot be serialized to JSON (${String(e?.message ?? err).slice(0, 200)})` };
  }
}

/** Resolves with `promise`, or rejects as soon as `signal` aborts (even if `promise` never settles). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * Throws when `baseUrl` is not https:// (plain http only for a local host or
 * with `allowInsecureHttp`). Returns the URL without trailing slashes.
 */
export function checkBaseUrl(baseUrl: string, allowInsecureHttp = false): string {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error('Aforo ingestor URL is required (for example https://api.aforo.ai)');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error(`Aforo ingestor URL is not a valid URL: ${JSON.stringify(baseUrl.slice(0, 200))}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Aforo ingestor URL must not contain credentials; pass the API key as apiKey');
  }
  if (parsed.protocol === 'http:') {
    if (!allowInsecureHttp && !LOCAL_HOSTS.has(parsed.hostname)) {
      throw new Error(
        `Aforo ingestor URL must use https:// (got http://${parsed.host}). Plain http is allowed only for ` +
          'localhost, 127.0.0.1 and ::1, or with allowInsecureHttp: true.',
      );
    }
  } else if (parsed.protocol !== 'https:') {
    throw new Error(`Aforo ingestor URL must use https:// (got ${parsed.protocol}//)`);
  }
  return baseUrl.trim().replace(/\/+$/, '');
}

/** Full-jitter backoff: random(0, min(maxDelay, base * 2^attempt)). */
export function fullJitter(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const ceiling = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  return Math.floor(clamp01(random()) * ceiling);
}

/**
 * Retry-After in ms: delta-seconds or an HTTP-date, capped at `maxMs`.
 * Undefined when absent or unreadable (the caller then uses its own delay).
 */
export function parseRetryAfter(value: string | null | undefined, now: number, maxMs: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.min(Math.round(Number(text) * 1000), maxMs);
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - now), maxMs);
}

/** Sleep on an unref'd timer; resolves early when `signal` aborts. */
export const defaultSleep: CoreSleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    unref(timer);
    signal?.addEventListener('abort', done, { once: true });
  });

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 0.999999999) : 0;
}

function unref(timer: unknown): void {
  const t = timer as { unref?: () => void } | null;
  if (t && typeof t.unref === 'function') t.unref();
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const cause = e.cause?.code ?? e.cause?.message;
    return `${e.name ?? 'Error'}: ${e.message ?? ''}${cause ? ` (${cause})` : ''}`.slice(0, 300);
  }
  return String(err).slice(0, 300);
}

/** The ingestor wraps 2xx bodies in {success, data, meta}; return `data` when present. */
function unwrapEnvelope(body: unknown): any {
  const b = body as any;
  const data = b && typeof b === 'object' && !Array.isArray(b) ? b.data : undefined;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : b;
}

/**
 * Bounded FIFO deque over a circular array. Back = newest, front = oldest.
 * Not exported: the core owns the only instance.
 */
class EventDeque<E> {
  private readonly items: Array<E | undefined>;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.items = new Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Append; on overflow evict and return the oldest. */
  pushBack(event: E): E | undefined {
    let evicted: E | undefined;
    if (this.count === this.capacity) {
      evicted = this.items[this.head];
      this.items[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }
    this.items[(this.head + this.count) % this.capacity] = event;
    this.count++;
    return evicted;
  }

  /**
   * Put `events` back at the front, in order (events[0] ends up first).
   * They are older than anything queued, so when space runs out the oldest
   * of them are the ones that do not fit; those are returned.
   */
  pushFront(events: E[]): E[] {
    const overflow: E[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      if (this.count === this.capacity) {
        overflow.unshift(...events.slice(0, i + 1));
        break;
      }
      this.head = (this.head - 1 + this.capacity) % this.capacity;
      this.items[this.head] = events[i];
      this.count++;
    }
    return overflow;
  }

  /** Remove and return up to `max` events from the front. */
  take(max: number): E[] {
    const n = Math.min(max, this.count);
    const out: E[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.items[this.head] as E;
      this.items[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
    }
    this.count -= n;
    return out;
  }

  /** Remove and return everything. */
  drainAll(): E[] {
    return this.take(this.count);
  }
}

/** Outcome of sending one chunk. */
type SendOutcome =
  | { kind: 'done'; sent: number; failed: number; retryable: unknown[] }
  | { kind: 'split' }
  | { kind: 'outage'; status?: number; reason: string; redirectTo?: string }
  | { kind: 'deadline' };

// One process 'beforeExit' listener per copy of this file, shared by every live core.
const liveCores = new Set<TransportCore<any>>();
let exitHookInstalled = false;

/**
 * The event loop has nothing left to do. Every core that still holds events
 * (queued, or a batch it is sending or waiting to retry) shuts down and keeps
 * the process alive until that finishes or its shutdown deadline passes. The
 * core's own timers are unref'd, so without the keep-alive the process would
 * exit in the middle of a retry and lose the batch. Idle cores stay
 * registered: the app may still track events later.
 */
function onBeforeExit(): void {
  for (const core of Array.from(liveCores)) core.flushForExit();
}

function registerExitHook(core: TransportCore<any>): void {
  liveCores.add(core);
  if (!exitHookInstalled && typeof process !== 'undefined' && typeof process.on === 'function') {
    process.on('beforeExit', onBeforeExit);
    exitHookInstalled = true;
  }
}

function unregisterExitHook(core: TransportCore<any>): void {
  liveCores.delete(core);
  if (liveCores.size === 0 && exitHookInstalled) {
    process.removeListener('beforeExit', onBeforeExit);
    exitHookInstalled = false;
  }
}

/**
 * The Node transport core. One instance per SDK client.
 *
 * ```ts
 * const core = new TransportCore<MyEvent>({ baseUrl, apiKey, onDrop });
 * core.enqueue(event);          // never sends, never throws
 * await core.flush();           // waits for the flusher to drain the queue
 * await core.shutdown();        // drains until shutdownTimeoutMs, reports leftovers
 * ```
 */
export class TransportCore<E extends CoreEvent> {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly flushCount: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryAfterMaxMs: number;
  private readonly breakerInitialMs: number;
  private readonly breakerMaxMs: number;
  private readonly timeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly targetBytes: number;
  private readonly fetchFn: CoreFetch;
  private readonly clock: () => number;
  private readonly sleepFn: CoreSleep;
  private readonly random: () => number;
  private readonly logger: CoreLogger;
  private readonly onDrop?: (events: E[], reason: CoreDropReason, detail?: string) => void;
  private readonly onError?: (error: CoreTransportError<E>) => void;
  private readonly onAccepted?: (body: unknown, events: E[]) => void;
  private readonly queue: EventDeque<E>;

  private dropped = 0;
  private overflowDrops = 0;
  private invalidDrops = 0;
  private closedDrops = 0;
  private sentTotal = 0;
  private inFlight = 0;

  private closedFlag = false;
  private deadline = Infinity;
  private readonly stopController = new AbortController();

  /** Aborted to wake the flusher from its idle wait (replaced after each wake). */
  private idleWake = new AbortController();
  /** Aborted to cut a breaker wait short (explicit flush / shutdown). */
  private breakerWake = new AbortController();
  private breakerOpens = 0;
  private breakerOpen = false;
  /** ERROR line for this breaker opening (401/403 or a redirect) already written. */
  private configErrorLogged = false;

  private flushWaiters: Array<(r: CoreFlushResult) => void> = [];
  private readonly loop: Promise<void>;
  private shutdownPromise: Promise<CoreShutdownResult> | null = null;
  private readonly closingTotals = { sent: 0, failed: 0, requeued: 0 };
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-event retryable failures seen so far, keyed by event object. */
  private readonly perEventRetries = new WeakMap<object, number>();
  /** Highest per-event retry count in the last requeue, for the backoff before the resend. */
  private perEventAttempt = 0;
  /** Each queued event's JSON, taken at enqueue. */
  private readonly serialized = new WeakMap<object, string>();
  /** Events taken off the queue that are being sent or waiting for a retry. */
  private eventsInHand = 0;
  private shutdownSettled = false;
  private exitKeepAlive: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TransportCoreOptions<E>) {
    if (!options || typeof options.apiKey !== 'string' || !options.apiKey.trim()) {
      throw new Error('Aforo apiKey is required');
    }
    const base = checkBaseUrl(options.baseUrl, options.allowInsecureHttp === true);
    const path = options.path ?? CORE_DEFAULTS.path;
    this.url = base + (path.startsWith('/') ? path : `/${path}`);
    const apiKey = options.apiKey;
    this.headers = {
      ...(options.headers ?? {}),
      ...(options.userAgent ? { 'User-Agent': options.userAgent } : {}),
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    };
    // Header names are case-insensitive: drop any caller copy of the reserved ones.
    for (const name of Object.keys(this.headers)) {
      const lower = name.toLowerCase();
      if ((lower === 'x-api-key' && name !== 'X-API-Key') || (lower === 'content-type' && name !== 'Content-Type') || lower === 'content-encoding' || lower === 'authorization') {
        delete this.headers[name];
      }
    }
    // The key lives only in this non-enumerable header map.
    Object.defineProperty(this, 'headers', { enumerable: false });

    this.flushCount = Math.max(1, Math.min(Math.floor(options.flushCount ?? CORE_DEFAULTS.flushCount), CORE_DEFAULTS.maxBatchEvents));
    this.flushIntervalMs = Math.max(1, options.flushIntervalMs ?? CORE_DEFAULTS.flushIntervalMs);
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? CORE_DEFAULTS.maxRetries));
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? CORE_DEFAULTS.retryBaseMs);
    this.retryMaxDelayMs = Math.max(0, options.retryMaxDelayMs ?? CORE_DEFAULTS.retryMaxDelayMs);
    this.retryAfterMaxMs = Math.max(0, options.retryAfterMaxMs ?? CORE_DEFAULTS.retryAfterMaxMs);
    this.breakerInitialMs = Math.max(1, options.breakerInitialMs ?? CORE_DEFAULTS.breakerInitialMs);
    this.breakerMaxMs = Math.max(this.breakerInitialMs, options.breakerMaxMs ?? CORE_DEFAULTS.breakerMaxMs);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? CORE_DEFAULTS.timeoutMs);
    this.shutdownTimeoutMs = Math.max(0, options.shutdownTimeoutMs ?? CORE_DEFAULTS.shutdownTimeoutMs);
    this.targetBytes = Math.max(1024, options.targetRequestBodyBytes ?? CORE_DEFAULTS.targetRequestBodyBytes);
    this.queue = new EventDeque<E>(Math.max(1, Math.floor(options.maxQueueSize ?? CORE_DEFAULTS.maxQueueSize)));
    this.fetchFn = options.fetch ?? ((url, init) => (globalThis as any).fetch(url, init));
    this.clock = options.clock ?? Date.now;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onDrop = options.onDrop;
    this.onError = options.onError;
    this.onAccepted = options.onAccepted;
    const prefix = options.logPrefix ?? '[aforo]';
    this.logger = options.logger ?? {
      // Debug lines only with AFORO_DEBUG set, so a library never fills stdout by default.
      debug: (m) => {
        if (typeof process !== 'undefined' && process.env && process.env.AFORO_DEBUG) console.debug(`${prefix} ${m}`);
      },
      warn: (m) => console.warn(`${prefix} ${m}`),
      error: (m) => console.error(`${prefix} ${m}`),
    };

    if (options.flushOnExit !== false) registerExitHook(this);
    this.loop = this.run().catch((err) => {
      // run() handles its own errors; this is a last-resort guard.
      this.logger.error(`metering flusher stopped unexpectedly: ${errorText(err)}`);
    });
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Queue an event. Never sends and never throws. The event is serialized
   * now, so later changes to the object are not sent; one JSON cannot
   * represent is reported through onDrop(…, 'invalid'). After shutdown the
   * event is reported through onDrop(…, 'closed'). Returns false in both cases.
   */
  enqueue(event: E): boolean {
    if (this.closedFlag) {
      const before = this.closedDrops;
      this.recordDrop([event], 'closed', 'client is shut down');
      if (before === 0 || Math.floor(this.closedDrops / 1000) > Math.floor(before / 1000)) {
        this.reportError(
          new CoreTransportError('closed', `Aforo metering is shut down: event tracked after shutdown was dropped (${this.closedDrops} so far)`, [event]),
        );
      }
      return false;
    }
    const encoded = serializeEvent(event);
    if ('error' in encoded) {
      this.recordDrop([event], 'invalid', encoded.error);
      return false;
    }
    this.serialized.set(event as unknown as object, encoded.json);
    const evicted = this.queue.pushBack(event);
    if (evicted !== undefined) this.recordDrop([evicted], 'overflow');
    if (this.queue.size >= this.flushCount) this.wakeIdle();
    return true;
  }

  /** Count and report events the caller rejected before queueing (reason 'invalid' or another). */
  reportDrop(events: E[], reason: CoreDropReason, detail?: string): void {
    this.recordDrop(events, reason, detail);
  }

  /**
   * Hand the queue to the flusher and wait for one drain cycle. Never runs a
   * second concurrent send. While the breaker is open this makes one attempt
   * now instead of waiting for the cooldown.
   */
  flush(): Promise<CoreFlushResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise.then((r) => ({ sent: r.sent, failed: r.failed, requeued: r.requeued, queued: r.queued }));
    }
    return new Promise<CoreFlushResult>((resolve) => {
      this.flushWaiters.push(resolve);
      this.wakeIdle();
      this.wakeBreaker();
    });
  }

  /**
   * Stop accepting events and drain until `shutdownTimeoutMs`. Each request
   * in that window uses min(timeoutMs, time left). Events still queued at the
   * deadline are reported through onDrop(…, 'shutdown'). Idempotent.
   */
  shutdown(): Promise<CoreShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closedFlag = true;
    this.deadline = this.clock() + this.shutdownTimeoutMs;
    this.deadlineTimer = setTimeout(() => this.stopController.abort(), this.shutdownTimeoutMs);
    unref(this.deadlineTimer);
    this.wakeIdle();
    this.wakeBreaker();
    this.shutdownPromise = this.loop.then(() => {
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      const leftovers = this.queue.drainAll();
      if (leftovers.length > 0) {
        const detail = `still queued when the ${this.shutdownTimeoutMs} ms shutdown deadline passed`;
        this.recordDrop(leftovers, 'shutdown', detail);
        this.reportError(new CoreTransportError('shutdown', `Aforo metering shutdown dropped ${leftovers.length} event(s) ${detail}`, leftovers));
      }
      unregisterExitHook(this);
      this.shutdownSettled = true;
      if (this.exitKeepAlive) {
        clearTimeout(this.exitKeepAlive);
        this.exitKeepAlive = null;
      }
      const t = this.closingTotals;
      const result: CoreShutdownResult = {
        sent: t.sent,
        failed: t.failed + leftovers.length,
        requeued: t.requeued,
        queued: 0,
        leftover: leftovers.length,
        timedOut: leftovers.length > 0,
      };
      // Anyone still waiting on flush() gets the final state.
      const late = this.flushWaiters;
      this.flushWaiters = [];
      for (const resolve of late) resolve({ sent: result.sent, failed: result.failed, requeued: result.requeued, queued: 0 });
      return result;
    });
    return this.shutdownPromise;
  }

  /** Events waiting in the queue. */
  get queued(): number {
    return this.queue.size;
  }

  /** Events lost for good since creation (every reason, including unattributed per-event rejections). */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Events the ingestor accepted since creation. */
  get sentCount(): number {
    return this.sentTotal;
  }

  /** True after shutdown() was called. */
  get closed(): boolean {
    return this.closedFlag;
  }

  /** True while the breaker pauses the flusher after an outage. */
  get isBreakerOpen(): boolean {
    return this.breakerOpen;
  }

  /** Ingest requests in flight right now (0 or 1). */
  get inFlightRequests(): number {
    return this.inFlight;
  }

  /** True while events are queued or a taken batch is being sent / retried. */
  get busy(): boolean {
    return this.queue.size > 0 || this.eventsInHand > 0;
  }

  /**
   * @internal Called from the process 'beforeExit' hook. When this core still
   * holds events (or a shutdown is already running), it shuts down and holds
   * the event loop open with one timer until the shutdown settles. Never
   * longer than the shutdown deadline plus a second.
   */
  flushForExit(): void {
    if (this.shutdownSettled || this.exitKeepAlive) return;
    if (!this.busy && !this.shutdownPromise) return;
    const left = this.shutdownPromise ? Math.max(0, this.deadline - this.clock()) : this.shutdownTimeoutMs;
    this.exitKeepAlive = setTimeout(() => {
      this.exitKeepAlive = null;
    }, left + 1000);
    this.shutdown().catch((err) => this.logDebug(`shutdown on beforeExit failed: ${errorText(err)}`));
  }

  /** @internal Debug log, used by the exit hook. */
  logDebug(message: string): void {
    try {
      this.logger.debug(message);
    } catch {
      /* a logger must never break metering */
    }
  }

  toJSON(): Record<string, unknown> {
    return { url: this.url, queued: this.queued, dropped: this.dropped, closed: this.closedFlag };
  }

  [INSPECT](): string {
    return `TransportCore { url: '${this.url}', queued: ${this.queued}, dropped: ${this.dropped}, closed: ${this.closedFlag}, apiKey: '[redacted]' }`;
  }

  // ── Flusher ──────────────────────────────────────────────────────

  private wakeIdle(): void {
    if (!this.idleWake.signal.aborted) this.idleWake.abort();
  }

  private wakeBreaker(): void {
    if (!this.breakerWake.signal.aborted) this.breakerWake.abort();
  }

  private get pastDeadline(): boolean {
    return this.clock() >= this.deadline || this.stopController.signal.aborted;
  }

  private async run(): Promise<void> {
    let backoff = false;
    for (;;) {
      if (!this.closedFlag && this.flushWaiters.length === 0) {
        if (this.breakerOpen) {
          await this.waitBreaker();
        } else if (backoff) {
          // The last cycle put per-event retryable events back: wait before resending them.
          await this.waitBackoff();
        } else if (this.queue.size < this.flushCount) {
          await this.waitIdle();
        }
      } else if (this.closedFlag && (this.breakerOpen || backoff) && !this.pastDeadline) {
        // Shutting down during an outage: keep trying until the deadline, with a short pause.
        await this.sleepFn(
          Math.min(fullJitter(0, this.retryBaseMs, this.retryMaxDelayMs, this.random), Math.max(0, this.deadline - this.clock())),
          this.stopController.signal,
        );
      }
      const waiters = this.flushWaiters;
      this.flushWaiters = [];
      const result = await this.drainCycle();
      backoff = result.requeued > 0 && !this.breakerOpen;
      if (this.closedFlag) {
        this.closingTotals.sent += result.sent;
        this.closingTotals.failed += result.failed;
        this.closingTotals.requeued += result.requeued;
      }
      for (const resolve of waiters) {
        try {
          resolve(result);
        } catch (err) {
          this.logDebug(`flush waiter failed: ${errorText(err)}`);
        }
      }
      if (this.closedFlag && (this.queue.size === 0 || this.pastDeadline)) return;
    }
  }

  private async waitBackoff(): Promise<void> {
    if (this.breakerWake.signal.aborted) this.breakerWake = new AbortController();
    const wake = this.breakerWake;
    // The normal jittered backoff, growing with how often these events came back retryable.
    const delay = fullJitter(Math.max(0, this.perEventAttempt - 1), this.retryBaseMs, this.retryMaxDelayMs, this.random);
    await this.sleepFn(Math.max(1, delay), wake.signal);
    if (wake.signal.aborted) this.breakerWake = new AbortController();
  }

  private async waitIdle(): Promise<void> {
    if (this.idleWake.signal.aborted) this.idleWake = new AbortController();
    const wake = this.idleWake;
    if (this.queue.size >= this.flushCount) return;
    await this.sleepFn(this.flushIntervalMs, wake.signal);
    if (wake.signal.aborted) this.idleWake = new AbortController();
  }

  private async waitBreaker(): Promise<void> {
    if (this.breakerWake.signal.aborted) this.breakerWake = new AbortController();
    const wake = this.breakerWake;
    const ceiling = Math.min(this.breakerMaxMs, this.breakerInitialMs * Math.pow(2, Math.max(0, this.breakerOpens - 1)));
    // Full jitter with a floor, so a 401/3xx loop cannot spin: max(250 ms, random(0, ceiling)).
    const cooldown = Math.max(BREAKER_FLOOR_MS, Math.floor(clamp01(this.random()) * ceiling));
    this.logDebug(`breaker open: next attempt in ${cooldown} ms (${this.queue.size} queued)`);
    await this.sleepFn(cooldown, wake.signal);
    if (wake.signal.aborted) this.breakerWake = new AbortController();
  }

  /** Send everything queued, one request at a time. Stops on outage or deadline. */
  private async drainCycle(): Promise<CoreFlushResult> {
    const result: CoreFlushResult = { sent: 0, failed: 0, requeued: 0, queued: 0 };
    try {
      while (this.queue.size > 0) {
        if (this.closedFlag && this.pastDeadline) break;
        const batch = this.queue.take(this.flushCount);
        this.eventsInHand = batch.length;
        let stop: boolean;
        try {
          stop = await this.sendBatch(batch, result);
        } finally {
          this.eventsInHand = 0;
        }
        if (stop) break;
      }
    } catch (err) {
      this.logger.error(`metering flush failed unexpectedly: ${errorText(err)}`);
    }
    result.queued = this.queue.size;
    return result;
  }

  /**
   * Send one batch (splitting it when the body is too large or the ingestor
   * answers 413). Returns true when the cycle must stop (outage or deadline);
   * unsent events are already back at the front of the queue then.
   */
  private async sendBatch(batch: E[], result: CoreFlushResult): Promise<boolean> {
    const pending: E[][] = [batch];
    while (pending.length > 0) {
      const chunk = pending.shift() as E[];
      const body = this.bodyFor(chunk);
      if (chunk.length > 1 && byteLength(body) > this.targetBytes) {
        const mid = Math.ceil(chunk.length / 2);
        pending.unshift(chunk.slice(0, mid), chunk.slice(mid));
        continue;
      }
      const outcome = await this.sendWithRetry(chunk, body);
      if (outcome.kind === 'split') {
        if (chunk.length === 1) {
          this.recordDrop(chunk, 'rejected', 'HTTP 413: a single event is larger than the ingestor accepts');
          result.failed += 1;
          this.reportError(
            new CoreTransportError('rejected', 'Aforo ingestor rejected an event with HTTP 413 (request too large); the event was dropped', chunk, { status: 413 }),
          );
        } else {
          const mid = Math.ceil(chunk.length / 2);
          pending.unshift(chunk.slice(0, mid), chunk.slice(mid));
        }
        continue;
      }
      if (outcome.kind === 'done') {
        result.sent += outcome.sent;
        result.failed += outcome.failed;
        this.sentTotal += outcome.sent;
        if (outcome.retryable.length > 0) {
          const again = outcome.retryable as E[];
          result.requeued += again.length;
          let exhausted = false;
          let highest = 0;
          for (const e of again) {
            const n = (this.perEventRetries.get(e as unknown as object) ?? 0) + 1;
            this.perEventRetries.set(e as unknown as object, n);
            highest = Math.max(highest, n);
            if (n > this.maxRetries) exhausted = true;
          }
          this.perEventAttempt = highest;
          const remaining = ([] as E[]).concat(again, ...pending);
          this.requeue(remaining);
          if (exhausted) {
            // The retry cap was reached: an outage. This 2xx does not count as
            // the recovery that resets the breaker, so cooldowns keep growing.
            this.openBreaker(undefined, 'the ingestor kept reporting events as retryable', remaining);
          } else {
            this.closeBreaker();
          }
          // End the cycle; the flusher waits the backoff before resending.
          return true;
        }
        this.closeBreaker();
        continue;
      }
      // outage or deadline: put this chunk and everything not yet sent back in front.
      const unsent = ([] as E[]).concat(chunk, ...pending);
      result.requeued += unsent.length;
      this.requeue(unsent);
      if (outcome.kind === 'outage') this.openBreaker(outcome.status, outcome.reason, unsent, outcome.redirectTo);
      return true;
    }
    return false;
  }

  /** Request body from the JSON taken at enqueue. */
  private bodyFor(chunk: E[]): string {
    const parts: string[] = new Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      const cached = this.serialized.get(chunk[i] as unknown as object);
      // Every queued event passed enqueue(); the fallback covers events placed by reportDrop paths only.
      parts[i] = cached ?? JSON.stringify(chunk[i]);
    }
    return `{"events":[${parts.join(',')}]}`;
  }

  private requeue(events: E[]): void {
    const overflow = this.queue.pushFront(events);
    if (overflow.length > 0) this.recordDrop(overflow, 'overflow');
  }

  /** `kept` are the events just put back on the queue (named in the onError report). */
  private openBreaker(status: number | undefined, reason: string, kept: E[], redirectTo?: string): void {
    const first = !this.breakerOpen;
    this.breakerOpen = true;
    this.breakerOpens += 1;
    if (redirectTo !== undefined) {
      // Once per breaker opening. A redirect means the base URL is wrong (or a
      // proxy is rewriting it); following it would send the API key elsewhere.
      if (!this.configErrorLogged) {
        this.configErrorLogged = true;
        const message =
          `Aforo ingestor answered HTTP ${status} redirecting to ${redirectTo}; redirects are not followed so the API key ` +
          `never reaches another host. Usage stays queued (${this.queue.size} events). Fix the ingestor base URL.`;
        this.logger.error(message);
        this.reportError(new CoreTransportError('outage', message, kept, { status }));
      }
      return;
    }
    if (first) {
      this.logger.warn(`Aforo ingestor unavailable (${reason}); ${this.queue.size} events queued, retrying with backoff.`);
    }
    if (status !== undefined && AUTH_STATUSES.has(status)) {
      // Once per breaker opening, also when an outage turns into 401/403 while the breaker is open.
      if (!this.configErrorLogged) {
        this.configErrorLogged = true;
        this.logger.error(
          `Aforo ingestor answered HTTP ${status}: the API key is wrong or revoked. ` +
            `Usage stays queued (${this.queue.size} events) and is sent once a valid key is in place.`,
        );
        this.reportError(
          new CoreTransportError(
            'auth',
            `Aforo ingestor answered HTTP ${status}: the API key is wrong or revoked. Events are kept and retried.`,
            kept,
            { status },
          ),
        );
      }
    } else if (first) {
      this.reportError(new CoreTransportError('outage', `Aforo ingestor unavailable: ${reason}. Events are kept and retried.`, kept, { status }));
    }
  }

  private closeBreaker(): void {
    if (this.breakerOpen) {
      this.logger.warn('Aforo ingestor reachable again; sending queued events.');
    }
    this.breakerOpen = false;
    this.breakerOpens = 0;
    this.configErrorLogged = false;
  }

  /** One chunk, with retries. Never throws. */
  private async sendWithRetry(chunk: E[], body: string): Promise<SendOutcome> {
    let lastReason = 'no attempt';
    let lastStatus: number | undefined;
    for (let attempt = 0; ; attempt++) {
      if (this.closedFlag && this.pastDeadline) return { kind: 'deadline' };
      const timeLeft = this.deadline - this.clock();
      const requestTimeout = Math.max(1, Math.min(this.timeoutMs, timeLeft));
      let retryAfterMs: number | undefined;
      let response: CoreResponse | undefined;
      try {
        response = await this.post(body, requestTimeout);
      } catch (err) {
        if (this.closedFlag && this.pastDeadline) return { kind: 'deadline' };
        lastReason = `network error: ${errorText(err)}`;
        lastStatus = undefined;
      }

      if (response) {
        const status = response.status;
        if (status >= 200 && status < 300) {
          return this.handleAccepted(response, chunk);
        }
        if (status === 413) return { kind: 'split' };
        if (isRedirect(status)) {
          return {
            kind: 'outage',
            status,
            reason: `HTTP ${status} redirect`,
            redirectTo: redirectTarget(response.headers?.get?.('location') ?? null, this.url),
          };
        }
        if (AUTH_STATUSES.has(status)) {
          await this.discardBody(response);
          return { kind: 'outage', status, reason: `HTTP ${status}` };
        }
        if (RETRY_STATUSES.has(status) || status >= 500) {
          retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after') ?? null, this.clock(), this.retryAfterMaxMs);
          lastReason = `HTTP ${status}`;
          lastStatus = status;
          await this.discardBody(response);
        } else {
          const detail = await this.readProblem(response);
          this.recordDrop(chunk, 'rejected', `HTTP ${status}${detail ? `: ${detail}` : ''}`);
          this.reportError(
            new CoreTransportError(
              'rejected',
              `Aforo ingestor rejected a batch of ${chunk.length} with HTTP ${status}${detail ? `: ${detail}` : ''} (not retried)`,
              chunk,
              { status },
            ),
          );
          return { kind: 'done', sent: 0, failed: chunk.length, retryable: [] };
        }
      }

      if (attempt >= this.maxRetries) {
        return { kind: 'outage', status: lastStatus, reason: `${lastReason} after ${attempt + 1} attempts` };
      }
      const jittered = fullJitter(attempt, this.retryBaseMs, this.retryMaxDelayMs, this.random);
      const delay = retryAfterMs !== undefined ? Math.min(Math.max(retryAfterMs, jittered), this.retryAfterMaxMs) : jittered;
      if (this.closedFlag && this.clock() + delay >= this.deadline) return { kind: 'deadline' };
      this.logDebug(`ingest attempt ${attempt + 1} failed (${lastReason}); retrying in ${delay} ms`);
      await this.sleepFn(delay, this.stopController.signal);
    }
  }

  private async post(body: string, timeoutMs: number): Promise<CoreResponse> {
    const controller = new AbortController();
    const timeoutSignal: AbortSignal = (AbortSignal as any).timeout(timeoutMs);
    const onTimeout = () => controller.abort((timeoutSignal as any).reason);
    const onStop = () => controller.abort(new Error('shutdown deadline passed'));
    timeoutSignal.addEventListener('abort', onTimeout, { once: true });
    this.stopController.signal.addEventListener('abort', onStop, { once: true });
    this.inFlight += 1;
    try {
      const response = await untilAborted(
        Promise.resolve().then(() =>
          this.fetchFn(this.url, { method: 'POST', headers: this.headers, body, signal: controller.signal, redirect: 'manual' }),
        ),
        controller.signal,
      );
      // Read the body inside the same deadline: a server that sends headers
      // and then stalls, or drips the body, must not hold the flusher.
      return await bufferBody(response, controller.signal);
    } finally {
      this.inFlight -= 1;
      timeoutSignal.removeEventListener('abort', onTimeout);
      this.stopController.signal.removeEventListener('abort', onStop);
    }
  }

  private async handleAccepted(response: CoreResponse, chunk: E[]): Promise<SendOutcome> {
    let body: any;
    try {
      body = unwrapEnvelope(await readJson(response));
    } catch (err) {
      this.logDebug(`ingest response body unreadable: ${errorText(err)}`);
    }
    const errors: any[] = Array.isArray(body?.errors) ? body.errors : [];
    const reportedFailed = typeof body?.failed === 'number' && body.failed > 0 ? Math.floor(body.failed) : 0;
    const seen = new Set<number>();
    const rejected: E[] = [];
    const retryable: E[] = [];
    const messages: string[] = [];
    for (const e of errors) {
      const index = Number(e?.index);
      if (!Number.isInteger(index) || index < 0 || index >= chunk.length || seen.has(index)) continue;
      seen.add(index);
      if (e?.retryable === true) {
        retryable.push(chunk[index]);
      } else {
        rejected.push(chunk[index]);
        if (messages.length < 5) messages.push(`#${index}: ${String(e?.message ?? 'rejected').slice(0, 200)}`);
      }
    }
    const unattributed = Math.max(0, Math.min(chunk.length, reportedFailed) - seen.size);
    if (rejected.length > 0) {
      this.recordDrop(rejected, 'rejected', messages.join('; '));
      this.reportError(
        new CoreTransportError('rejected', `Aforo ingestor rejected ${rejected.length} event(s): ${messages.join('; ')}`, rejected, {
          status: response.status,
        }),
      );
    }
    if (unattributed > 0) {
      // The ingestor reported failures without saying which: count them, nothing to hand to onDrop.
      this.dropped += unattributed;
      this.logger.warn(`Aforo ingestor rejected ${unattributed} event(s) without naming them (${this.dropped} total dropped).`);
    }
    const failed = rejected.length + unattributed;
    if (this.onAccepted) {
      try {
        this.onAccepted(body, chunk);
      } catch (err) {
        this.logDebug(`onAccepted hook threw: ${errorText(err)}`);
      }
    }
    return { kind: 'done', sent: chunk.length - failed - retryable.length, failed, retryable };
  }

  private async discardBody(response: CoreResponse): Promise<void> {
    try {
      if (typeof response.text === 'function') await response.text();
    } catch (err) {
      this.logDebug(`could not read error body: ${errorText(err)}`);
    }
  }

  private async readProblem(response: CoreResponse): Promise<string | undefined> {
    try {
      const body = unwrapEnvelope(await readJson(response));
      if (!body) return undefined;
      const first = Array.isArray(body?.errors) ? body.errors[0] : undefined;
      const msg = first?.message ?? body?.detail ?? body?.message ?? body?.error ?? body?.title;
      return typeof msg === 'string' && msg ? msg.slice(0, 300) : undefined;
    } catch (err) {
      this.logDebug(`error body is not JSON: ${errorText(err)}`);
      return undefined;
    }
  }

  // ── Drop accounting ──────────────────────────────────────────────

  private recordDrop(events: E[], reason: CoreDropReason, detail?: string): void {
    if (!events || events.length === 0) return;
    this.dropped += events.length;
    try {
      if (reason === 'overflow' || reason === 'invalid' || reason === 'closed') {
        // Hot-path reasons: first, then every 1000th, so a loop cannot storm the log.
        const before = reason === 'overflow' ? this.overflowDrops : reason === 'invalid' ? this.invalidDrops : this.closedDrops;
        const after = before + events.length;
        if (reason === 'overflow') this.overflowDrops = after;
        else if (reason === 'invalid') this.invalidDrops = after;
        else this.closedDrops = after;
        if (before === 0 || Math.floor(after / 1000) > Math.floor(before / 1000)) {
          this.logger.warn(
            `Dropped ${events.length} event(s) — ${reason}${detail ? `: ${detail}` : ''} (${this.dropped} total dropped).` +
              (reason === 'overflow' ? ' Raise maxQueueSize or check ingest connectivity.' : ''),
          );
        }
      } else {
        this.logger.warn(`Dropped ${events.length} event(s) — ${reason}${detail ? `: ${detail}` : ''} (${this.dropped} total dropped).`);
      }
    } catch {
      /* a logger must never break metering */
    }
    if (this.onDrop) {
      try {
        this.onDrop(events, reason, detail);
      } catch (err) {
        this.logDebug(`onDrop hook threw: ${errorText(err)}`);
      }
    }
  }

  private reportError(err: CoreTransportError<E>): void {
    if (!this.onError) return;
    try {
      this.onError(err);
    } catch (hookErr) {
      this.logDebug(`onError hook threw: ${errorText(hookErr)}`);
    }
  }
}

/**
 * Read the whole body now, giving up when `signal` aborts, and hand back a
 * response whose text()/json() return what was read. Callers then parse
 * without touching the network again.
 */
async function bufferBody(response: CoreResponse, signal: AbortSignal): Promise<CoreResponse> {
  if (typeof response.text === 'function') {
    const text = await untilAborted(Promise.resolve().then(() => response.text!()), signal);
    return { status: response.status, ok: response.ok, headers: response.headers, text: async () => text };
  }
  if (typeof response.json === 'function') {
    const json = await untilAborted(Promise.resolve().then(() => response.json!()), signal);
    return { status: response.status, ok: response.ok, headers: response.headers, json: async () => json };
  }
  return response;
}

/** Parse a response body as JSON (text() first, json() as a fallback). Empty body → undefined. */
async function readJson(response: CoreResponse): Promise<unknown> {
  if (typeof response.text === 'function') {
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }
  if (typeof response.json === 'function') return response.json();
  return undefined;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
