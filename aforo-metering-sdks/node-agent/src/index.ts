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
   * Aforo usage-ingestor URL. Defaults to {@code https://usage-ingestor.aforo.ai/v1/ingest}
   * — override for local dev or air-gapped deployments.
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
  /** Pluggable transport for tests. Defaults to global {@code fetch}. */
  fetchImpl?: typeof fetch;
}

export interface StartSessionOptions {
  agentId: string;
  /** Customer-side identifier for the run (defaults to a generated UUID). */
  sessionId?: string;
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
  metadata?: Record<string, unknown>;
}

export interface EndSessionOptions {
  taskCompleted: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

interface UsageEvent {
  tenantId: string;
  productId: string;
  apiKey: string;
  eventType: string;
  metricKey: string;
  value: number;
  agentId: string;
  sessionId: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

const DEFAULT_INGESTOR = 'https://usage-ingestor.aforo.ai/v1/ingest';

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
      properties: {
        stepKind: options.stepKind,
        stepIndex: this.stepCount,
        capabilityName: options.capabilityName,
        executionStatus: options.executionStatus || 'SUCCESS',
        inputTokens: options.inputTokens || 0,
        outputTokens: options.outputTokens || 0,
        durationMs: options.durationMs || 0,
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
  private readonly buffer: UsageEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: AforoAgentConfig) {
    if (!config.tenantId) throw new Error('AforoAgent: tenantId is required');
    if (!config.productId) throw new Error('AforoAgent: productId is required');
    if (!config.apiKey) throw new Error('AforoAgent: apiKey is required');
    this.fetchImpl = config.fetchImpl
        || (typeof fetch !== 'undefined' ? fetch : null as unknown as typeof fetch);
    if (!this.fetchImpl) {
      throw new Error('AforoAgent: no fetch available — pass fetchImpl in config (Node <18)');
    }
  }

  /** Open a new session. Returns a session handle for emitting per-step events. */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const sessionId = options.sessionId || genId();
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
      agentId: options.agentId,
      sessionId,
      properties: { ...meta },
    });
    return new AgentSession(this, options.agentId, sessionId, meta);
  }

  /**
   * Lower-level emit. Public so the SDK's internal AgentSession can call it,
   * but stable enough to be used directly when an agent framework already
   * has its own lifecycle hooks and just wants to plug in a metering tap.
   */
  async emitEvent(partial: Omit<UsageEvent, 'tenantId' | 'productId' | 'apiKey' | 'timestamp'>): Promise<void> {
    const event: UsageEvent = {
      tenantId: this.config.tenantId,
      productId: this.config.productId,
      apiKey: this.config.apiKey,
      timestamp: new Date().toISOString(),
      ...partial,
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
   * On HTTP failure, logs to console and DROPS the events (best-effort
   * delivery — same posture as the MCP and generic SDKs). For mission-
   * critical billing, prefer the gateway-plugin path; SDK direct-emit is
   * for first-party customers running their own infrastructure.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    const url = this.config.ingestorUrl || DEFAULT_INGESTOR;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'X-Tenant-Id': this.config.tenantId,
        },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[aforo-agent] ingestor returned ${res.status}; dropped ${batch.length} events`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[aforo-agent] flush failed; dropped ${batch.length} events:`, e);
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
