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
 * - `retrying`  — the ingestor was unreachable / returned 408, 429 or 5xx on every
 *                 attempt. The events are KEPT in the buffer and re-sent on the next flush.
 * - `rejected`  — the ingestor refused the whole request (non-retryable 4xx). Events dropped.
 * - `partial`   — HTTP 2xx, but the response reported `data.failed > 0`; the
 *                 failed events (see `errors`) are dropped, the rest were accepted.
 * - `invalid`   — an event failed a client-side check and was never sent.
 * - `overflow`  — the buffer hit `maxBufferSize`; the oldest events were dropped.
 */
export type AforoErrorKind = 'retrying' | 'rejected' | 'partial' | 'invalid' | 'overflow';

export interface AforoAgentError {
  kind: AforoErrorKind;
  message: string;
  /** HTTP status of the last attempt, when there was a response. */
  status?: number;
  /** Events affected (kept for `retrying`, dropped for every other kind). */
  events: IngestEvent[];
  /** Per-event errors from a batch response (`partial`). */
  errors?: Array<{ index: number; message: string; idempotencyKey?: string }>;
  /** True when the events are still buffered and will be re-sent. */
  willRetry: boolean;
}

/** @deprecated Reasons passed to the legacy `onDrop` hook. */
export type DropReason = 'retry_exhausted' | 'rejected' | 'invalid' | 'overflow';

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
  /** Events per request, 1..1000. Default 100. A full batch triggers a flush. */
  maxBatchSize?: number;
  /** Max events held in memory (including ones kept after a failed flush). Default 10000. */
  maxBufferSize?: number;
  /** Attempts per flush request for 408/429/5xx/network failures. Default 3. */
  maxRetries?: number;
  /** Base backoff in ms, doubled per attempt; a 429's Retry-After wins. Default 500. */
  retryBaseDelayMs?: number;
  /** Per-request timeout in ms. Default 10000. */
  requestTimeoutMs?: number;
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
  /** Events the ingestor accepted (including duplicates). */
  accepted: number;
  /** Of those, how many it reported as duplicates. */
  duplicates: number;
  /** Events permanently dropped during this flush. */
  failed: number;
  /** Events still buffered (e.g. kept after a retryable failure). */
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
const MAX_BATCH = 1000;
const MAX_RETRY_AFTER_MS = 30_000;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function unwrapEnvelope(body: any): any {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body.data : undefined;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : body;
}

async function readJson(res: any): Promise<any> {
  try {
    if (typeof res?.text === 'function') {
      const text = await res.text();
      return text ? JSON.parse(text) : undefined;
    }
    if (typeof res?.json === 'function') return await res.json();
  } catch {
    // empty / non-JSON body
  }
  return undefined;
}

function errorMessageOf(body: any): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const inner = unwrapEnvelope(body);
  const first = Array.isArray(inner?.errors) ? inner.errors[0] : Array.isArray(body.errors) ? body.errors[0] : undefined;
  const text = first?.message ?? body.detail ?? body.message ?? body.error ?? body.title;
  return typeof text === 'string' && text ? text.slice(0, 500) : undefined;
}

type SendOutcome =
  | { kind: 'ok'; status: number; duplicates: number; failed: number; errors: Array<{ index: number; message: string }> }
  | { kind: 'retryable'; status?: number; detail: string }
  | { kind: 'rejected'; status: number; detail: string };

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
    await this.client.maybeFlush();
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
    await this.client.maybeFlush();
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
    await this.client.maybeFlush();
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
 * Top-level client. Buffers events (bounded) and flushes them in batches of
 * ≤ `maxBatchSize` to `/v1/ingest/batch`. Never throws from record/flush
 * calls; problems go to `onError` (or the logger).
 */
export class AforoAgent {
  readonly metricNames: Readonly<MetricNames>;
  readonly endpoint: string;
  private readonly buffer: IngestEvent[] = [];
  private readonly fetchImpl: typeof fetch;
  private readonly productType: string;
  private readonly maxBatchSize: number;
  private readonly maxBufferSize: number;
  private readonly logger: AforoLogger | null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<FlushResult> | null = null;
  private dropped = 0;
  private invalidCount = 0;

  constructor(private readonly config: AforoAgentConfig) {
    if (!config || !config.apiKey) throw new Error('AforoAgent: apiKey is required');
    const f = config.fetchImpl || (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!f) throw new Error('AforoAgent: no fetch available — pass fetchImpl in config (Node < 18)');
    this.fetchImpl = f;
    this.endpoint = resolveEndpoint(config.endpoint || config.ingestorUrl);
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.metricNames = Object.freeze({ ...DEFAULT_METRIC_NAMES, ...(config.metricNames || {}) });
    const batch = config.maxBatchSize ?? config.flushBatchSize ?? 100;
    this.maxBatchSize = Math.min(MAX_BATCH, Math.max(1, Math.floor(batch)));
    this.maxBufferSize = Math.max(this.maxBatchSize, Math.floor(config.maxBufferSize ?? 10_000));
    this.logger = config.logger === undefined ? console : config.logger;
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
    await this.maybeFlush();
  }

  /** @internal Build, validate and buffer one event for a session. */
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

  /** @internal Flush in the background once a full batch is buffered; otherwise arm the timer. */
  async maybeFlush(): Promise<void> {
    if (this.buffer.length >= this.maxBatchSize) {
      if (!this.flushing) void this.flush();
    } else if (this.buffer.length > 0) {
      this.scheduleFlush();
    }
  }

  /**
   * Send everything buffered. Resolves (never rejects) once the buffer is
   * drained or a retryable failure stops the pass — in that case the unsent
   * events stay buffered for the next flush and `onError` gets `retrying`.
   */
  async flush(): Promise<FlushResult> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) await this.flushing;
    const run = this.drain();
    this.flushing = run;
    try {
      return await run;
    } finally {
      this.flushing = null;
      if (this.buffer.length > 0) this.scheduleFlush();
    }
  }

  /** Flush and stop the timer. Call before the process exits. */
  async shutdown(): Promise<FlushResult> {
    const result = await this.flush();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    return result;
  }

  /** Events permanently dropped since this client was created. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Events currently buffered (not yet accepted by the ingestor). */
  get pendingCount(): number {
    return this.buffer.length;
  }

  private push(event: IngestEvent): void {
    const problem = describeInvalidEvent(event);
    if (problem) {
      this.invalidCount += 1;
      // Throttle the log (first, then every 1000th); onError sees every one.
      const quiet = !this.config.onError && this.invalidCount !== 1 && this.invalidCount % 1000 !== 0;
      this.report({ kind: 'invalid', message: `event "${clip(event.metricName)}" is invalid: ${problem}`, events: [event], willRetry: false }, quiet);
      return;
    }
    this.buffer.push(event);
    this.enforceBound();
  }

  private enforceBound(): void {
    const excess = this.buffer.length - this.maxBufferSize;
    if (excess > 0) {
      const evicted = this.buffer.splice(0, excess);
      this.report({
        kind: 'overflow',
        message: `buffer full (${this.maxBufferSize}); dropped the ${evicted.length} oldest event(s)`,
        events: evicted,
        willRetry: false,
      });
    }
  }

  private async drain(): Promise<FlushResult> {
    const result: FlushResult = { accepted: 0, duplicates: 0, failed: 0, pending: 0 };
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.maxBatchSize);
      const outcome = await this.send(batch);
      if (outcome.kind === 'retryable') {
        this.buffer.unshift(...batch);
        this.enforceBound();
        this.report({
          kind: 'retrying',
          message: `ingest failed (${outcome.detail}); keeping ${batch.length} event(s) for the next flush`,
          ...(outcome.status ? { status: outcome.status } : {}),
          events: batch,
          willRetry: true,
        });
        break;
      }
      if (outcome.kind === 'rejected') {
        result.failed += batch.length;
        this.report({ kind: 'rejected', message: `ingest rejected: ${outcome.detail}`, status: outcome.status, events: batch, willRetry: false });
        continue;
      }
      result.duplicates += outcome.duplicates;
      const failed = Math.min(batch.length, outcome.failed);
      result.accepted += batch.length - failed;
      if (failed > 0) {
        result.failed += failed;
        const errors = outcome.errors.map((e) => ({ ...e, idempotencyKey: batch[e.index]?.idempotencyKey }));
        const identified = errors.length === failed;
        this.report({
          kind: 'partial',
          message: `ingestor rejected ${failed} of ${batch.length} event(s)${errors[0] ? `: ${errors[0].message}` : ''}`,
          status: outcome.status,
          events: identified ? errors.map((e) => batch[e.index]) : batch,
          errors,
          willRetry: false,
        }, false, failed);
      }
    }
    result.pending = this.buffer.length;
    return result;
  }

  /** POST one batch with retries. Never throws. */
  private async send(batch: IngestEvent[]): Promise<SendOutcome> {
    const body = JSON.stringify({ events: batch }); // serialised once: retries re-send identical keys
    const attempts = Math.max(1, Math.floor(this.config.maxRetries ?? 3));
    const base = this.config.retryBaseDelayMs ?? 500;
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    let last: SendOutcome = { kind: 'retryable', detail: 'not sent' };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let delay = base * Math.pow(2, attempt - 1);
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
          body,
          ...(controller ? { signal: controller.signal } : {}),
        });
        const json = await readJson(res);
        if (res.ok) {
          const data = unwrapEnvelope(json) || {};
          const errors: Array<{ index: number; message: string }> = [];
          const seen = new Set<number>();
          for (const e of Array.isArray(data.errors) ? data.errors : []) {
            const index = Number(e?.index);
            if (!Number.isInteger(index) || index < 0 || index >= batch.length || seen.has(index)) continue;
            seen.add(index);
            errors.push({ index, message: String(e?.message ?? 'rejected by the ingestor').slice(0, 500) });
          }
          const reported = typeof data.failed === 'number' && data.failed > 0 ? Math.floor(data.failed) : 0;
          return {
            kind: 'ok',
            status: res.status,
            duplicates: typeof data.duplicates === 'number' ? data.duplicates : 0,
            failed: Math.max(reported, errors.length),
            errors,
          };
        }
        const msg = errorMessageOf(json);
        const detail = `HTTP ${res.status}${msg ? `: ${msg}` : ''}`;
        if (!(res.status === 408 || res.status === 429 || res.status >= 500)) {
          return { kind: 'rejected', status: res.status, detail };
        }
        last = { kind: 'retryable', status: res.status, detail };
        if (res.status === 429) {
          const ra = res.headers && typeof res.headers.get === 'function' ? res.headers.get('Retry-After') : null;
          const secs = ra ? Number(ra) : NaN;
          if (Number.isFinite(secs) && secs >= 0) delay = Math.min(MAX_RETRY_AFTER_MS, secs * 1000);
        }
      } catch (e) {
        last = { kind: 'retryable', detail: `network error: ${clip((e as Error)?.message ?? e)}` };
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (attempt < attempts) await sleep(delay);
    }
    return last;
  }

  private report(error: AforoAgentError, quiet = false, droppedOverride?: number): void {
    if (!error.willRetry) this.dropped += droppedOverride ?? error.events.length;
    if (this.config.onError) {
      try {
        this.config.onError(error);
      } catch {
        // a handler bug must never break metering
      }
    } else if (!quiet) {
      this.logger?.warn(`[aforo-agent] ${error.kind}: ${error.message}`);
    }
    if (!error.willRetry && this.config.onDrop) {
      const reason: DropReason = error.kind === 'invalid' ? 'invalid' : error.kind === 'overflow' ? 'overflow' : 'rejected';
      try {
        this.config.onDrop(error.events, reason);
      } catch {
        // ignore
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushing) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.config.flushIntervalMs ?? 5000);
    // Don't keep the process alive just for metering.
    (this.flushTimer as any)?.unref?.();
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
