/**
 * @aforoai/agent-metering — Aforo AI Agent Metering SDK
 *
 * Turns an agent's runtime lifecycle (start session → steps / tool calls /
 * tokens → end session) into Aforo usage events and POSTs them, batched, to
 * the usage ingestor's batch endpoint (`POST /v1/ingest/batch`, body
 * `{"events":[…]}`, header `X-API-Key`). Stand-alone: no runtime dependencies.
 *
 * Usage:
 *   import { AforoAgent } from '@aforoai/agent-metering';
 *
 *   const agent = new AforoAgent({
 *     apiKey: process.env.AFORO_API_KEY!,   // workspace API key
 *     customerId: 'cust_xxx',                // Aforo customer billed for the usage
 *     agentId: 'support-bot',                // ≤ 36 chars
 *     onError: (err) => console.error(err.kind, err.message),
 *   });
 *
 *   const session = agent.startSession({ framework: 'CLAUDE', modelProvider: 'ANTHROPIC' });
 *   await session.recordToolCall('web_search', { durationMs: 510 });
 *   await session.recordTokens('claude-sonnet-4-6', 320, 84);
 *   await session.endSession({ taskCompleted: true });   // flushes
 */

import { TransportCore, type CoreDropReason, type CoreFetch, type CoreTransportError } from './transport-core/core';

export type AgentFramework = 'CLAUDE' | 'GPT' | 'LANGCHAIN' | 'CREWAI' | 'AUTOGEN' | 'CUSTOM';

export type ModelProvider = 'ANTHROPIC' | 'OPENAI' | 'GOOGLE' | 'COHERE' | 'CUSTOM';

export type StepKind = 'TOOL_CALL' | 'THOUGHT' | 'OBSERVATION' | 'FINAL_ANSWER';

/** The 11 canonical execution statuses the usage ingestor accepts (contract/ingest-contract.json). */
export const EXECUTION_STATUSES = [
  'SUCCESS',
  'PARTIAL',
  'TIMEOUT',
  'ERROR',
  'VALIDATION_FAILED',
  'FAILED',
  'FAILURE',
  'CANCELLED',
  'PENDING',
  'BLOCKED',
  'HITL_REQUIRED',
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * Catalog metric names the SDK emits. Defaults are the exact names of the
 * default AI_AGENT catalog metrics; override any of them with
 * {@link AforoAgentConfig.metricNames} if your catalog uses different names.
 */
export interface MetricNames {
  /** One per session, on the session-closing event. */
  sessions: string;
  /** One per recordStep(). */
  steps: string;
  /** One per tool call (recordToolCall(), or recordStep({ stepKind: 'TOOL_CALL' })). */
  toolCalls: string;
  /** input + output tokens, per recordTokens() / step with tokens. */
  tokens: string;
  executionMinutes: string;
  gpuHours: string;
  knowledgeQueries: string;
  /** One per session ended with taskCompleted: true. */
  tasksCompleted: string;
  activeAgents: string;
}

export const DEFAULT_METRIC_NAMES: Readonly<MetricNames> = Object.freeze({
  sessions: 'Agent Sessions',
  steps: 'Agent Steps',
  toolCalls: 'Agent Tool Calls',
  tokens: 'Tokens Consumed',
  executionMinutes: 'Execution Minutes',
  gpuHours: 'GPU Hours',
  knowledgeQueries: 'Knowledge Queries',
  tasksCompleted: 'Tasks Completed',
  activeAgents: 'Active Agents',
});

/** One event exactly as sent inside `{"events":[…]}` to `/v1/ingest/batch`. */
export interface IngestEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  /** ISO-8601 UTC. */
  occurredAt: string;
  /** Deterministic per event: `<sessionId>:<sequence>`. Reused by every retry. */
  idempotencyKey: string;
  productType: string;
  agentId: string;
  sessionId: string;
  traceId?: string;
  subscriptionId?: string;
  capabilityName?: string;
  executionStatus?: ExecutionStatus;
  executionDurationMs?: number;
  stepNumber?: number;
  parentStepId?: string;
  /** Set to SESSION_END on the session-closing event only. */
  sessionBoundary?: 'SESSION_END';
  metadata: Record<string, unknown>;
}

/** @deprecated Use {@link IngestEvent}. Kept so existing `onDrop` handlers type-check. */
export type UsageEvent = IngestEvent;

/**
 * What went wrong:
 * - `retrying`  — the ingestor was unreachable, answered 401/403, 408, 429 or
 *                 5xx on every attempt. The events are KEPT (same idempotency
 *                 keys) and re-sent with backoff once it recovers.
 * - `rejected`  — the ingestor refused events for good: a non-retryable 4xx for
 *                 the whole batch, or per-event errors in a 2xx answer.
 * - `invalid`   — an event failed a client-side check and was never sent.
 * - `overflow`  — the queue hit `maxBufferSize`; the oldest events were dropped.
 * - `shutdown`  — still queued when `shutdown()` hit its deadline.
 * - `closed`    — recorded after `shutdown()`.
 */
export type AforoErrorKind = 'retrying' | 'rejected' | 'invalid' | 'overflow' | 'shutdown' | 'closed';

export interface AforoAgentError {
  kind: AforoErrorKind;
  message: string;
  /**
   * Events affected: the dropped events for every kind except `retrying`
   * (which keeps its events queued and lists none). Empty when the ingestor
   * reported failures without naming the events.
   */
  events: IngestEvent[];
  /** True when the events are still queued and will be re-sent. */
  willRetry: boolean;
}

/** @deprecated Reasons passed to the legacy `onDrop` hook. */
export type DropReason = CoreDropReason;

export interface AforoLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface AforoAgentConfig {
  /** Workspace API key, sent as `X-API-Key`. Required. */
  apiKey: string;
  /** Aforo customer (customer-service id) billed for the usage. Overridable per session. */
  customerId?: string;
  /** Optional subscription to bill against. Overridable per session. */
  subscriptionId?: string;
  /** Default agent id (≤ 36 chars). Overridable per session. */
  agentId?: string;
  /**
   * Batch ingest URL. Default `https://api.aforo.ai/v1/ingest/batch`. A bare
   * host gets `/v1/ingest/batch`; a URL ending in `/v1/ingest` (or
   * `/v1/ingest/events`) gets `/batch`.
   */
  endpoint?: string;
  /** Aforo product id; sent as `metadata.productId`. */
  productId?: string;
  /** Override catalog metric names (defaults: {@link DEFAULT_METRIC_NAMES}). */
  metricNames?: Partial<MetricNames>;
  /** Max ms an event waits before a timed flush. Default 5000. */
  flushIntervalMs?: number;
  /** Events per request, 1..1000. Default 500. A full batch wakes the sender. */
  maxBatchSize?: number;
  /** Max events held in memory (including ones kept during an outage). Default 10000. */
  maxBufferSize?: number;
  /**
   * Attempts per request for 408/429/5xx/network failures before the batch is
   * re-queued and the sender pauses (breaker, 5 s doubling to 5 min). Default 4.
   */
  maxRetries?: number;
  /** Backoff base in ms (full jitter, doubling per attempt); Retry-After is honoured. Default 500. */
  retryBaseDelayMs?: number;
  /** Total deadline per request in ms. Default 10000. */
  requestTimeoutMs?: number;
  /** How long `shutdown()` keeps sending, in ms. Default 5000; what is left is dropped as `shutdown`. */
  shutdownTimeoutMs?: number;
  /** Flush on the process 'beforeExit' event, within `shutdownTimeoutMs`. Default true. */
  flushOnExit?: boolean;
  /** Allow a plain http:// endpoint on a host other than localhost / 127.0.0.1 / ::1. */
  allowInsecureHttp?: boolean;
  /** `productType` on every event. Default `AI_AGENT`. */
  productType?: string;
  /** Called for every delivery problem. When unset, problems are logged via `logger`. */
  onError?: (error: AforoAgentError) => void;
  /** Where warnings go when `onError` is unset. Default `console`; `null` silences. */
  logger?: AforoLogger | null;
  /** Pluggable transport (tests, Node < 18). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;

  /** @deprecated Not needed: the API key identifies the tenant. Ignored. */
  tenantId?: string;
  /** @deprecated Use `endpoint`. */
  ingestorUrl?: string;
  /** @deprecated Use `maxBatchSize`. */
  flushBatchSize?: number;
  /** @deprecated Use `onError`. Called with events that are permanently dropped. */
  onDrop?: (events: IngestEvent[], reason: DropReason) => void;
}

export interface StartSessionOptions {
  /** Defaults to the client's `agentId`. ≤ 36 chars. */
  agentId?: string;
  customerId?: string;
  subscriptionId?: string;
  /** Unique per run (≤ 64 chars). Generated (UUID) if omitted. Idempotency keys derive from it. */
  sessionId?: string;
  /** Distributed-trace id. Generated (32 hex chars) if omitted. */
  traceId?: string;
  productType?: string;
  framework?: AgentFramework;
  modelProvider?: ModelProvider | string;
  modelName?: string;
  /** Merged into every event's metadata. */
  metadata?: Record<string, unknown>;
}

export interface RecordStepOptions {
  stepKind?: StepKind;
  capabilityName?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  executionStatus?: ExecutionStatus | string;
  parentStepId?: string;
  /** Model for the step's tokens; defaults to the session's modelName. */
  modelName?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordTokensOptions {
  provider?: ModelProvider | string;
  capabilityName?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordUsageOptions {
  capabilityName?: string;
  executionStatus?: ExecutionStatus | string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface EndSessionOptions {
  /** Emits one `Tasks Completed` event when true. */
  taskCompleted?: boolean;
  errorMessage?: string;
  /** Emits `Execution Minutes` with this quantity (skipped when 0 / unset). */
  executionMinutes?: number;
  metadata?: Record<string, unknown>;
}

export interface FlushResult {
  /** Events the ingestor accepted (including duplicates it already had). */
  accepted: number;
  /** Events permanently dropped during this flush. */
  failed: number;
  /** Events put back on the queue (outage, or per-event `retryable`). */
  requeued: number;
  /** Events still queued when the flush ended. */
  pending: number;
}

/**
 * @deprecated Legacy input for {@link AforoAgent.emitEvent}. `metricKey` is
 * sent as `metricName`, `value` as `quantity`, `properties` as `metadata`.
 */
export interface AgentEventInput {
  eventType?: string;
  metricKey: string;
  value: number;
  agentId?: string;
  sessionId: string;
  capabilityName?: string;
  customerId?: string;
  productType?: string;
  traceId?: string;
  properties?: Record<string, unknown>;
}

const DEFAULT_ENDPOINT = 'https://api.aforo.ai/v1/ingest/batch';
const DEFAULT_PRODUCT_TYPE = 'AI_AGENT';
const SDK_VERSION = '2.0.0';
/** IngestUsageEventRequest @Size limits. */
const LIMITS = {
  customerId: 64,
  metricName: 255,
  agentId: 36,
  sessionId: 64,
  traceId: 128,
  subscriptionId: 64,
  capabilityName: 64,
  parentStepId: 64,
  productType: 20,
} as const;

function clip(value: unknown): string {
  return String(value).slice(0, 80);
}

function cryptoObj(): { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined {
  return (globalThis as any).crypto;
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  const c = cryptoObj();
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(arr);
  else for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function genSessionId(): string {
  const c = cryptoObj();
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const h = randomHex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Resolve the batch URL from `endpoint` (or the deprecated `ingestorUrl`). */
export function resolveEndpoint(url?: string): string {
  let u = (url || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  if (/\/ingest\/batch$/.test(u)) return u;
  u = u.replace(/\/ingest\/events$/, '/ingest');
  if (/\/ingest$/.test(u)) return u + '/batch';
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i.test(u)) return u + '/v1/ingest/batch';
  return u;
}

function normalizeProductType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t ? t.toUpperCase() : undefined;
}

/**
 * Per-run handle returned by {@link AforoAgent.startSession}. Every event it
 * emits carries the session's agentId, sessionId, traceId, customerId and a
 * deterministic idempotency key `<sessionId>:<n>`.
 */
export class AgentSession {
  readonly startedAt = Date.now();
  private seq = 0;
  private steps = 0;
  private ended = false;

  /** @internal — use {@link AforoAgent.startSession}. */
  constructor(
    private readonly client: AforoAgent,
    readonly agentId: string,
    readonly sessionId: string,
    readonly traceId: string,
    readonly customerId: string,
    readonly subscriptionId: string | undefined,
    readonly productType: string,
    readonly modelProvider: string | undefined,
    readonly modelName: string | undefined,
    private readonly meta: Record<string, unknown>,
  ) {}

  /** Number of steps recorded so far. */
  get stepCount(): number {
    return this.steps;
  }

  /** True after {@link end} / {@link endSession}. */
  get isEnded(): boolean {
    return this.ended;
  }

  /** @internal */
  nextIdempotencyKey(): string {
    this.seq += 1;
    return `${this.sessionId}:${this.seq}`;
  }

  /**
   * One reasoning step → `Agent Steps` (1). A `TOOL_CALL` step also emits
   * `Agent Tool Calls` (1); tokens on the step emit `Tokens Consumed`.
   */
  async recordStep(options: RecordStepOptions = {}): Promise<void> {
    this.steps += 1;
    const stepNumber = this.steps;
    const status = this.client.normalizeStatus(options.executionStatus);
    const common = {
      capabilityName: options.capabilityName,
      executionStatus: status,
      durationMs: options.durationMs,
      stepNumber,
      parentStepId: options.parentStepId,
    };
    const meta = { ...(options.stepKind ? { stepKind: options.stepKind } : {}), ...(options.metadata || {}) };
    this.client.enqueue(this, this.client.metricNames.steps, 1, { ...common, metadata: meta });
    if (options.stepKind === 'TOOL_CALL') {
      this.client.enqueue(this, this.client.metricNames.toolCalls, 1, { ...common, metadata: meta });
    }
    if (options.inputTokens || options.outputTokens) {
      this.client.enqueue(this, this.client.metricNames.tokens, (options.inputTokens || 0) + (options.outputTokens || 0), {
        capabilityName: options.capabilityName,
        stepNumber,
        metadata: this.tokenMeta(options.modelName, options.inputTokens, options.outputTokens, undefined, options.metadata),
      });
    }
  }

  /** A tool call: same as `recordStep({ stepKind: 'TOOL_CALL', capabilityName: toolName, ... })`. */
  async recordToolCall(
    toolName: string,
    options: Omit<RecordStepOptions, 'stepKind' | 'capabilityName'> = {},
  ): Promise<void> {
    return this.recordStep({ ...options, stepKind: 'TOOL_CALL', capabilityName: toolName });
  }

  /** `Tokens Consumed` = input + output (skipped when both are 0). */
  async recordTokens(
    model: string | undefined,
    inputTokens: number,
    outputTokens: number,
    options: RecordTokensOptions = {},
  ): Promise<void> {
    this.client.enqueue(this, this.client.metricNames.tokens, (inputTokens || 0) + (outputTokens || 0), {
      capabilityName: options.capabilityName,
      metadata: this.tokenMeta(model, inputTokens, outputTokens, options.provider, options.metadata),
    });
  }

  /**
   * Any other metric, e.g. `recordUsage('knowledgeQueries', 1)` or
   * `recordUsage('gpuHours', 0.25)`. `metric` is a key of {@link MetricNames}
   * or a literal catalog metric name. Zero quantities are skipped.
   */
  async recordUsage(metric: keyof MetricNames | string, quantity: number, options: RecordUsageOptions = {}): Promise<void> {
    const names = this.client.metricNames as unknown as Record<string, string>;
    const metricName = Object.prototype.hasOwnProperty.call(names, metric) ? names[metric] : metric;
    this.client.enqueue(this, metricName, quantity, {
      capabilityName: options.capabilityName,
      executionStatus: options.executionStatus === undefined ? undefined : this.client.normalizeStatus(options.executionStatus),
      durationMs: options.durationMs,
      metadata: options.metadata || {},
    });
  }

  /**
   * Close the session: `Tasks Completed` (if `taskCompleted`), `Execution
   * Minutes` (if given), then `Agent Sessions` (1) carrying
   * `sessionBoundary: SESSION_END`; then flushes. Calling it twice is a no-op.
   */
  async end(options: EndSessionOptions = {}): Promise<FlushResult> {
    if (this.ended) return this.client.flush();
    this.ended = true;
    const meta = {
      stepCount: this.steps,
      ...(options.taskCompleted !== undefined ? { taskCompleted: options.taskCompleted } : {}),
      ...(options.errorMessage ? { errorMessage: String(options.errorMessage).slice(0, 500) } : {}),
      ...(options.metadata || {}),
    };
    if (options.taskCompleted) {
      this.client.enqueue(this, this.client.metricNames.tasksCompleted, 1, { metadata: meta });
    }
    if (options.executionMinutes) {
      this.client.enqueue(this, this.client.metricNames.executionMinutes, options.executionMinutes, { metadata: meta });
    }
    this.client.enqueue(this, this.client.metricNames.sessions, 1, {
      executionStatus: options.taskCompleted === false ? 'FAILED' : 'SUCCESS',
      durationMs: Date.now() - this.startedAt,
      sessionBoundary: 'SESSION_END',
      metadata: meta,
    });
    return this.client.flush();
  }

  /** Alias of {@link end}. */
  endSession(options: EndSessionOptions = {}): Promise<FlushResult> {
    return this.end(options);
  }

  /** @internal */
  baseMetadata(): Record<string, unknown> {
    return this.meta;
  }

  private tokenMeta(
    model: string | undefined,
    input: number | undefined,
    output: number | undefined,
    provider: string | undefined,
    extra: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(extra || {}) };
    const p = provider || this.modelProvider;
    const m = model || this.modelName;
    if (p) out.model_provider = p;
    if (m) out.model_name = m;
    out.input_tokens = input || 0;
    out.output_tokens = output || 0;
    return out;
  }
}

interface EnqueueExtras {
  capabilityName?: string;
  executionStatus?: ExecutionStatus;
  durationMs?: number;
  stepNumber?: number;
  parentStepId?: string;
  sessionBoundary?: 'SESSION_END';
  metadata: Record<string, unknown>;
}

/**
 * Top-level client. Events go on a bounded queue; one background sender posts
 * them in batches of ≤ `maxBatchSize` to `/v1/ingest/batch` (the shared Node
 * transport core, contract/TRANSPORT-SPEC.md). Record calls never wait on the
 * network and never throw; problems go to `onError` (or the logger).
 */
export class AforoAgent {
  readonly metricNames: Readonly<MetricNames>;
  readonly endpoint: string;
  private readonly core: TransportCore<IngestEvent>;
  private readonly productType: string;
  private readonly logger: AforoLogger | null;

  constructor(private readonly config: AforoAgentConfig) {
    if (!config || !config.apiKey) throw new Error('AforoAgent: apiKey is required');
    const f = config.fetchImpl || (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!f) throw new Error('AforoAgent: no fetch available — pass fetchImpl in config (Node < 18)');
    this.endpoint = resolveEndpoint(config.endpoint || config.ingestorUrl);
    let url: URL;
    try {
      url = new URL(this.endpoint);
    } catch {
      throw new Error(`AforoAgent: endpoint is not a valid URL: ${clip(this.endpoint)}`);
    }
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.metricNames = Object.freeze({ ...DEFAULT_METRIC_NAMES, ...(config.metricNames || {}) });
    this.logger = config.logger === undefined ? console : config.logger;
    // The key lives in the core's non-enumerable headers; keep config out of inspect()/JSON too.
    Object.defineProperty(this, 'config', { enumerable: false });

    const attempts = Math.max(1, Math.floor(config.maxRetries ?? 4));
    const log = (m: string) => this.logger?.warn(`[aforo-agent] ${m}`);
    this.core = new TransportCore<IngestEvent>({
      baseUrl: url.origin,
      path: url.pathname + url.search,
      apiKey: config.apiKey,
      allowInsecureHttp: config.allowInsecureHttp,
      userAgent: `aforo-agent-metering-node/${SDK_VERSION}`,
      flushCount: config.maxBatchSize ?? config.flushBatchSize,
      flushIntervalMs: config.flushIntervalMs,
      maxQueueSize: config.maxBufferSize,
      maxRetries: attempts - 1,
      retryBaseMs: config.retryBaseDelayMs,
      timeoutMs: config.requestTimeoutMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      flushOnExit: config.flushOnExit,
      fetch: f as unknown as CoreFetch,
      logger: { debug: () => undefined, warn: log, error: log },
      onDrop: (events, reason, detail) => this.onCoreDrop(events, reason, detail),
      onError: (err) => this.onCoreError(err),
    });
  }

  /**
   * Open a session. Synchronous (no network); the returned handle is also
   * safe to `await` for code written against the 1.x async signature.
   */
  startSession(options: StartSessionOptions = {}): AgentSession {
    const agentId = (options.agentId ?? this.config.agentId ?? '').trim();
    const customerId = (options.customerId ?? this.config.customerId ?? '').trim();
    const meta: Record<string, unknown> = {
      ...(options.framework ? { framework: options.framework } : {}),
      ...(this.config.productId ? { productId: this.config.productId } : {}),
      ...(options.metadata || {}),
    };
    return new AgentSession(
      this,
      agentId,
      options.sessionId || genSessionId(),
      options.traceId || randomHex(16),
      customerId,
      options.subscriptionId ?? this.config.subscriptionId,
      normalizeProductType(options.productType) ?? this.productType,
      options.modelProvider,
      options.modelName,
      meta,
    );
  }

  /**
   * @deprecated Use session methods ({@link AgentSession.recordUsage}). Kept
   * for 1.x callers: `metricKey` → `metricName`, `value` → `quantity`,
   * `properties` → `metadata`; idempotency key is random.
   */
  async emitEvent(partial: AgentEventInput): Promise<void> {
    if (partial.value === 0) return;
    const event: IngestEvent = {
      customerId: String(partial.customerId ?? this.config.customerId ?? '').trim(),
      metricName: partial.metricKey,
      quantity: partial.value,
      occurredAt: new Date().toISOString(),
      idempotencyKey: `${partial.sessionId}:${randomHex(8)}`,
      productType: normalizeProductType(partial.productType) ?? this.productType,
      agentId: String(partial.agentId ?? this.config.agentId ?? '').trim(),
      sessionId: partial.sessionId,
      ...(partial.traceId ? { traceId: partial.traceId } : {}),
      ...(this.config.subscriptionId ? { subscriptionId: this.config.subscriptionId } : {}),
      ...(partial.capabilityName && partial.capabilityName.trim() ? { capabilityName: partial.capabilityName } : {}),
      metadata: {
        ...(this.config.productId ? { productId: this.config.productId } : {}),
        ...(partial.eventType ? { eventType: partial.eventType } : {}),
        ...(partial.properties || {}),
      },
    };
    this.push(event);
  }

  /** @internal Build, validate and queue one event for a session. */
  enqueue(session: AgentSession, metricName: string, quantity: number, extras: EnqueueExtras): void {
    if (quantity === 0) return; // zero usage is not an event
    const event: IngestEvent = {
      customerId: session.customerId,
      metricName,
      quantity,
      occurredAt: new Date().toISOString(),
      idempotencyKey: session.nextIdempotencyKey(),
      productType: session.productType,
      agentId: session.agentId,
      sessionId: session.sessionId,
      traceId: session.traceId,
      ...(session.subscriptionId ? { subscriptionId: session.subscriptionId } : {}),
      ...(extras.capabilityName && extras.capabilityName.trim() ? { capabilityName: extras.capabilityName.trim() } : {}),
      ...(extras.executionStatus ? { executionStatus: extras.executionStatus } : {}),
      ...(typeof extras.durationMs === 'number' && Number.isFinite(extras.durationMs) && extras.durationMs >= 0
        ? { executionDurationMs: Math.round(extras.durationMs) }
        : {}),
      ...(extras.stepNumber !== undefined ? { stepNumber: extras.stepNumber } : {}),
      ...(extras.parentStepId ? { parentStepId: extras.parentStepId } : {}),
      ...(extras.sessionBoundary ? { sessionBoundary: extras.sessionBoundary } : {}),
      metadata: { ...session.baseMetadata(), ...extras.metadata },
    };
    this.push(event);
  }

  /** @internal Trim/upper-case a status; blank → SUCCESS; unknown → dropped with a warning. */
  normalizeStatus(value: unknown): ExecutionStatus | undefined {
    if (value === undefined || value === null) return 'SUCCESS';
    const s = String(value).trim().toUpperCase();
    if (!s) return 'SUCCESS';
    if ((EXECUTION_STATUSES as readonly string[]).includes(s)) return s as ExecutionStatus;
    this.logger?.warn(`[aforo-agent] "${clip(value)}" is not an execution status; leaving it off the event`);
    return undefined;
  }

  /**
   * Send everything queued and wait for it. Runs on the single sender, never
   * a second concurrent request. Resolves (never rejects). During an outage
   * this makes one attempt; unsent events stay queued and `onError` gets
   * `retrying`.
   */
  async flush(): Promise<FlushResult> {
    const r = await this.core.flush();
    return { accepted: r.sent, failed: r.failed, requeued: r.requeued, pending: r.queued };
  }

  /**
   * Stop accepting events and send what is queued for at most
   * `shutdownTimeoutMs`. Events still queued at the deadline are dropped
   * (`shutdown`). The SDK installs no signal handlers: call this from your own.
   */
  async shutdown(): Promise<FlushResult> {
    const r = await this.core.shutdown();
    return { accepted: r.sent, failed: r.failed, requeued: r.requeued, pending: r.queued };
  }

  /** Events permanently dropped since this client was created. */
  get droppedCount(): number {
    return this.core.droppedCount;
  }

  /** Events currently queued (not yet accepted by the ingestor). */
  get pendingCount(): number {
    return this.core.queued;
  }

  private push(event: IngestEvent): void {
    const problem = describeInvalidEvent(event);
    if (problem) {
      // Counted, logged (throttled) and reported by the core like every drop.
      this.core.reportDrop([event], 'invalid', `event "${clip(event.metricName)}" is invalid: ${problem}`);
      return;
    }
    this.core.enqueue(event);
  }

  /** Every permanent drop the core reports: forwarded to onError and the legacy onDrop. */
  private onCoreDrop(events: IngestEvent[], reason: CoreDropReason, detail?: string): void {
    const kind: AforoErrorKind = reason === 'retry_exhausted' ? 'rejected' : reason;
    const message = detail ?? `${events.length} event(s) dropped (${reason})`;
    this.callOnError({ kind, message, events, willRetry: false });
    if (this.config.onDrop && events.length > 0) {
      try {
        this.config.onDrop(events, reason);
      } catch (err) {
        this.logger?.warn(`[aforo-agent] onDrop threw: ${clip((err as Error)?.message ?? err)}`);
      }
    }
  }

  /**
   * The core also reports errors for drops (already sent through onCoreDrop);
   * only its `outage` and `auth` reports are new information: events kept and
   * retried. Decided on `kind`, never on the message text.
   */
  private onCoreError(err: CoreTransportError<IngestEvent>): void {
    if (err.kind !== 'outage' && err.kind !== 'auth') return;
    this.callOnError({ kind: 'retrying', message: err.message, events: [], willRetry: true });
  }

  private callOnError(error: AforoAgentError): void {
    if (!this.config.onError) return; // the core has already logged it
    try {
      this.config.onError(error);
    } catch (err) {
      // A handler bug must never break metering; it is logged instead.
      this.logger?.warn(`[aforo-agent] onError threw: ${clip((err as Error)?.message ?? err)}`);
    }
  }
}

/** First reason the ingestor would reject this event, or null. */
function describeInvalidEvent(ev: IngestEvent): string | null {
  const blank = (v: unknown) => typeof v !== 'string' || !v.trim();
  if (blank(ev.customerId)) return 'customerId is required (config.customerId or startSession({ customerId }))';
  if (blank(ev.metricName)) return 'metricName is required';
  if (blank(ev.agentId)) return 'agentId is required for AI_AGENT events (config.agentId or startSession({ agentId }))';
  if (blank(ev.sessionId)) return 'sessionId is required';
  if (typeof ev.quantity !== 'number' || !Number.isFinite(ev.quantity) || ev.quantity <= 0) {
    return `quantity must be a number > 0 (got ${clip(ev.quantity)})`;
  }
  for (const [field, max] of Object.entries(LIMITS)) {
    const v = (ev as unknown as Record<string, unknown>)[field];
    if (typeof v === 'string' && v.length > max) return `${field} "${clip(v)}" exceeds ${max} chars`;
  }
  return null;
}

export default AforoAgent;
