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
 *     ingestorUrl: 'https://ingestor.aforo.ai',
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
  /** Interval between heartbeat emissions in ms (default 30000 = 30s) */
  heartbeatIntervalMs?: number;
  /** Whether to emit periodic heartbeats while a session is active (default true) */
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

  // Heartbeat state
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number;
  private heartbeatEnabled: boolean;
  private activeSessionId: string | null = null;
  private sessionStartedAt: number | null = null;
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
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
    this.heartbeatEnabled = config.heartbeatEnabled ?? true;
    this.onSessionKilled = config.onSessionKilled ?? null;

    // Start periodic flush timer
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  // ─── Heartbeat lifecycle ─────────────────────────────────────────────

  /**
   * Explicitly start a session and begin emitting heartbeats.
   * If not called, heartbeat starts automatically on the first tool call.
   */
  startSession(sessionId: string): void {
    this.activeSessionId = sessionId;
    this.startHeartbeat(sessionId);
  }

  /**
   * End the current session: emit a final SESSION_END heartbeat, stop the
   * heartbeat timer, and flush any remaining events.
   */
  async endSession(): Promise<void> {
    if (this.activeSessionId) {
      this.buffer.push({
        customerId: this.config.tenantId,
        metricName: 'system.session.heartbeat',
        quantity: 0,
        occurredAt: new Date().toISOString(),
        idempotencyKey: `hb:end:${this.activeSessionId}:${Date.now()}`,
        productType: 'MCP_SERVER',
        agentId: '',
        sessionId: this.activeSessionId,
        sessionBoundary: 'SESSION_END',
        executionStatus: 'SUCCESS',
        metadata: { heartbeatType: 'SESSION_END', sdkVersion: SDK_VERSION, sdkLanguage: 'node' },
      });
    }
    this.stopHeartbeat();
    await this.flush();
  }

  private startHeartbeat(sessionId: string): void {
    if (!this.heartbeatEnabled) return;
    if (this.heartbeatTimer) return; // Already running

    this.activeSessionId = sessionId;
    this.sessionStartedAt = Date.now();
    this.emitHeartbeat(); // First heartbeat immediately

    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.activeSessionId = null;
    this.sessionStartedAt = null;
  }

  private emitHeartbeat(): void {
    if (!this.activeSessionId) return;

    const now = Date.now();
    let processMemoryMb: number | undefined;
    try {
      processMemoryMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    } catch {
      // Not available in all runtimes
    }

    this.buffer.push({
      customerId: this.config.tenantId,
      metricName: 'system.session.heartbeat',
      quantity: 0,
      occurredAt: new Date().toISOString(),
      idempotencyKey: `hb:${this.activeSessionId}:${now}`,
      productType: 'MCP_SERVER',
      agentId: '',
      sessionId: this.activeSessionId,
      sessionBoundary: 'HEARTBEAT',
      executionStatus: 'SUCCESS',
      metadata: {
        heartbeatType: 'PERIODIC',
        uptimeMs: now - (this.sessionStartedAt ?? now),
        sdkVersion: SDK_VERSION,
        sdkLanguage: 'node',
        ...(processMemoryMb != null ? { processMemoryMb } : {}),
      },
    });
  }

  // ─── Tool handler wrapper ──────────────────────────────────────────

  /**
   * Wrap an MCP tool handler to automatically meter invocations.
   * The wrapper extracts tool name, tracks timing, and fires usage events.
   * Starts heartbeat on the first tool call if a sessionId is present.
   */
  wrapToolHandler<TReq extends { params: { name: string; arguments?: unknown; _meta?: Record<string, unknown> } }, TRes>(
    handler: (request: TReq) => Promise<TRes>
  ): (request: TReq) => Promise<TRes> {
    return async (request: TReq): Promise<TRes> => {
      const toolName = request.params.name;
      const agentId = (request.params._meta?.agent_id as string) ?? 'unknown';
      const sessionId = (request.params._meta?.session_id as string) ?? undefined;
      const startTime = Date.now();

      // Auto-start heartbeat on first tool call if session exists
      if (sessionId && !this.heartbeatTimer) {
        this.startHeartbeat(sessionId);
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
      idempotencyKey: `mcp:sdk:${agentId}:${sessionId ?? 'no-session'}:${toolName}:${Date.now()}`,
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

    const url = `${this.config.ingestorUrl}/v1/ingest/batch`;
    const body = JSON.stringify({ events });

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
            'X-Tenant-Id': this.config.tenantId,
          },
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          // Check for kill signals from server
          try {
            const result: BatchIngestResponse = await response.json();
            if (result.killedSessionIds && this.activeSessionId
                && result.killedSessionIds.includes(this.activeSessionId)) {
              const killedId = this.activeSessionId;
              this.stopHeartbeat();
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
   * Stop heartbeat and flush timers, flush remaining events.
   */
  async shutdown(): Promise<void> {
    this.stopHeartbeat();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
