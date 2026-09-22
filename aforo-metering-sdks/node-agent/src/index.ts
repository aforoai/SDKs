/**
 * @aforoai/agent-metering — Aforo AI Agent Metering SDK
 *
 * Thin wrapper that turns the agent's runtime lifecycle (start session →
 * record step → record tool call → end session) into Aforo metering events.
 * Sits one layer above the generic {@code @aforo/metering} ingestor client
 * (no peer dependency — events are POSTed directly so the SDK is
 * stand-alone) and is parallel to {@code @aforoai/mcp-metering}'s
 * {@code wrapToolHandler} but for AI agent product types.
 *
 * Usage:
 *   import { AforoAgent } from '@aforoai/agent-metering';
 *
 *   const agent = new AforoAgent({
 *     tenantId: 'tenant_xxx',
 *     productId: 'prod_xxx',
 *     apiKey: process.env.AFORO_API_KEY!,
 *     customerId: 'cust_xxx', // or per session via startSession({ customerId })
 *   });
 *
 *   const session = await agent.startSession({
 *     agentId: 'agt_001', framework: 'CLAUDE',
 *     modelProvider: 'ANTHROPIC', modelName: 'claude-sonnet-4-6',
 *   });
 *
 *   await session.recordStep({
 *     stepKind: 'TOOL_CALL', capabilityName: 'web-search',
 *     inputTokens: 320, outputTokens: 84, durationMs: 510,
 *     executionStatus: 'SUCCESS',
 *   });
 *
 *   await session.end({ taskCompleted: true });
 */

export type AgentFramework =
  | 'CLAUDE'
  | 'GPT'
  | 'LANGCHAIN'
  | 'CREWAI'
  | 'AUTOGEN'
  | 'CUSTOM';

export type ModelProvider =
  | 'ANTHROPIC'
  | 'OPENAI'
  | 'GOOGLE'
  | 'COHERE'
  | 'CUSTOM';

export type StepKind =
  | 'TOOL_CALL'
  | 'THOUGHT'
  | 'OBSERVATION'
  | 'FINAL_ANSWER';

export type ExecutionStatus =
  | 'SUCCESS'
  | 'ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'HITL_REQUIRED';

export interface AforoAgentConfig {
  tenantId: string;
  productId: string;
  apiKey: string;
  /**
   * Aforo customer the agent's usage is billed to. Can be overridden (or
   * supplied only) per session via {@link StartSessionOptions.customerId};
   * one of the two is required.
   */
  customerId?: string;
  /**
   * Top-level {@code productType} stamped on every event (required by the
   * ingestor in production). Defaults to {@code AI_AGENT}; trimmed and
   * uppercased, unknown values are passed through. Overridable per session
   * ({@link StartSessionOptions.productType}) and per event
   * ({@link AgentEventInput.productType}).
   */
  productType?: string;
  /**
   * Aforo usage-ingestor batch URL. Defaults to
   * {@code https://api.aforo.ai/v1/ingest/batch} — override for
   * local dev or air-gapped deployments. A URL ending in {@code /v1/ingest}
   * (the old default) is rewritten to {@code /v1/ingest/batch}.
   */
  ingestorUrl?: string;
  /**
   * Maximum events to buffer before forcing a flush. Defaults to 50.
   * Lower this for low-volume agents to surface metrics faster; raise it
   * for high-volume agents to amortize the per-batch HTTP cost.
   */
  flushBatchSize?: number;
  /**
   * Maximum milliseconds an event can sit in the buffer before flush.
   * Defaults to 5000 (5s). Forces flush on session.end() regardless.
   */
  flushIntervalMs?: number;
  /**
   * Attempts per batch for 408/429/5xx/network failures (other 4xx are never
   * retried). Defaults to 3.
   */
  maxRetries?: number;
  /** Base backoff between attempts in ms (doubles each time; a 429's Retry-After wins). Defaults to 1000. */
  retryBaseDelayMs?: number;
  /** Pluggable transport for tests. Defaults to global {@code fetch}. */
  fetchImpl?: typeof fetch;
}

export interface StartSessionOptions {
  agentId: string;
  /** Aforo customer to bill for this run. Defaults to the client's {@code customerId}. */
  customerId?: string;
  /** Customer-side identifier for the run (defaults to a generated UUID). */
  sessionId?: string;
  /** Distributed-trace id for the run. Defaults to the sessionId. */
  traceId?: string;
  /** Product type for this session's events. Defaults to the client's {@code productType}. */
  productType?: string;
  framework?: AgentFramework;
  modelProvider?: ModelProvider;
  modelName?: string;
  /** Free-form metadata — landed in the metric event's properties block. */
  metadata?: Record<string, unknown>;
}

export interface RecordStepOptions {
  stepKind: StepKind;
  capabilityName?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  executionStatus?: ExecutionStatus;
  /** Id of the step that spawned this one (sub-agent / nested tool call). */
  parentStepId?: string;
  metadata?: Record<string, unknown>;
}

export interface EndSessionOptions {
  taskCompleted: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input to {@link AforoAgent.emitEvent}. {@code properties} keys that have a
 * first-class ingest field (capabilityName, executionStatus, durationMs,
 * stepIndex, parentStepId) are promoted to it; everything else lands in the
 * event's {@code metadata}.
 */
export interface AgentEventInput {
  eventType: string;
  metricKey: string;
  value: number;
  agentId: string;
  sessionId: string;
  properties: Record<string, unknown>;
  /** Defaults to the client's {@code customerId}. */
  customerId?: string;
  /** Defaults to the sessionId. */
  traceId?: string;
  /** Defaults to the client's {@code productType} ({@code AI_AGENT}). */
  productType?: string;
}

/** One event in a {@code POST /v1/ingest/batch} body (usage-ingestor IngestUsageEventRequest). */
interface IngestEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
  idempotencyKey: string;
  productType: string;
  agentId: string;
  sessionId: string;
  traceId: string;
  stepNumber?: number;
  parentStepId?: string;
  capabilityName?: string;
  executionStatus?: 'SUCCESS' | 'ERROR' | 'TIMEOUT';
  executionDurationMs?: number;
  metadata: Record<string, unknown>;
}

const DEFAULT_INGESTOR = 'https://api.aforo.ai/v1/ingest/batch';
const DEFAULT_PRODUCT_TYPE = 'AI_AGENT';
/** Ingestor limit on agentId (IngestUsageEventRequest @Size(max = 36)). */
const MAX_AGENT_ID = 36;
/** The ingestor rejects batches over 1000 events. */
const MAX_BATCH_EVENTS = 1000;
/** executionStatus values the ingestor accepts; others ride in metadata.agentExecutionStatus. */
const INGEST_EXECUTION_STATUSES = new Set(['SUCCESS', 'ERROR', 'TIMEOUT']);

let eventSeq = 0;

function normalizeProductType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a UUID v4 without depending on Node's crypto module so the SDK
 * works in browser-bundled / edge-runtime contexts too. Not crypto-grade —
 * the session id is observable in metering events anyway.
 */
function genId(): string {
  return 'sess_' + Math.random().toString(36).substring(2, 10)
      + Date.now().toString(36);
}

/**
 * Per-run handle returned by {@link AforoAgent.startSession}. Exposes
 * {@link recordStep} and {@link recordToolCall} which are session-scoped
 * (auto-attach sessionId + agentId to the event), and {@link end} which
 * forces a final flush.
 */
export class AgentSession {
  private stepCount = 0;

  constructor(
      private readonly client: AforoAgent,
      readonly agentId: string,
      readonly sessionId: string,
      private readonly meta: Record<string, unknown>,
      readonly customerId?: string,
      readonly traceId?: string,
      readonly productType?: string,
  ) {}

  /**
   * Record a single step in the agent's reasoning loop. Each step counts
   * toward the {@code agent_step} metric on the AI_AGENT product type.
   */
  async recordStep(options: RecordStepOptions): Promise<void> {
    this.stepCount += 1;
    await this.client.emitEvent({
      eventType: 'agent_step',
      metricKey: 'step_count',
      value: 1,
      agentId: this.agentId,
      sessionId: this.sessionId,
      customerId: this.customerId,
      traceId: this.traceId,
      productType: this.productType,
      properties: {
        stepKind: options.stepKind,
        stepIndex: this.stepCount,
        capabilityName: options.capabilityName,
        executionStatus: options.executionStatus || 'SUCCESS',
        inputTokens: options.inputTokens || 0,
        outputTokens: options.outputTokens || 0,
        durationMs: options.durationMs,
        parentStepId: options.parentStepId,
        ...this.meta,
        ...(options.metadata || {}),
      },
    });
    if (options.inputTokens || options.outputTokens) {
      await this.client.emitEvent({
        eventType: 'token_usage',
        metricKey: 'tokens_total',
        value: (options.inputTokens || 0) + (options.outputTokens || 0),
        agentId: this.agentId,
        sessionId: this.sessionId,
        customerId: this.customerId,
        traceId: this.traceId,
        productType: this.productType,
        properties: {
          inputTokens: options.inputTokens || 0,
          outputTokens: options.outputTokens || 0,
          stepIndex: this.stepCount,
          ...this.meta,
        },
      });
    }
  }

  /**
   * Convenience for the common case where the step IS a tool call —
   * stamps the step kind and ensures capabilityName is present.
   */
  async recordToolCall(toolName: string, options: Omit<RecordStepOptions, 'stepKind' | 'capabilityName'> = {}): Promise<void> {
    return this.recordStep({
      ...options,
      stepKind: 'TOOL_CALL',
      capabilityName: toolName,
    });
  }

  /**
   * End the session. Emits a final {@code agent_session_end} event with the
   * step count and task outcome, then forces a buffer flush so the metrics
   * land in Aforo's analytics tier before the agent process exits.
   */
  async end(options: EndSessionOptions): Promise<void> {
    await this.client.emitEvent({
      eventType: 'agent_session_end',
      metricKey: 'session_completed',
      value: 1,
      agentId: this.agentId,
      sessionId: this.sessionId,
      customerId: this.customerId,
      traceId: this.traceId,
      productType: this.productType,
      properties: {
        stepCount: this.stepCount,
        taskCompleted: options.taskCompleted,
        errorMessage: options.errorMessage,
        ...this.meta,
        ...(options.metadata || {}),
      },
    });
    await this.client.flush();
  }
}

/**
 * Top-level SDK client. Holds buffered events and flushes them in batches.
 * One instance per process is enough — sessions share the same flush queue.
 */
export class AforoAgent {
  private readonly buffer: IngestEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly productType: string;

  constructor(private readonly config: AforoAgentConfig) {
    if (!config.tenantId) throw new Error('AforoAgent: tenantId is required');
    if (!config.productId) throw new Error('AforoAgent: productId is required');
    if (!config.apiKey) throw new Error('AforoAgent: apiKey is required');
    this.fetchImpl = config.fetchImpl
        || (typeof fetch !== 'undefined' ? fetch : null as unknown as typeof fetch);
    if (!this.fetchImpl) {
      throw new Error('AforoAgent: no fetch available — pass fetchImpl in config (Node <18)');
    }
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
  }

  /** Open a new session. Returns a session handle for emitting per-step events. */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const sessionId = options.sessionId || genId();
    const customerId = options.customerId || this.config.customerId;
    if (!customerId || !customerId.trim()) {
      throw new Error('AforoAgent: customerId is required (config.customerId or startSession({ customerId }))');
    }
    if (!options.agentId || !options.agentId.trim()) {
      throw new Error('AforoAgent: agentId is required');
    }
    if (options.agentId.trim().length > MAX_AGENT_ID) {
      throw new Error(`AforoAgent: agentId must be at most ${MAX_AGENT_ID} characters`);
    }
    const agentId = options.agentId.trim();
    const productType = normalizeProductType(options.productType);
    const traceId = options.traceId || sessionId;
    const meta: Record<string, unknown> = {
      framework: options.framework || 'CUSTOM',
      modelProvider: options.modelProvider,
      modelName: options.modelName,
      ...(options.metadata || {}),
    };
    await this.emitEvent({
      eventType: 'agent_session_start',
      metricKey: 'session_count',
      value: 1,
      agentId,
      sessionId,
      customerId,
      traceId,
      productType,
      properties: { ...meta },
    });
    return new AgentSession(this, agentId, sessionId, meta, customerId, traceId, productType);
  }

  /**
   * Lower-level emit. Public so the SDK's internal AgentSession can call it,
   * but stable enough to be used directly when an agent framework already
   * has its own lifecycle hooks and just wants to plug in a metering tap.
   *
   * An event the ingestor would reject -- blank metricKey, agentId (or one
   * over 36 chars) or sessionId, or a value that is not > 0 -- is logged and
   * dropped instead of buffered, because one invalid event fails its whole
   * batch.
   */
  async emitEvent(partial: AgentEventInput): Promise<void> {
    const customerId = partial.customerId || this.config.customerId;
    if (!customerId || !customerId.trim()) {
      throw new Error('AforoAgent: customerId is required (config.customerId or emitEvent({ customerId }))');
    }
    const agentId = typeof partial.agentId === 'string' ? partial.agentId.trim() : '';
    const sessionId = typeof partial.sessionId === 'string' ? partial.sessionId.trim() : '';
    const invalid: string[] = [];
    if (typeof partial.metricKey !== 'string' || !partial.metricKey.trim()) invalid.push('metricKey');
    if (!agentId || agentId.length > MAX_AGENT_ID) invalid.push(`agentId (1-${MAX_AGENT_ID} chars)`);
    if (!sessionId) invalid.push('sessionId');
    if (typeof partial.value !== 'number' || !Number.isFinite(partial.value) || partial.value <= 0) {
      invalid.push('value > 0');
    }
    if (invalid.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[aforo-agent] event ${partial.eventType} dropped; missing/invalid ${invalid.join(', ')}`);
      return;
    }
    // Promote properties that have a first-class ingest field; the rest is metadata.
    const {
      capabilityName, executionStatus, durationMs, stepIndex, parentStepId, ...rest
    } = partial.properties || {};
    const status = typeof executionStatus === 'string' ? executionStatus.toUpperCase() : undefined;
    const now = new Date();
    const event: IngestEvent = {
      customerId,
      metricName: partial.metricKey,
      quantity: partial.value,
      occurredAt: now.toISOString(),
      // Minted once here and never regenerated, so a replayed event dedupes.
      idempotencyKey: `agent:${sessionId}:${partial.eventType}:${now.getTime().toString(36)}:${(eventSeq++).toString(36)}:${Math.random().toString(36).substring(2, 10)}`.slice(-255),
      productType: normalizeProductType(partial.productType) ?? this.productType,
      agentId,
      sessionId,
      traceId: partial.traceId || sessionId,
      stepNumber: typeof stepIndex === 'number' ? stepIndex : undefined,
      parentStepId: typeof parentStepId === 'string' ? parentStepId.slice(0, 64) : undefined,
      capabilityName: typeof capabilityName === 'string' ? capabilityName.slice(0, 64) : undefined,
      executionStatus: status && INGEST_EXECUTION_STATUSES.has(status)
        ? status as IngestEvent['executionStatus'] : undefined,
      executionDurationMs: typeof durationMs === 'number' ? Math.round(durationMs) : undefined,
      metadata: {
        ...rest,
        eventType: partial.eventType,
        productId: this.config.productId,
        // CANCELLED / HITL_REQUIRED have no ingest enum value — keep them visible here.
        ...(status && !INGEST_EXECUTION_STATUSES.has(status) ? { agentExecutionStatus: status } : {}),
      },
    };
    this.buffer.push(event);
    if (this.buffer.length >= (this.config.flushBatchSize || 50)) {
      await this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Force a flush of the buffered events. Called automatically by
   * {@link AgentSession.end}; call manually if your agent process is about
   * to exit and you want to guarantee delivery.
   *
   * Retries 408/429/5xx/network failures (honouring a 429's Retry-After),
   * then logs to console and DROPS the events (best-effort delivery — same
   * posture as the MCP and generic SDKs). Other 4xx are never retried. For
   * mission-critical billing, prefer the gateway-plugin path; SDK direct-emit
   * is for first-party customers running their own infrastructure.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const pending = this.buffer.splice(0, this.buffer.length);
    const url = (this.config.ingestorUrl || DEFAULT_INGESTOR).replace(/\/v1\/ingest\/?$/, '/v1/ingest/batch');
    for (let i = 0; i < pending.length; i += MAX_BATCH_EVENTS) {
      await this.send(url, pending.slice(i, i + MAX_BATCH_EVENTS));
    }
  }

  private async send(url: string, batch: IngestEvent[]): Promise<void> {
    // Serialised once, so every retry re-sends the same idempotency keys.
    const body = JSON.stringify({ events: batch });
    const maxAttempts = Math.max(1, this.config.maxRetries ?? 3);
    const baseDelay = this.config.retryBaseDelayMs ?? 1000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let delayMs = baseDelay * Math.pow(2, attempt - 1);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'X-API-Key': this.config.apiKey,
            'Content-Type': 'application/json',
            'X-Tenant-Id': this.config.tenantId,
          },
          body,
        });
        if (res.ok) {
          await this.reportRejected(res);
          return;
        }
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        if (!retryable || attempt === maxAttempts) {
          // eslint-disable-next-line no-console
          console.warn(`[aforo-agent] ingestor returned ${res.status}; dropped ${batch.length} events`);
          return;
        }
        if (res.status === 429) {
          const retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('Retry-After') : null;
          const seconds = retryAfter ? parseInt(retryAfter, 10) : NaN;
          if (!isNaN(seconds) && seconds >= 0) delayMs = seconds * 1000;
        }
      } catch (e) {
        if (attempt === maxAttempts) {
          // eslint-disable-next-line no-console
          console.warn(`[aforo-agent] flush failed; dropped ${batch.length} events:`, e);
          return;
        }
      }
      await sleep(delayMs);
    }
  }

  /** Logs per-event rejections from a 2xx batch response ({@code errors[].message}). */
  private async reportRejected(res: Response): Promise<void> {
    try {
      const result = await res.json() as { failed?: number; errors?: Array<{ index: number; message: string }> };
      if (result && typeof result.failed === 'number' && result.failed > 0) {
        const detail = (result.errors || []).slice(0, 5).map((e) => `#${e.index}: ${e.message}`).join('; ');
        // eslint-disable-next-line no-console
        console.warn(`[aforo-agent] ingestor rejected ${result.failed} event(s)${detail ? `: ${detail}` : ''}`);
      }
    } catch {
      // Empty or non-JSON 2xx body: nothing to report.
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const interval = this.config.flushIntervalMs || 5000;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => { /* swallowed in flush() */ });
    }, interval);
  }
}

export default AforoAgent;
