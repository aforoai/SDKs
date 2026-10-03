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

/**
 * Why buffered events were permanently dropped by the SDK.
 * - 'retry_exhausted': the batch failed after all 3 flush attempts (ingest outage).
 * - 'rejected': the ingestor rejected the batch with a non-retryable 4xx, or
 *   rejected these events individually inside a batch it otherwise accepted.
 * - 'invalid': the event failed a client-side check (blank toolName, or
 *   agentId / customerId / sessionId over the ingestor's size limit) and was
 *   never buffered or sent. An over-long toolName is truncated, not dropped.
 * (No 'overflow' reason here — the MCP buffer is unbounded between flushes.)
 */
export type McpDropReason = 'retry_exhausted' | 'rejected' | 'invalid';

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
   * Customer billed for tool calls that carry no `_meta.customer_id`. When
   * neither is set, the call's agentId is billed as the customer (the
   * long-standing default). Also used as the customer of heartbeat events.
   */
  customerId?: string;
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
  flushIntervalMs?: number;
  flushCount?: number;
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
  /** Called when the server signals that a session has been killed */
  onSessionKilled?: (sessionId: string, reason: string) => void;
}

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

const SDK_VERSION = '1.3.2';

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

/** Best-effort server explanation for a rejected request. */
async function readErrorMessage(response: { json?: () => Promise<unknown> }): Promise<string | undefined> {
  try {
    const body = (await response.json?.()) as Record<string, any> | undefined;
    if (!body || typeof body !== 'object') return undefined;
    const first = Array.isArray(body.errors) ? body.errors[0] : undefined;
    const text = first?.message ?? body.detail ?? body.message ?? body.error ?? body.title;
    return typeof text === 'string' && text ? text.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
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
  private buffer: UsageEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushIntervalMs: number;
  private flushCount: number;
  private onError: (error: Error) => void;
  private onDrop: ((events: UsageEvent[], reason: McpDropReason) => void) | null;

  // Drop accounting — events permanently lost after flush failure
  private dropped = 0;
  private invalidDrops = 0;
  /** Request-derived labels already reported as truncated (one WARN per label). */
  private truncationWarned = new Set<string>();
  private productType: string;
  private defaultCustomerId: string | undefined;
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
      ingestorUrl: config.ingestorUrl.replace(/\/+$/, ''),
    };
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
    this.flushCount = Math.min(Math.max(1, config.flushCount ?? 50), MAX_BATCH_EVENTS);
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.defaultCustomerId = nonBlank(config.customerId);
    this.defaultAgentId = nonBlank(config.agentId) ?? 'unknown';
    this.onDrop = config.onDrop ?? null;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
    this.heartbeatEnabled = config.heartbeatEnabled ?? true;
    this.onError = config.onError ?? ((err) => console.error('[aforo-mcp] Error:', err.message));
    this.onSessionKilled = config.onSessionKilled ?? null;

    // Start periodic flush timer
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Unref so the background timer never blocks host-process exit (final flush still needs shutdown()).
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      this.flushTimer.unref();
    }
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
    await Promise.all([end, this.flush()]);
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
      });
      if (!response.ok) {
        this.onError(new Error(`Aforo ingestor returned ${response.status} for session heartbeat — ignored`));
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

  private handleKilledSessions(result: BatchIngestResponse | null | undefined): void {
    if (result && Array.isArray(result.killedSessionIds) && this.activeSessionId
        && result.killedSessionIds.includes(this.activeSessionId)) {
      const killedId = this.activeSessionId;
      this.stopSession();
      this.onSessionKilled?.(killedId, 'SERVER_KILL');
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
   * Reads `agent_id`, `session_id` and `customer_id` from `request.params._meta`.
   */
  wrapToolHandler<TReq extends { params: { name: string; arguments?: unknown; _meta?: Record<string, unknown> } }, TRes>(
    handler: (request: TReq) => Promise<TRes>,
    options: WrapToolHandlerOptions<TRes> = {},
  ): (request: TReq) => Promise<TRes> {
    return async (request: TReq): Promise<TRes> => {
      const toolName = request.params.name;
      const meta = request.params._meta;
      const agentId = nonBlank(meta?.agent_id) ?? this.defaultAgentId;
      const sessionId = nonBlank(meta?.session_id);
      const customerId = nonBlank(meta?.customer_id);
      const startTime = Date.now();

      // Start the session (and heartbeats) on the first tool call that carries one
      if (sessionId && !this.activeSessionId) {
        this.startSession(sessionId, { customerId: customerId ?? this.defaultCustomerId ?? agentId });
      }

      let result: TRes | undefined;
      let error: unknown;
      try {
        result = await handler(request);
        return result;
      } catch (err) {
        error = err === undefined ? new Error('tool handler threw undefined') : err;
        throw err;
      } finally {
        const durationMs = Date.now() - startTime;
        const status = this.resolveToolStatus(result, error, options.statusResolver);
        this.recordToolInvocation(toolName, agentId, sessionId, status, durationMs,
          customerId ? { customerId } : undefined);
      }
    };
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
   * The customer is `options.customerId`, else the `customerId` config, else
   * the agentId. `executionStatus` is sent as given: pass one of
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
    const customerId = nonBlank(options.customerId) ?? this.defaultCustomerId ?? resolvedAgentId;
    const productType = normalizeProductType(options.productType) ?? this.productType;
    const problems: string[] = [];
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
      // Not buffered, not sent, not thrown — same shape as every other drop.
      this.recordDrop([event], 'invalid', problems.join(', '));
      return;
    }

    this.buffer.push(event);

    if (this.buffer.length >= this.flushCount) {
      this.flush();
    }
  }

  /**
   * Flush buffered events to Aforo ingestor.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = [...this.buffer];
    this.buffer = [];

    // POST /v1/ingest/batch rejects more than MAX_BATCH_EVENTS events with 400
    // (IngestBatchRequest @Size(max = 1000)), so an oversized flush would lose
    // every event in it. flushCount above 1000, or a burst between timer
    // ticks, can leave more than that buffered -- send it in slices.
    for (let i = 0; i < events.length; i += MAX_BATCH_EVENTS) {
      await this.sendBatch(events.slice(i, i + MAX_BATCH_EVENTS));
    }
  }

  private async sendBatch(events: UsageEvent[]): Promise<void> {
    const url = `${this.config.ingestorUrl}/v1/ingest/batch`;
    // Serialized once: every retry re-sends the same body, same idempotency keys.
    const body = JSON.stringify({ events });

    for (let attempt = 1; attempt <= 3; attempt++) {
      let delayMs = Math.pow(2, attempt - 1) * 1000;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: this.headers(),
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          try {
            const result = unwrapEnvelope(await response.json()) as BatchIngestResponse;
            this.handlePartialFailure(events, result);
            // Check for kill signals from server
            this.handleKilledSessions(result);
          } catch {
            // Response body parsing is best-effort — old servers return empty 202
          }
          return;
        }

        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable) {
          const detail = await readErrorMessage(response);
          this.onError(new Error(`Aforo ingestor returned ${response.status}${detail ? ` (${detail})` : ''} — not retrying`));
          this.recordDrop(events, 'rejected', detail);
          return;
        }
        if (attempt === 3) {
          this.onError(new Error(`Aforo ingestor returned ${response.status} — retries exhausted, ${events.length} event(s) dropped`));
          break;
        }
        if (response.status === 429) {
          const retryAfter = response.headers?.get?.('Retry-After');
          const seconds = retryAfter ? parseInt(retryAfter, 10) : NaN;
          if (!isNaN(seconds) && seconds >= 0) delayMs = seconds * 1000;
        }
      } catch (err) {
        if (attempt === 3) {
          this.onError(err instanceof Error ? err : new Error(String(err)));
          break;
        }
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    // All 3 attempts failed (5xx / 408 / 429 or network error) — the batch was
    // already removed from the buffer, so without this it vanishes silently.
    this.recordDrop(events, 'retry_exhausted');
  }

  /**
   * A 2xx can still report per-event rejections. Those events are dropped with
   * reason 'rejected': by index when the response names them; otherwise they
   * are counted and reported, but not handed to onDrop (which ones is unknown).
   */
  private handlePartialFailure(events: UsageEvent[], result: BatchIngestResponse | null | undefined): void {
    if (!result || typeof result !== 'object') return;
    const seen = new Set<number>();
    const errors = (Array.isArray(result.errors) ? result.errors : []).filter((e) => {
      const index = Number(e?.index);
      if (!Number.isInteger(index) || index < 0 || index >= events.length || seen.has(index)) return false;
      seen.add(index);
      return true;
    });
    const reported = typeof result.failed === 'number' && result.failed > 0 ? Math.floor(result.failed) : 0;
    const count = Math.min(events.length, Math.max(reported, errors.length));
    if (count === 0) return;

    const detail = errors.slice(0, 5).map((e) => `#${e.index}: ${e.message}`).join('; ');
    this.onError(new Error(`Aforo ingestor rejected ${count} event(s)${detail ? `: ${detail}` : ''}`));
    if (errors.length === count) {
      this.recordDrop(errors.map((e) => events[Number(e.index)]), 'rejected', detail);
    } else {
      this.dropped += count;
      console.warn(
        `[aforo-mcp] Ingestor rejected ${count} of ${events.length} event(s) in a batch` +
        `${detail ? `: ${detail}` : ''} (${this.dropped} total dropped).`,
      );
    }
  }

  /**
   * Account for permanently lost events: bump the counter, WARN-log, and
   * invoke the opt-in onDrop hook (exceptions swallowed — a hook bug must
   * never break flushing). 'invalid' WARNs are throttled (first, then every
   * 1000th) so a tight loop of bad events can't storm the log.
   */
  private recordDrop(events: UsageEvent[], reason: McpDropReason, detail?: string): void {
    if (events.length === 0) return;
    this.dropped += events.length;
    if (reason === 'invalid') {
      this.invalidDrops += events.length;
      if (this.invalidDrops === 1 || this.invalidDrops % 1000 === 0) {
        console.warn(
          `[aforo-mcp] Invalid tool invocation dropped — ${detail ?? 'failed validation'} ` +
          `(${this.invalidDrops} invalid, ${this.dropped} total dropped). It was not sent.`,
        );
      }
    } else {
      console.warn(
        `[aforo-mcp] Dropped ${events.length} event(s) — ${reason}` +
        `${detail ? `: ${detail}` : ''} (${this.dropped} total dropped).`,
      );
    }
    if (this.onDrop) {
      try {
        this.onDrop(events, reason);
      } catch {
        // swallowed
      }
    }
  }

  /** Total events permanently dropped (failed batches, server-rejected and invalid events) since creation. */
  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Stop the heartbeat and flush timers and flush remaining events.
   */
  async shutdown(): Promise<void> {
    this.stopSession();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
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
