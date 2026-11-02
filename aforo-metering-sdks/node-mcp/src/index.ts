/**
 * @aforoai/mcp-metering — Aforo MCP Server Metering SDK
 *
 * Wraps MCP tool handlers to automatically meter tool invocations,
 * track sessions, and enforce entitlements via Aforo's billing platform.
 *
 * Usage:
 *   import { AforoMcpBilling } from '@aforoai/mcp-metering';
 *
 *   const billing = new AforoMcpBilling({
 *     tenantId: 'tenant_smartai',
 *     productId: 'prod_mcp_001',
 *     apiKey: process.env.AFORO_API_KEY,
 *     ingestorUrl: 'https://api.aforo.ai',
 *     productType: 'MCP_SERVER',     // default
 *     // Who each call is billed to, from identity your server authenticated:
 *     customerResolver: (request, extra) => extra?.authInfo?.clientId,
 *   });
 *
 *   server.setRequestHandler(
 *     CallToolRequestSchema,
 *     billing.wrapToolHandler(async (request) => {
 *       // Your tool logic
 *       return { content: [{ type: 'text', text: result }] };
 *     })
 *   );
 */

import { createHash, randomUUID } from 'node:crypto';
import { TransportCore, checkBaseUrl, type CoreDropReason, type CoreFlushResult } from './transport-core/core';

/** What onError receives for delivery problems: branch on `kind`, read `events`. */
export { CoreTransportError, type CoreErrorKind } from './transport-core/core';

/**
 * Why events were permanently dropped by the SDK.
 * - 'rejected': the ingestor refused the batch with a non-retryable 4xx, or
 *   refused these events individually inside a batch it otherwise accepted.
 * - 'invalid': the event failed a client-side check (no customer, blank
 *   toolName, or agentId / customerId / sessionId over the ingestor's size
 *   limit) and was never queued or sent. An over-long toolName is truncated, not dropped.
 * - 'overflow': the queue was full (maxQueueSize) and the oldest event made room.
 * - 'shutdown': still queued when the shutdown deadline passed.
 * - 'closed': recorded after shutdown().
 * - 'retry_exhausted': kept for compatibility; an ingest outage no longer
 *   drops events (they are re-queued with their keys and retried).
 */
export type McpDropReason = CoreDropReason;

/** The ingestor's per-request cap on POST /v1/ingest/batch (IngestBatchRequest). */
export const MAX_BATCH_EVENTS = 1000;
export const DEFAULT_PRODUCT_TYPE = 'MCP_SERVER';
export const HEARTBEAT_METRIC = 'system.session.heartbeat';
/** customerId on heartbeats when no session customer is known; heartbeats are intercepted before billing. */
export const HEARTBEAT_FALLBACK_CUSTOMER_ID = 'system';
/** Ingestor field limits (IngestUsageEventRequest). */
const MAX_CUSTOMER_ID = 64;
const MAX_AGENT_ID = 36;
const MAX_TOOL_NAME = 64;
const MAX_SESSION_ID = 64;
const MAX_PRODUCT_TYPE = 20;
const MAX_IDEMPOTENCY_KEY = 255;

export interface AforoMcpConfig {
  tenantId: string;
  productId: string;
  apiKey: string;
  ingestorUrl: string;
  /**
   * Top-level `productType` stamped on every event (required by the ingestor
   * in production). Default `MCP_SERVER`; trimmed and uppercased, unknown values
   * are passed through. Per-call override: `recordToolInvocation(..., { productType })`.
   */
  productType?: string;
  /**
   * One customer billed for every tool call (a server that serves a single
   * customer). Also the customer of heartbeat events. `wrapToolHandler`
   * needs one of `customerResolver`, `customerId` or `trustCustomerHeader`.
   */
  customerId?: string;
  /**
   * Decides the customer for each tool call from identity your server
   * authenticated (OAuth token, API-key lookup, session). Receives the request
   * and the handler's second argument (the MCP SDK's `extra`, with `authInfo`).
   * May return a Promise; the tool's response is never delayed by it. Return
   * nothing to leave the call unmetered: its event is dropped as `invalid`,
   * the tool still runs. When set it wins over every other source.
   */
  customerResolver?: CustomerResolver;
  /**
   * Bill the customer the MCP client names in `params._meta.customer_id`.
   * Any client can put any id there, so turn this on only when every client
   * is trusted. Calls without one fall back to `customerId` when set.
   */
  trustCustomerHeader?: boolean;
  /**
   * Agent id used when a request carries no `_meta.agent_id` (MCP_SERVER
   * events require one). Falls back to `"unknown"` when not set.
   */
  agentId?: string;
  entitlementMode?: 'SERVER_LEVEL' | 'TOOL_LEVEL';
  sessionConfig?: {
    idleTimeoutSec?: number;
    maxDurationSec?: number;
  };
  /** Send queued events at least this often, in ms (default 5000). */
  flushIntervalMs?: number;
  /** Events per request; reaching it wakes the sender (default 500, max 1000). */
  flushCount?: number;
  /** Most events held while the ingestor is unreachable (default 10 000); the oldest is dropped past it ('overflow'). */
  maxQueueSize?: number;
  /** Retries per batch before the outage breaker opens (default 3). */
  maxRetries?: number;
  /** Total deadline per ingest request, in ms (default 10 000). */
  timeoutMs?: number;
  /** How long shutdown() keeps sending, in ms (default 5000); what is left is dropped as 'shutdown'. */
  shutdownTimeoutMs?: number;
  /** Flush on the process 'beforeExit' event (default true). */
  flushOnExit?: boolean;
  /** Allow a plain http:// ingestorUrl on a host other than localhost / 127.0.0.1 / ::1. */
  allowInsecureHttp?: boolean;
  /**
   * Request compression: 'gzip' (default) sends batches of 1 KiB or more with
   * Content-Encoding: gzip (needs usage-ingestor wave 8 or later); 'none'
   * always sends plain JSON.
   */
  compression?: 'gzip' | 'none';
  onError?: (error: Error) => void;
  /**
   * OPT-IN hook invoked with events the SDK is about to lose permanently
   * (retry exhaustion, non-retryable rejection, or an event that failed
   * client-side validation — reason 'invalid'), so the app can persist /
   * alert / replay them. Dropped events keep their idempotency keys —
   * re-sending them after recovery is dedup-safe. Default: none (drops are
   * still counted in droppedCount and WARN-logged). Exceptions thrown by the
   * hook are swallowed.
   */
  onDrop?: (events: UsageEvent[], reason: McpDropReason) => void;
  /** Interval between session heartbeats in ms (default 30000). */
  heartbeatIntervalMs?: number;
  /** Whether to send session heartbeats while a session is active (default true). */
  heartbeatEnabled?: boolean;
  /**
   * Called when the ingestor lists the active session in `killedSessionIds`
   * (on a heartbeat response or a usage-batch response). The session and its
   * heartbeats stop first. A throw is reported to onError.
   */
  onSessionKilled?: (sessionId: string, reason: string) => void;
}

/**
 * Returns the customer a tool call is billed to, or nothing to leave it
 * unmetered. `extra` is whatever the MCP SDK passed the handler as its second
 * argument (`RequestHandlerExtra`, which carries `authInfo`).
 */
export type CustomerResolver = (
  request: { params: { name: string; arguments?: unknown; _meta?: Record<string, unknown> } },
  extra: unknown,
) => string | null | undefined | Promise<string | null | undefined>;

export const MISSING_CUSTOMER_SOURCE =
  'AforoMcpBilling: no customer source. Set customerResolver (decide from authenticated identity), customerId ' +
  '(one customer for every call) or trustCustomerHeader: true (bill params._meta.customer_id as the client sends it; ' +
  'only when every client is trusted).';

/** Per-call overrides for {@link AforoMcpBilling.recordToolInvocation}. */
export interface RecordToolInvocationOptions {
  /** Customer to bill for this call (wins over the client-level `customerId`). */
  customerId?: string;
  /** Product type for this event (wins over the client-level `productType`). */
  productType?: string;
}

/** Options for {@link AforoMcpBilling.startSession}. */
export interface StartSessionOptions {
  /** Customer stamped on the session's heartbeats (default: client `customerId`, else "system"). */
  customerId?: string;
  /** Product type of the session's heartbeats (default: client `productType`). */
  productType?: string;
}

const SDK_VERSION = '2.1.0';

function normalizeProductType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Shorten an offending value for a log line. */
function clip(value: unknown): string {
  return String(value).slice(0, 80);
}

/**
 * Cut `value` to at most `max` UTF-16 code units — how the ingestor counts
 * (`String.length()` in Java) — without leaving half a surrogate pair.
 */
export function truncateToLimit(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max);
  const last = end > 0 ? value.charCodeAt(end - 1) : 0;
  // A high surrogate at the cut means its low half was cut off: drop it too.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/**
 * `head + component + tail`, unchanged when it fits the ingestor's
 * idempotencyKey limit. Otherwise `component` is replaced by the SHA-256 hex
 * digest of its full value (and, if the fixed parts alone are too long,
 * `head + component` is). Never cut, so the unique tail always survives.
 */
function boundedIdempotencyKey(head: string, component: string, tail: string): string {
  const key = `${head}${component}${tail}`;
  if (key.length <= MAX_IDEMPOTENCY_KEY) return key;
  const hashed = `${head}${sha256Hex(component)}${tail}`;
  if (hashed.length <= MAX_IDEMPOTENCY_KEY) return hashed;
  return `${sha256Hex(head + component)}${tail}`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Decides the executionStatus for one tool call. Receives the handler's
 * result (undefined when it threw) and the thrown error (undefined when it
 * returned). Return one of the canonical statuses (SUCCESS, PARTIAL, TIMEOUT,
 * ERROR, VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING, BLOCKED,
 * HITL_REQUIRED), or undefined to use {@link defaultToolStatus}.
 */
export type ToolStatusResolver<TRes = unknown> = (
  result: TRes | undefined,
  error: unknown,
) => string | undefined;

export interface WrapToolHandlerOptions<TRes = unknown> {
  /** Overrides the default status decision. Must be synchronous. If it
   * throws, returns a Promise, or returns a status outside
   * {@link EXECUTION_STATUSES}, the problem is reported to onError and the
   * default decision is used instead. */
  statusResolver?: ToolStatusResolver<TRes>;
}

/** The 11 statuses the ingestor accepts; anything else rejects the event. */
export const EXECUTION_STATUSES: readonly string[] = [
  'SUCCESS', 'PARTIAL', 'TIMEOUT', 'ERROR', 'VALIDATION_FAILED', 'FAILED',
  'FAILURE', 'CANCELLED', 'PENDING', 'BLOCKED', 'HITL_REQUIRED',
];

/** JSON-RPC error code the MCP SDKs use for a request timeout (ErrorCode.RequestTimeout). */
const MCP_REQUEST_TIMEOUT = -32001;

/**
 * Default executionStatus for a wrapped tool call:
 * - the handler threw a timeout (a `TimeoutError`, e.g. from
 *   `AbortSignal.timeout`, or an MCP error with code -32001) → TIMEOUT
 * - the handler threw anything else, including a JSON-RPC error → ERROR
 * - the handler returned `{ isError: true, ... }`, the normal way an MCP
 *   tool reports failure → ERROR
 * - otherwise → SUCCESS
 *
 * ERROR rather than FAILURE for returned failures: a tool author's choice
 * between throwing and returning `isError` should not change the bill, and
 * ERROR is what every gateway and SDK sends for a call that ran and failed.
 */
export function defaultToolStatus(result: unknown, error: unknown): string {
  if (error !== undefined) {
    const e = error as { name?: unknown; code?: unknown } | null;
    if (e && (e.name === 'TimeoutError' || e.code === MCP_REQUEST_TIMEOUT)) return 'TIMEOUT';
    return 'ERROR';
  }
  if (result && typeof result === 'object' && (result as { isError?: unknown }).isError === true) {
    return 'ERROR';
  }
  return 'SUCCESS';
}

export interface UsageEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
  idempotencyKey: string;
  productType: string;
  toolName?: string;
  agentId?: string;
  sessionId?: string;
  sessionBoundary?: string;
  executionStatus: string;
  executionDurationMs?: number;
  metadata?: Record<string, unknown>;
}

interface BatchIngestResponse {
  accepted: number;
  duplicates: number;
  failed: number;
  errors?: Array<{ index: number; message: string }>;
  killedSessionIds?: string[];
}

export class AforoMcpBilling {
  private config: Required<Pick<AforoMcpConfig, 'tenantId' | 'productId' | 'apiKey' | 'ingestorUrl'>>;
  /** Bounded queue, single flusher, retries, breaker and shutdown deadline (contract/TRANSPORT-SPEC.md). */
  private readonly core: TransportCore<UsageEvent>;
  private onError: (error: Error) => void;
  /** Request-derived labels already reported as truncated (one WARN per label). */
  private truncationWarned = new Set<string>();
  private productType: string;
  private defaultCustomerId: string | undefined;
  private customerResolver: CustomerResolver | undefined;
  private trustCustomerHeader: boolean;
  private defaultAgentId: string;

  // Session / heartbeat state
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number;
  private heartbeatEnabled: boolean;
  private activeSessionId: string | null = null;
  private sessionStartedAt: number | null = null;
  private sessionCustomerId: string | null = null;
  private sessionProductType: string | null = null;
  private onSessionKilled: ((sessionId: string, reason: string) => void) | null;

  constructor(config: AforoMcpConfig) {
    if (!config.tenantId) throw new Error('tenantId is required');
    if (!config.productId) throw new Error('productId is required');
    if (!config.apiKey) throw new Error('apiKey is required');
    if (!config.ingestorUrl) throw new Error('ingestorUrl is required');

    this.config = {
      tenantId: config.tenantId,
      productId: config.productId,
      apiKey: config.apiKey,
      ingestorUrl: checkBaseUrl(config.ingestorUrl, config.allowInsecureHttp === true),
    };
    // The key is reachable only through the non-enumerable config, never in inspect()/JSON.
    Object.defineProperty(this, 'config', { enumerable: false });
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.defaultCustomerId = nonBlank(config.customerId);
    if (config.customerResolver !== undefined && typeof config.customerResolver !== 'function') {
      throw new Error('customerResolver must be a function');
    }
    this.customerResolver = config.customerResolver;
    this.trustCustomerHeader = config.trustCustomerHeader === true;
    this.defaultAgentId = nonBlank(config.agentId) ?? 'unknown';
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
    this.heartbeatEnabled = config.heartbeatEnabled ?? true;
    this.onError = config.onError ?? ((err) => console.error('[aforo-mcp] Error:', err.message));
    this.onSessionKilled = config.onSessionKilled ?? null;

    const onDrop = config.onDrop;
    this.core = new TransportCore<UsageEvent>({
      baseUrl: this.config.ingestorUrl,
      apiKey: config.apiKey,
      allowInsecureHttp: config.allowInsecureHttp,
      compression: config.compression,
      headers: { 'X-Tenant-Id': config.tenantId },
      userAgent: `aforo-mcp-metering-node/${SDK_VERSION}`,
      flushCount: config.flushCount,
      flushIntervalMs: config.flushIntervalMs,
      maxQueueSize: config.maxQueueSize,
      maxRetries: config.maxRetries,
      timeoutMs: config.timeoutMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      flushOnExit: config.flushOnExit,
      logPrefix: '[aforo-mcp]',
      onError: (err) => this.onError(err),
      onDrop: onDrop ? (events, reason) => onDrop(events, reason) : undefined,
      // Usage-batch responses carry killedSessionIds too, not only heartbeat responses.
      onAccepted: (body) => this.handleKilledSessions(body as BatchIngestResponse | undefined),
    });
  }

  // ─── Session lifecycle / heartbeats ─────────────────────────────────
  //
  // Heartbeats (`system.session.heartbeat`) are intercepted by the ingestor
  // before billing, but only on its synchronous batch path: a batch larger than
  // the ingestor's batch threshold goes to the high-throughput engine, which does
  // not intercept them, and every event must still pass bean validation
  // (quantity > 0, non-blank customerId). So each heartbeat carries quantity 1 and
  // is POSTed in its OWN request (`{"events":[heartbeat]}`), never mixed into a
  // usage batch. Heartbeats are best-effort: sent once, failures reported via
  // onError and otherwise ignored, never affecting usage delivery.

  /**
   * Start a session and begin sending heartbeats (one now, then every
   * `heartbeatIntervalMs`). If not called, the first tool call that carries a
   * `_meta.session_id` starts the session.
   */
  startSession(sessionId: string, options: StartSessionOptions = {}): void {
    // The ingestor caps sessionId at 64 chars; a longer one would fail validation.
    if (!nonBlank(sessionId) || sessionId.length > 64) return;
    if (this.activeSessionId && this.activeSessionId !== sessionId) this.stopSession();
    this.activeSessionId = sessionId;
    const customerId = nonBlank(options.customerId);
    if (customerId) this.sessionCustomerId = customerId;
    const productType = normalizeProductType(options.productType);
    if (productType) this.sessionProductType = productType;
    this.startHeartbeat();
  }

  /**
   * End the current session: send a final SESSION_END heartbeat (own request,
   * best-effort), stop the heartbeat timer and flush any remaining events.
   */
  async endSession(): Promise<void> {
    const end = this.activeSessionId ? this.sendHeartbeat('SESSION_END', { heartbeatType: 'SESSION_END' }) : Promise.resolve();
    this.stopSession();
    await Promise.all([end, this.core.flush()]);
  }

  private startHeartbeat(): void {
    if (!this.heartbeatEnabled || this.heartbeatTimer || !this.activeSessionId) return;

    this.sessionStartedAt = Date.now();
    void this.emitHeartbeat(); // First heartbeat immediately

    this.heartbeatTimer = setInterval(() => { void this.emitHeartbeat(); }, this.heartbeatIntervalMs);
    // Unref so the heartbeat timer never keeps the host process alive.
    if (this.heartbeatTimer && typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      this.heartbeatTimer.unref();
    }
  }

  private stopSession(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.activeSessionId = null;
    this.sessionStartedAt = null;
    this.sessionCustomerId = null;
    this.sessionProductType = null;
  }

  private emitHeartbeat(): Promise<void> {
    if (!this.activeSessionId) return Promise.resolve();
    const now = Date.now();
    let processMemoryMb: number | undefined;
    try {
      processMemoryMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    } catch {
      // Not available in all runtimes
    }
    return this.sendHeartbeat('HEARTBEAT', {
      heartbeatType: 'PERIODIC',
      uptimeMs: now - (this.sessionStartedAt ?? now),
      ...(processMemoryMb != null ? { processMemoryMb } : {}),
    });
  }

  /** POST one heartbeat in its own batch request, once. Never throws. */
  private async sendHeartbeat(boundary: 'HEARTBEAT' | 'SESSION_END', extra: Record<string, unknown>): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const customerId = this.sessionCustomerId ?? this.defaultCustomerId ?? HEARTBEAT_FALLBACK_CUSTOMER_ID;
    const productType = this.sessionProductType ?? this.productType;
    const now = Date.now();
    const heartbeat: UsageEvent = {
      customerId,
      metricName: HEARTBEAT_METRIC,
      quantity: 1,
      occurredAt: new Date(now).toISOString(),
      idempotencyKey: `hb:${boundary === 'SESSION_END' ? 'end:' : ''}${sessionId}:${now}:${randomSuffix()}`.slice(0, 255),
      productType,
      sessionId,
      sessionBoundary: boundary,
      executionStatus: 'SUCCESS',
      metadata: {
        ...extra,
        sessionId,
        sessionBoundary: boundary,
        productType,
        sdkVersion: SDK_VERSION,
        sdkLanguage: 'node',
      },
    };
    try {
      const response = await fetch(`${this.config.ingestorUrl}/v1/ingest/batch`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ events: [heartbeat] }),
        signal: AbortSignal.timeout(10000),
        // Never follow a redirect: it would send the API key to another host.
        redirect: 'manual',
      });
      if (!response.ok) {
        const redirected = response.status === 0 || (response.status >= 300 && response.status < 400);
        this.onError(new Error(
          `Aforo ingestor returned ${response.status} for session heartbeat — ignored`
            + (redirected ? ' (redirects are not followed; check ingestorUrl)' : ''),
        ));
        return;
      }
      try {
        this.handleKilledSessions(unwrapEnvelope(await response.json()) as BatchIngestResponse);
      } catch {
        // Empty / non-JSON body — nothing to act on.
      }
    } catch (err) {
      this.onError(new Error(`session heartbeat failed — ignored: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /**
   * Stop the active session when an ingest response (heartbeat or usage
   * batch) lists it in `killedSessionIds`, then tell the caller. Never throws.
   */
  private handleKilledSessions(result: BatchIngestResponse | null | undefined): void {
    if (result && Array.isArray(result.killedSessionIds) && this.activeSessionId
        && result.killedSessionIds.includes(this.activeSessionId)) {
      const killedId = this.activeSessionId;
      this.stopSession();
      try {
        this.onSessionKilled?.(killedId, 'SERVER_KILL');
      } catch (err) {
        this.onError(new Error(`onSessionKilled threw for session ${killedId}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.config.apiKey,
      'X-Tenant-Id': this.config.tenantId,
    };
  }

  // ─── Tool handler wrapper ──────────────────────────────────────────

  /**
   * Wrap an MCP tool handler to automatically meter invocations.
   * The wrapper extracts tool name, tracks timing, and fires usage events.
   * Starts the session (and its heartbeats) from the first tool call that
   * carries a sessionId.
   *
   * Reads `agent_id` and `session_id` from `request.params._meta`. The
   * customer comes from `customerResolver`, else `_meta.customer_id` when
   * `trustCustomerHeader` is on, else `customerId`; throws when none of the
   * three is configured. Extra handler arguments (the MCP SDK's `extra`) are
   * passed through to the handler and to the resolver.
   */
  wrapToolHandler<TReq extends { params: { name: string; arguments?: unknown; _meta?: Record<string, unknown> } }, TRes, TArgs extends unknown[] = unknown[]>(
    handler: (request: TReq, ...rest: TArgs) => Promise<TRes>,
    options: WrapToolHandlerOptions<TRes> = {},
  ): (request: TReq, ...rest: TArgs) => Promise<TRes> {
    if (!this.customerResolver && !this.defaultCustomerId && !this.trustCustomerHeader) {
      throw new Error(MISSING_CUSTOMER_SOURCE);
    }
    return async (request: TReq, ...rest: TArgs): Promise<TRes> => {
      const toolName = request.params.name;
      const meta = request.params._meta;
      const agentId = nonBlank(meta?.agent_id) ?? this.defaultAgentId;
      const sessionId = nonBlank(meta?.session_id);
      const startTime = Date.now();
      // Resolved alongside the handler, so a slow lookup never delays the tool's response.
      const customer = this.resolveCustomer(request, rest[0]);

      // Start the session (and heartbeats) on the first tool call that carries one
      if (sessionId && !this.activeSessionId) {
        const known = typeof customer === 'string' ? customer : this.defaultCustomerId;
        this.startSession(sessionId, known ? { customerId: known } : {});
      }

      let result: TRes | undefined;
      let error: unknown;
      try {
        result = await handler(request, ...rest);
        return result;
      } catch (err) {
        error = err === undefined ? new Error('tool handler threw undefined') : err;
        throw err;
      } finally {
        const durationMs = Date.now() - startTime;
        const status = this.resolveToolStatus(result, error, options.statusResolver);
        const record = (customerId: string | undefined) => this.recordToolInvocation(
          toolName, agentId, sessionId, status, durationMs, customerId ? { customerId } : { customerId: '' });
        if (customer === undefined || typeof customer === 'string') record(customer);
        else void customer.then(record);
      }
    };
  }

  /**
   * The customer for one call: the resolver's answer, else the trusted
   * `_meta.customer_id`, else the fixed `customerId`. A string or undefined
   * when known now; a Promise (never rejecting) when the resolver is async.
   */
  private resolveCustomer(request: { params: { name: string; arguments?: unknown; _meta?: Record<string, unknown> } }, extra: unknown): string | undefined | Promise<string | undefined> {
    if (this.customerResolver) {
      const onError = (err: unknown) => {
        this.onError(new Error(`customerResolver failed; the call is not metered: ${err instanceof Error ? err.message : String(err)}`));
        return undefined;
      };
      try {
        const answer = this.customerResolver(request, extra);
        if (answer && typeof (answer as Promise<unknown>).then === 'function') {
          return (answer as Promise<string | null | undefined>).then((v) => nonBlank(v), onError);
        }
        return nonBlank(answer);
      } catch (err) {
        return onError(err);
      }
    }
    if (this.trustCustomerHeader) {
      const claimed = nonBlank(request.params._meta?.customer_id);
      if (claimed) return claimed;
    }
    return this.defaultCustomerId;
  }

  private resolveToolStatus<TRes>(
    result: TRes | undefined,
    error: unknown,
    resolver: ToolStatusResolver<TRes> | undefined,
  ): string {
    if (resolver) {
      try {
        const custom: unknown = resolver(result, error);
        if (custom && typeof (custom as { then?: unknown }).then === 'function') {
          // An async resolver can't be awaited here without delaying the
          // tool's response. Swallow its eventual rejection (an unhandled
          // rejection would crash the host process) and use the default.
          (custom as Promise<unknown>).then(undefined, () => undefined);
          this.onError(new Error('statusResolver returned a Promise; it must be synchronous. Using the default status.'));
        } else if (typeof custom === 'string' && custom.trim()) {
          const status = custom.trim().toUpperCase();
          if (EXECUTION_STATUSES.includes(status)) return status;
          this.onError(new Error(`statusResolver returned "${custom}", which is not an execution status. Using the default status.`));
        }
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return defaultToolStatus(result, error);
  }

  /**
   * Record a tool invocation manually (if not using wrapToolHandler).
   *
   * The customer is `options.customerId`, else the `customerId` config. With
   * neither the event is dropped as `invalid` (it is never billed to the
   * agent). `executionStatus` is sent as given: pass one of
   * {@link EXECUTION_STATUSES} (`wrapToolHandler` always does).
   *
   * Never throws. An event the ingestor would reject -- blank toolName,
   * agentId over 36, customerId over 64, sessionId
   * over 64, productType over 20 -- is not buffered or sent: it is counted in
   * `droppedCount`, WARN-logged and passed to `onDrop` with reason `'invalid'`.
   *
   * The tool name is the name the client asked for, so an over-long one is
   * not a reason to lose the call: it is cut to 64 chars on the event (one
   * WARN per client) and the event is sent. The idempotency key is built from
   * the full name.
   */
  recordToolInvocation(
    toolName: string,
    agentId: string | undefined,
    sessionId: string | undefined,
    executionStatus: string,
    executionDurationMs: number,
    options: RecordToolInvocationOptions = {}
  ): void {
    const label = this.requestLabel('toolName', toolName, MAX_TOOL_NAME);
    this.recordInvocation(label, agentId, sessionId, executionStatus, executionDurationMs, options, toolName);
  }

  /**
   * Bound a label that originates from the client's request (the tool name)
   * to the ingestor's limit. The event is still sent; one WARN per label name
   * per client. Identity fields never go through here.
   */
  private requestLabel(field: string, value: string, max: number): string {
    if (typeof value !== 'string' || value.length <= max) return value;
    if (!this.truncationWarned.has(field)) {
      this.truncationWarned.add(field);
      console.warn(
        `[aforo-mcp] ${field} was longer than the ingestor's limit and was ` +
        `truncated to ${max} characters; the event is still sent. Logged once per label.`,
      );
    }
    return truncateToLimit(value, max);
  }

  /** `keyToolName` is the untruncated tool name the idempotency key is built from. */
  private recordInvocation(
    toolName: string,
    agentId: string | undefined,
    sessionId: string | undefined,
    executionStatus: string,
    executionDurationMs: number,
    options: RecordToolInvocationOptions,
    keyToolName: string,
  ): void {
    const resolvedAgentId = nonBlank(agentId) ?? this.defaultAgentId;
    const resolvedSessionId = nonBlank(sessionId);
    // An explicit '' (from wrapToolHandler) means "resolved to no customer": no fallback.
    const customerId = options.customerId === '' ? '' : (nonBlank(options.customerId) ?? this.defaultCustomerId ?? '');
    const productType = normalizeProductType(options.productType) ?? this.productType;
    const problems: string[] = [];
    if (!customerId) problems.push('no customer: set customerResolver, customerId or trustCustomerHeader, or pass options.customerId');
    if (!nonBlank(toolName)) problems.push(`toolName is blank (got "${clip(toolName)}")`);
    if (resolvedAgentId.length > MAX_AGENT_ID) problems.push(`agentId "${clip(resolvedAgentId)}" exceeds ${MAX_AGENT_ID} chars`);
    if (customerId.length > MAX_CUSTOMER_ID) problems.push(`customerId "${clip(customerId)}" exceeds ${MAX_CUSTOMER_ID} chars`);
    if (resolvedSessionId && resolvedSessionId.length > MAX_SESSION_ID) problems.push(`sessionId "${clip(resolvedSessionId)}" exceeds ${MAX_SESSION_ID} chars`);
    if (productType.length > MAX_PRODUCT_TYPE) problems.push(`productType "${clip(productType)}" exceeds ${MAX_PRODUCT_TYPE} chars`);

    const event: UsageEvent = {
      customerId,
      metricName: 'mcp_server.tool_invocations',
      quantity: 1,
      occurredAt: new Date().toISOString(),
      // Random suffix de-collides identical tool calls landing in the same
      // millisecond (same agent+session+tool) — without it they shared a key
      // and the second dedup'd away (silent under-billing; 2026-07-05 fix).
      // Stamped once at event creation, so flush retries stay dedup-safe.
      // Built from the untruncated tool name; a name that makes the key longer
      // than the ingestor allows is replaced by its SHA-256 digest. The key is
      // never cut — cutting it would remove the suffix that keeps calls apart.
      idempotencyKey: boundedIdempotencyKey(
        `mcp:sdk:${resolvedAgentId}:${resolvedSessionId ?? 'no-session'}:`,
        String(keyToolName),
        `:${Date.now()}:${randomUUID().slice(0, 8)}`,
      ),
      productType,
      toolName,
      agentId: resolvedAgentId,
      sessionId: resolvedSessionId,
      executionStatus,
      executionDurationMs,
      metadata: {
        productId: this.config.productId,
        sdk: 'nodejs',
        sdkVersion: SDK_VERSION,
      },
    };

    if (problems.length > 0) {
      // Not queued, not sent, not thrown — counted and reported like every other drop.
      this.core.reportDrop([event], 'invalid', problems.join(', '));
      return;
    }

    // Never sends here: the core's single flusher does, woken at flushCount.
    this.core.enqueue(event);
  }

  /**
   * Send everything queued now and wait for it. Runs on the single flusher —
   * never a second concurrent request. While the ingestor is unreachable the
   * events stay queued (with their idempotency keys) and are retried.
   */
  async flush(): Promise<CoreFlushResult> {
    return this.core.flush();
  }

  /** Total events permanently dropped (every McpDropReason) since creation. */
  get droppedCount(): number {
    return this.core.droppedCount;
  }

  /** Events queued and not yet accepted by the ingestor. */
  get queuedCount(): number {
    return this.core.queued;
  }

  /**
   * Stop the heartbeat and send what is queued for at most
   * `shutdownTimeoutMs`. Events still queued at the deadline are dropped as
   * 'shutdown'. Call endSession() first to send a SESSION_END. The SDK
   * installs no signal handlers: call this from your own SIGTERM handler.
   */
  async shutdown(): Promise<void> {
    this.stopSession();
    await this.core.shutdown();
  }
}

/**
 * The ingestor wraps every 2xx JSON body in `{success, data, meta}`. Returns
 * the inner `data` object when present, else the body unchanged (bare shape).
 */
function unwrapEnvelope(body: any): any {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body.data : undefined;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : body;
}
