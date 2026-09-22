/**
 * @aforo/mcp-metering — Aforo MCP Server Metering SDK
 *
 * Wraps MCP tool handlers to automatically meter tool invocations,
 * track sessions, and enforce entitlements via Aforo's billing platform.
 *
 * Usage:
 *   import { AforoMcpBilling } from '@aforo/mcp-metering';
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

const SDK_VERSION = '1.1.0';

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

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface UsageEvent {
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
        this.handleKilledSessions((await response.json()) as BatchIngestResponse);
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
    handler: (request: TReq) => Promise<TRes>
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

      let status = 'SUCCESS';
      try {
        const result = await handler(request);
        return result;
      } catch (error) {
        status = 'ERROR';
        throw error;
      } finally {
        const durationMs = Date.now() - startTime;
        this.recordToolInvocation(toolName, agentId, sessionId, status, durationMs,
          customerId ? { customerId } : undefined);
      }
    };
  }

  /**
   * Record a tool invocation manually (if not using wrapToolHandler).
   *
   * The customer is `options.customerId`, else the `customerId` config, else
   * the agentId. An event the ingestor would reject -- blank toolName,
   * toolName over 64 chars, agentId over 36 chars or customerId over 64 chars --
   * is dropped and reported via `onError`, because one invalid event fails its
   * whole batch.
   */
  recordToolInvocation(
    toolName: string,
    agentId: string | undefined,
    sessionId: string | undefined,
    executionStatus: string,
    executionDurationMs: number,
    options: RecordToolInvocationOptions = {}
  ): void {
    const resolvedAgentId = nonBlank(agentId) ?? this.defaultAgentId;
    const customerId = nonBlank(options.customerId) ?? this.defaultCustomerId ?? resolvedAgentId;
    const problems: string[] = [];
    if (!nonBlank(toolName)) problems.push('toolName is blank');
    else if (toolName.length > MAX_TOOL_NAME) problems.push(`toolName exceeds ${MAX_TOOL_NAME} chars`);
    if (resolvedAgentId.length > MAX_AGENT_ID) problems.push(`agentId exceeds ${MAX_AGENT_ID} chars`);
    if (customerId.length > MAX_CUSTOMER_ID) problems.push(`customerId exceeds ${MAX_CUSTOMER_ID} chars`);
    if (problems.length > 0) {
      this.onError(new Error(`tool invocation not metered: ${problems.join(', ')}`));
      return;
    }

    const event: UsageEvent = {
      customerId,
      metricName: 'mcp_server.tool_invocations',
      quantity: 1,
      occurredAt: new Date().toISOString(),
      // Unique per event: Date.now() alone collides for two calls of the same
      // tool in the same ms, and the ingestor dedupes the second as a replay.
      idempotencyKey: `mcp:sdk:${resolvedAgentId}:${sessionId ?? 'no-session'}:${toolName}:${Date.now()}:${randomSuffix()}`.slice(0, 255),
      productType: normalizeProductType(options.productType) ?? this.productType,
      toolName,
      agentId: resolvedAgentId,
      sessionId,
      executionStatus,
      executionDurationMs,
      metadata: {
        productId: this.config.productId,
        sdk: 'nodejs',
        sdkVersion: '1.0.0',
      },
    };

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
            const result = (await response.json()) as BatchIngestResponse;
            if (result && result.failed > 0) {
              const detail = (result.errors ?? []).slice(0, 5).map((e) => `#${e.index}: ${e.message}`).join('; ');
              this.onError(new Error(`Aforo ingestor rejected ${result.failed} event(s)${detail ? `: ${detail}` : ''}`));
            }
            // Check for kill signals from server
            this.handleKilledSessions(result);
          } catch {
            // Response body parsing is best-effort — old servers return empty 202
          }
          return;
        }

        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable) {
          this.onError(new Error(`Aforo ingestor returned ${response.status} — not retrying`));
          return;
        }
        if (attempt === 3) {
          this.onError(new Error(`Aforo ingestor returned ${response.status} — retries exhausted, ${events.length} event(s) dropped`));
          return;
        }
        if (response.status === 429) {
          const retryAfter = response.headers?.get?.('Retry-After');
          const seconds = retryAfter ? parseInt(retryAfter, 10) : NaN;
          if (!isNaN(seconds) && seconds >= 0) delayMs = seconds * 1000;
        }
      } catch (err) {
        if (attempt === 3) {
          this.onError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
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
