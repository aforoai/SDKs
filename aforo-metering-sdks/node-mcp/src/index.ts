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

export interface AforoMcpConfig {
  tenantId: string;
  productId: string;
  apiKey: string;
  ingestorUrl: string;
  entitlementMode?: 'SERVER_LEVEL' | 'TOOL_LEVEL';
  sessionConfig?: {
    idleTimeoutSec?: number;
    maxDurationSec?: number;
  };
  flushIntervalMs?: number;
  flushCount?: number;
  onError?: (error: Error) => void;
  /**
   * @deprecated Ignored. Heartbeats are no longer sent: they were
   * `system.session.heartbeat` events with quantity 0 in the usage batch, which
   * fail the ingestor's validation and take the whole batch down with them.
   */
  heartbeatIntervalMs?: number;
  /**
   * @deprecated Ignored. Heartbeats are no longer sent: they were
   * `system.session.heartbeat` events with quantity 0 in the usage batch, which
   * fail the ingestor's validation and take the whole batch down with them.
   */
  heartbeatEnabled?: boolean;
  /** Called when the server signals that a session has been killed */
  onSessionKilled?: (sessionId: string, reason: string) => void;
}

const SDK_VERSION = '1.1.0';

interface UsageEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
  idempotencyKey: string;
  productType: string;
  toolName?: string;
  agentId: string;
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
  killedSessionIds?: string[];
}

export class AforoMcpBilling {
  private config: Required<Pick<AforoMcpConfig, 'tenantId' | 'productId' | 'apiKey' | 'ingestorUrl'>>;
  private buffer: UsageEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushIntervalMs: number;
  private flushCount: number;
  private onError: (error: Error) => void;

  // Session state
  private activeSessionId: string | null = null;
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
    this.flushCount = config.flushCount ?? 50;
    this.onError = config.onError ?? ((err) => console.error('[aforo-mcp] Error:', err.message));
    this.onSessionKilled = config.onSessionKilled ?? null;

    // Start periodic flush timer
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Unref so the background timer never blocks host-process exit (final flush still needs shutdown()).
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      this.flushTimer.unref();
    }
  }

  // ─── Session lifecycle ───────────────────────────────────────────────
  //
  // Session heartbeats are NOT sent. They used to be pushed into the usage batch
  // as `system.session.heartbeat` events with quantity 0; the ingestor validates
  // every event in a batch (quantity must be positive) and rejects the whole
  // batch with 400 when one is invalid, so each heartbeat took every real tool
  // invocation batched with it down. The ingestor has no dedicated heartbeat
  // endpoint, so there is nowhere correct to send them.

  /** Record the active session (used to match server kill signals). */
  startSession(sessionId: string): void {
    this.activeSessionId = sessionId;
  }

  /** End the current session and flush any remaining events. */
  async endSession(): Promise<void> {
    this.stopSession();
    await this.flush();
  }

  private stopSession(): void {
    this.activeSessionId = null;
  }

  // ─── Tool handler wrapper ──────────────────────────────────────────

  /**
   * Wrap an MCP tool handler to automatically meter invocations.
   * The wrapper extracts tool name, tracks timing, and fires usage events.
   * Records the session from the first tool call that carries a sessionId.
   */
  wrapToolHandler<TReq extends { params: { name: string; arguments?: unknown; _meta?: Record<string, unknown> } }, TRes>(
    handler: (request: TReq) => Promise<TRes>
  ): (request: TReq) => Promise<TRes> {
    return async (request: TReq): Promise<TRes> => {
      const toolName = request.params.name;
      const agentId = (request.params._meta?.agent_id as string) ?? 'unknown';
      const sessionId = (request.params._meta?.session_id as string) ?? undefined;
      const startTime = Date.now();

      // Track the session on the first tool call that carries one
      if (sessionId && !this.activeSessionId) {
        this.startSession(sessionId);
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
        this.recordToolInvocation(toolName, agentId, sessionId, status, durationMs);
      }
    };
  }

  /**
   * Record a tool invocation manually (if not using wrapToolHandler).
   */
  recordToolInvocation(
    toolName: string,
    agentId: string,
    sessionId: string | undefined,
    executionStatus: string,
    executionDurationMs: number
  ): void {
    const event: UsageEvent = {
      customerId: agentId,
      metricName: 'mcp_server.tool_invocations',
      quantity: 1,
      occurredAt: new Date().toISOString(),
      // Unique per event: Date.now() alone collides for two calls of the same
      // tool in the same ms, and the ingestor dedupes the second as a replay.
      idempotencyKey: `mcp:sdk:${agentId}:${sessionId ?? 'no-session'}:${toolName}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
      productType: 'MCP_SERVER',
      toolName,
      agentId,
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
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.config.apiKey,
            'X-Tenant-Id': this.config.tenantId,
          },
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          // Check for kill signals from server
          try {
            const result = (await response.json()) as BatchIngestResponse;
            if (result.killedSessionIds && this.activeSessionId
                && result.killedSessionIds.includes(this.activeSessionId)) {
              const killedId = this.activeSessionId;
              this.stopSession();
              this.onSessionKilled?.(killedId, 'SERVER_KILL');
            }
          } catch {
            // Response body parsing is best-effort — old servers return empty 202
          }
          return;
        }

        if (response.status >= 400 && response.status < 500) {
          this.onError(new Error(`Aforo ingestor returned ${response.status} — not retrying`));
          return;
        }
      } catch (err) {
        if (attempt === 3) {
          this.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }

      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
      }
    }
  }

  /**
   * Stop the flush timer and flush remaining events.
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
