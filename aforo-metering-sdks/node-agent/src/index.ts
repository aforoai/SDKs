/**
 * @aforoai/agent-metering — Aforo AI Agent Metering SDK
 *
 * Thin wrapper that turns the agent's runtime lifecycle (start session →
 * record step → record tool call → end session) into Aforo metering events.
 * Sits one layer above the generic {@code @aforoai/metering} ingestor client
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

/**
 * The 11 canonical execution statuses the usage ingestor accepts (the same
 * set as contract/ingest-contract.json and the core SDKs). OUTCOME_BASED rate
 * plans bill each step at the weight set for its status; the SDK drops an
 * unknown value (with a warning) and the step bills at full weight.
 */
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
 * Trims and upper-cases a caller's status; missing or blank → SUCCESS (the
 * step ran). A value outside {@link EXECUTION_STATUSES} is logged and left
 * off the event, so the step bills at full weight — what the server would do
 * with it anyway.
 */
function normalizeExecutionStatus(value: unknown): ExecutionStatus | undefined {
  if (value === undefined || value === null) return 'SUCCESS';
  if (typeof value !== 'string') {
    console.warn('[aforo-agent] executionStatus must be a string; dropping it', value);
    return undefined;
  }
  const status = value.trim().toUpperCase();
  if (!status) return 'SUCCESS';
  if ((EXECUTION_STATUSES as readonly string[]).includes(status)) return status as ExecutionStatus;
  console.warn(`[aforo-agent] "${value}" is not an execution status; dropping it (the step bills at full weight)`);
  return undefined;
}

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
   * {@code productType} stamped on every event. Defaults to {@code AI_AGENT};
   * trimmed and uppercased, unknown values are passed through. (The
   * {@code /v1/ingest/events} endpoint itself derives the product type from
   * the event type — {@code agent_*} and {@code token_usage} are AI_AGENT.)
   * Overridable per session
   * ({@link StartSessionOptions.productType}) and per event
   * ({@link AgentEventInput.productType}).
   */
  productType?: string;
  /**
   * Aforo usage-ingestor URL. Defaults to
   * {@code https://api.aforo.ai/v1/ingest} — override for local dev or
   * air-gapped deployments. Events are POSTed one per request to
   * {@code <ingestorUrl>/events}; a URL already ending in {@code /events}
   * or {@code /batch} is accepted.
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
   * Attempts per event for 408/429/5xx/network failures (other 4xx are never
   * retried). Defaults to 3.
   */
  maxRetries?: number;
  /** Base backoff between attempts in ms (doubles each time; a 429's Retry-After wins). Defaults to 1000. */
  retryBaseDelayMs?: number;
  /** Pluggable transport for tests. Defaults to global {@code fetch}. */
  fetchImpl?: typeof fetch;
  /**
   * Opt-in hook receiving events that were permanently dropped:
   * 'retry_exhausted' — every send attempt failed (network error, 5xx, 408,
   * 429); 'rejected' — the ingestor returned a non-retryable 4xx; 'invalid' —
   * the event failed a client-side check and was never sent. Events carry their idempotency keys (stamped
   * at creation), so persisting and re-submitting them after recovery is
   * dedup-safe. Exceptions thrown by the hook are swallowed. Default:
   * none (drops are still counted in droppedCount and WARN-logged).
   */
  onDrop?: (events: UsageEvent[], reason: DropReason) => void;
}

/** Why an event was permanently dropped. */
export type DropReason = 'retry_exhausted' | 'rejected' | 'invalid';

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

export interface UsageEvent {
  tenantId: string;
  productId: string;
  /** Aforo customer billed for the event (top-level `customerId` on the wire). */
  customerId: string;
  /** Product type of the event (default AI_AGENT). */
  productType: string;
  eventType: string;
  metricKey: string;
  value: number;
  agentId: string;
  sessionId: string;
  /**
   * Top-level capability name — parity with MCP's toolName. When present, the
   * usage-ingestor extractor prefers this over metadata.capability_name /
   * metadata.capabilityName (see ApigeeEventRequest.capabilityName + G11
   * precedence chain, 2026-07-11). Omitted for non-capability events like
   * agent_session_start / agent_session_end.
   */
  capabilityName?: string;
  properties: Record<string, unknown>;
  /** Distributed-trace id, when the caller supplied one. */
  traceId?: string;
  timestamp: string;
  /** Stamped at event creation — dedup-safe replay of dropped events. */
  idempotencyKey: string;
}

/**
 * Input to {@link AforoAgent.emitEvent}: a {@link UsageEvent} without the
 * fields the client stamps. `customerId` and `productType` default to the
 * client's values.
 */
export type AgentEventInput =
  Omit<UsageEvent, 'tenantId' | 'productId' | 'timestamp' | 'idempotencyKey' | 'customerId' | 'productType'> & {
    /** Defaults to the client's {@code customerId}. */
    customerId?: string;
    /** Defaults to the client's {@code productType} ({@code AI_AGENT}). */
    productType?: string;
  };

const DEFAULT_INGESTOR = 'https://api.aforo.ai/v1/ingest';
const DEFAULT_PRODUCT_TYPE = 'AI_AGENT';
/** Ingestor field limits (IngestUsageEventRequest / ApigeeEventRequest @Size). */
const MAX_AGENT_ID = 36;
const MAX_CUSTOMER_ID = 64;
const MAX_SESSION_ID = 64;
const MAX_CAPABILITY_NAME = 64;
const MAX_METRIC_NAME = 255;
const MAX_PRODUCT_TYPE = 20;

function normalizeProductType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

/** Shorten an offending value for a log line. */
function clip(value: unknown): string {
  return String(value).slice(0, 80);
}

/**
 * `<base>/events`. Accepts the base (`…/v1/ingest`), a bare host
 * (`https://api.aforo.ai` → `/v1/ingest` is added) and, for callers who pass
 * a full endpoint, `…/v1/ingest/events` or `…/v1/ingest/batch`.
 */
function eventsUrl(ingestorUrl: string | undefined): string {
  let base = (ingestorUrl || DEFAULT_INGESTOR).replace(/\/+$/, '').replace(/\/(events|batch)$/, '');
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i.test(base)) base += '/v1/ingest';
  return base + '/events';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** First reason the ingestor would reject this event, or null. */
function describeInvalidEvent(ev: UsageEvent): string | null {
  const blank = (v: unknown) => typeof v !== 'string' || !v.trim();
  if (blank(ev.customerId)) {
    return 'customerId is required (config.customerId, startSession({ customerId }) or emitEvent({ customerId }))';
  }
  if (ev.customerId.length > MAX_CUSTOMER_ID) return `customerId "${clip(ev.customerId)}" exceeds ${MAX_CUSTOMER_ID} chars`;
  if (blank(ev.metricKey)) return `metricKey is required (got "${clip(ev.metricKey)}")`;
  if (ev.metricKey.length > MAX_METRIC_NAME) return `metricKey "${clip(ev.metricKey)}" exceeds ${MAX_METRIC_NAME} chars`;
  if (blank(ev.agentId)) return `agentId is required (got "${clip(ev.agentId)}")`;
  if (ev.agentId.length > MAX_AGENT_ID) return `agentId "${clip(ev.agentId)}" exceeds ${MAX_AGENT_ID} chars`;
  if (blank(ev.sessionId)) return `sessionId is required (got "${clip(ev.sessionId)}")`;
  if (ev.sessionId.length > MAX_SESSION_ID) return `sessionId "${clip(ev.sessionId)}" exceeds ${MAX_SESSION_ID} chars`;
  if (typeof ev.value !== 'number' || !Number.isFinite(ev.value) || ev.value <= 0) {
    return `value must be a number > 0 (got "${clip(ev.value)}")`;
  }
  if (typeof ev.capabilityName === 'string' && ev.capabilityName.length > MAX_CAPABILITY_NAME) {
    return `capabilityName "${clip(ev.capabilityName)}" exceeds ${MAX_CAPABILITY_NAME} chars`;
  }
  if (ev.productType.length > MAX_PRODUCT_TYPE) return `productType "${clip(ev.productType)}" exceeds ${MAX_PRODUCT_TYPE} chars`;
  return null;
}

/** Best-effort server explanation for a rejected request. */
async function readErrorMessage(res: { json?: () => Promise<unknown> }): Promise<string | undefined> {
  try {
    if (typeof res.json !== 'function') return undefined;
    const body = (await res.json()) as Record<string, any> | undefined;
    if (!body || typeof body !== 'object') return undefined;
    const first = Array.isArray(body.errors) ? body.errors[0] : undefined;
    const text = first?.message ?? body.detail ?? body.message ?? body.error ?? body.title;
    return typeof text === 'string' && text ? text.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
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

/** Random idempotency key stamped at event creation (dedup opt-out). */
function genKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return 'agent:' + c.randomUUID();
  // Fallback for Node <18 with an injected fetchImpl: two random draws +
  // time — collision-safe enough for a dedup-opt-out key.
  return 'agent:' + Math.random().toString(36).slice(2, 12)
      + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Map an internal event to the Apigee-format shape `/v1/ingest/events`
 * accepts. customerId is top-level (the endpoint requires it). The endpoint
 * derives the product type from eventType (`agent_*` / `token_usage` →
 * AI_AGENT); productType is still sent, top-level and in properties, so it is
 * on record. agentId/sessionId/productId ride in properties (the server maps
 * properties → metadata).
 *
 * G11 (2026-07-11): capabilityName is emitted BOTH as a top-level field
 * (matches the server's ApigeeEventRequest.capabilityName so it survives the
 * mapper into IngestUsageEventRequest.capabilityName) AND left inside
 * properties for backward compat with older servers that only read metadata.
 * The server's extractor precedence chain (top-level wins) resolves any
 * conflict deterministically.
 */
function toApigeeEvent(ev: UsageEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    eventType: ev.eventType,
    metricKey: ev.metricKey,
    value: ev.value,
    customerId: ev.customerId,
    productType: ev.productType,
    timestamp: ev.timestamp,
    idempotencyKey: ev.idempotencyKey,
    properties: {
      ...ev.properties,
      agentId: ev.agentId,
      sessionId: ev.sessionId,
      productId: ev.productId,
      productType: ev.productType,
      ...(ev.traceId ? { traceId: ev.traceId } : {}),
    },
  };
  if (ev.capabilityName && ev.capabilityName.trim().length > 0) {
    payload.capabilityName = ev.capabilityName;
  }
  return payload;
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
      // G11 (2026-07-11): top-level capabilityName for per-capability billing parity
      // with MCP's toolName. Kept in properties too for backward-compat with servers
      // that only read the metadata path.
      capabilityName: options.capabilityName,
      customerId: this.customerId,
      traceId: this.traceId,
      productType: this.productType,
      properties: {
        stepKind: options.stepKind,
        stepIndex: this.stepCount,
        capabilityName: options.capabilityName,
        inputTokens: options.inputTokens || 0,
        outputTokens: options.outputTokens || 0,
        durationMs: options.durationMs,
        parentStepId: options.parentStepId,
        ...this.meta,
        ...(options.metadata || {}),
        // Last, so a metadata key of the same name can't override it.
        executionStatus: normalizeExecutionStatus(options.executionStatus),
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
  private readonly buffer: UsageEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fetchImpl: typeof fetch;
  private dropped = 0;
  private invalidDrops = 0;
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
    // Missing / invalid ids do not throw here: every event of the session is
    // then dropped with reason 'invalid' (counted, WARN-logged, onDrop).
    const customerId = options.customerId || this.config.customerId;
    const agentId = typeof options.agentId === 'string' ? options.agentId.trim() : options.agentId;
    const productType = normalizeProductType(options.productType);
    const traceId = options.traceId;
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
   * Never throws for event content. An event the ingestor would reject --
   * no customerId (config or per session / event), blank metricKey, blank
   * agentId or sessionId, a value that is not > 0, or customerId over 64
   * chars, agentId over 36, sessionId over 64, capabilityName over 64,
   * metricKey over 255, productType over 20 -- is not buffered or sent. It is
   * counted in {@code droppedCount}, WARN-logged and passed to {@code onDrop}
   * with reason {@code 'invalid'}. Nothing is truncated.
   */
  async emitEvent(partial: AgentEventInput): Promise<void> {
    const customerId = partial.customerId || this.config.customerId;
    const event: UsageEvent = {
      tenantId: this.config.tenantId,
      productId: this.config.productId,
      timestamp: new Date().toISOString(),
      // Random key stamped at creation (dedup opt-out semantics): the
      // ingestor requires one, and dropped events handed to onDrop stay
      // replayable without double-billing a successfully-sent sibling.
      // Never regenerated: every retry of this event re-sends this key.
      idempotencyKey: genKey(),
      ...partial,
      customerId: typeof customerId === 'string' ? customerId.trim() : (customerId as unknown as string),
      productType: normalizeProductType(partial.productType) ?? this.productType,
    };

    const violation = describeInvalidEvent(event);
    if (violation) {
      this.recordDrop([event], 'invalid', `event ${clip(event.eventType)} is invalid: ${violation}`);
      return;
    }

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
   * Events are sent to {@code <ingestorUrl>/events} — the Apigee-format
   * endpoint that takes ONE event per request — so the batch fans out
   * concurrently. Each event is retried on 408/429/5xx/network failure
   * (honouring a 429's Retry-After) up to {@code maxRetries} attempts, always
   * with the same body and idempotency key; other 4xx are never retried.
   *
   * An event that still fails is counted, logged and handed to the opt-in
   * onDrop hook: 'rejected' for a non-retryable 4xx, 'retry_exhausted'
   * otherwise. For mission-critical billing, prefer the gateway-plugin path;
   * SDK direct-emit is for first-party customers running their own
   * infrastructure.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    const url = eventsUrl(this.config.ingestorUrl);

    const results = await Promise.all(batch.map((ev) => this.send(url, ev)));

    // Partition failures by drop reason: terminal 4xx → rejected,
    // network error / 5xx / 408 / 429 after all attempts → retry_exhausted.
    const rejected: UsageEvent[] = [];
    const failed: UsageEvent[] = [];
    let rejectedDetail = '';
    let failedDetail = '';
    results.forEach((r, i) => {
      if (r.ok) return;
      if (r.reason === 'rejected') {
        rejected.push(batch[i]);
        rejectedDetail = r.detail;
      } else {
        failed.push(batch[i]);
        failedDetail = r.detail;
      }
    });
    if (rejected.length > 0) this.recordDrop(rejected, 'rejected', rejectedDetail);
    if (failed.length > 0) this.recordDrop(failed, 'retry_exhausted', failedDetail);
  }

  /** POST one event, retrying transient failures. Never throws. */
  private async send(url: string, ev: UsageEvent): Promise<{ ok: true } | { ok: false; reason: DropReason; detail: string }> {
    // Serialised once, so every retry re-sends the same idempotency key.
    const body = JSON.stringify(toApigeeEvent(ev));
    const maxAttempts = Math.max(1, this.config.maxRetries ?? 3);
    const baseDelay = this.config.retryBaseDelayMs ?? 1000;
    let detail = 'flush failed';
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
        if (res.ok) return { ok: true };
        const message = await readErrorMessage(res);
        detail = `ingestor returned ${res.status}${message ? ` (${message})` : ''}`;
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        if (!retryable) return { ok: false, reason: 'rejected', detail };
        if (res.status === 429) {
          const retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('Retry-After') : null;
          const seconds = retryAfter ? parseInt(retryAfter, 10) : NaN;
          if (!isNaN(seconds) && seconds >= 0) delayMs = seconds * 1000;
        }
      } catch (e) {
        detail = `flush failed: ${e}`;
      }
      if (attempt < maxAttempts) await sleep(delayMs);
    }
    return { ok: false, reason: 'retry_exhausted', detail };
  }

  /** Number of events permanently dropped since this instance was created. */
  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Account for permanently lost events: bump the counter, WARN-log, and
   * invoke the opt-in onDrop hook. The buffer is drained at flush start, so
   * send drops are bounded by flush cadence; 'invalid' WARNs are throttled
   * (first, then every 1000th) so a tight loop of bad events can't storm the log.
   */
  private recordDrop(events: UsageEvent[], reason: DropReason, detail: string): void {
    this.dropped += events.length;
    let log = true;
    if (reason === 'invalid') {
      this.invalidDrops += events.length;
      log = this.invalidDrops === 1 || this.invalidDrops % 1000 === 0;
    }
    if (log) {
      // eslint-disable-next-line no-console
      console.warn(
        `[aforo-agent] ${detail}; dropped ${events.length} events — ${reason} (${this.dropped} total dropped)`,
      );
    }
    if (this.config.onDrop) {
      try {
        this.config.onDrop(events, reason);
      } catch {
        // A hook bug must never break flushing.
      }
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
