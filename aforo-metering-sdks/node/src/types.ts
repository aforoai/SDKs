/**
 * Why a buffered event was permanently dropped by the SDK.
 * - 'overflow': the ring buffer was full — the OLDEST event was evicted to make room.
 * - 'retry_exhausted': a batch failed after all transport retries (ingest outage).
 * - 'rejected': the ingestor rejected the batch with a non-retryable 4xx, or
 *   rejected this event individually in a partially accepted batch.
 * - 'invalid': the event failed a client-side check at track() (blank
 *   customerId/metricName, quantity <= 0, a field over the ingestor's size
 *   limit, a malformed occurredAt) and was never buffered or sent.
 */
export type DropReason = 'overflow' | 'retry_exhausted' | 'rejected' | 'invalid';

/** Options for creating an AforoClient instance. */
export interface AforoOptions {
  /** Aforo API key for authentication. */
  apiKey: string;

  /** Base URL for the Aforo ingestor service. Defaults to https://api.aforo.ai */
  baseUrl?: string;

  /**
   * Default product type stamped on every event (top-level `productType`).
   * Required by the Aforo ingestor in production. One of API, AGENTIC_API,
   * AI_AGENT, MCP_SERVER, GRPC_API, GRAPHQL_API, WEBSOCKET_API, MQTT_BROKER.
   * Values are trimmed, uppercased and passed through. Default: "API".
   * A per-event `productType` on `track()` overrides this.
   */
  productType?: string;

  /** Maximum events to buffer before flushing (capped at 1000, the ingestor's batch limit). Default: 50 */
  flushCount?: number;

  /** Flush interval in milliseconds. Default: 5000 (5 seconds) */
  flushInterval?: number;

  /** Maximum events in the ring buffer. Oldest dropped on overflow. Default: 10000 */
  maxQueueSize?: number;

  /** Maximum retries on 5xx/timeout. Default: 3 */
  maxRetries?: number;

  /** Base delay in ms for exponential backoff. Default: 1000 */
  retryBaseMs?: number;

  /** Request timeout in milliseconds. Default: 10000 */
  timeout?: number;

  /** Graceful shutdown timeout in milliseconds. Default: 5000 */
  shutdownTimeoutMs?: number;

  /**
   * OPT-IN hook invoked with events the SDK is about to lose permanently
   * (buffer overflow, retry exhaustion, non-retryable rejection, or an event
   * that failed client-side validation — reason 'invalid'), so the
   * app can persist / alert / replay them. Dropped events keep their
   * idempotency keys — re-submitting them via track() after recovery is
   * dedup-safe. Default: none (drops are still counted in droppedCount and
   * WARN-logged). Exceptions thrown by the hook are swallowed — a hook bug
   * can never break flushing.
   */
  onDrop?: (events: ResolvedEvent[], reason: DropReason) => void;
}

/** A usage event to track. */
export interface TrackEvent {
  /** Customer identifier (who is being billed). */
  customerId: string;

  /** Metric name (e.g., "api_calls", "ai_tokens", "GET /users"). */
  metricName: string;

  /** Quantity of usage. Must be > 0 (the ingestor rejects 0). Default: 1 */
  quantity?: number;

  /**
   * Product type for this event. Overrides the client-level `productType`
   * default. Trimmed, uppercased and sent as top-level `productType`.
   */
  productType?: string;

  /**
   * Optional idempotency key — supply a STABLE value to dedup retries of the
   * same logical event. Omitted = dedup opt-out: the SDK stamps a unique
   * random key per track() call (still stable across the SDK's own flush
   * retries of the buffered event).
   */
  idempotencyKey?: string;

  /** When the event occurred. Defaults to now. ISO 8601 string or epoch ms. */
  occurredAt?: string | number;

  /** Arbitrary key-value metadata attached to the event. */
  metadata?: Record<string, string | number | boolean>;

  /**
   * Optional outcome of the request (used by OUTCOME_BASED pricing, which bills
   * each event at the weight set for its status). Events without a status bill
   * at full price. Trimmed and upper-cased by the SDK; blank is treated as absent.
   * Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED,
   * FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED (max 20 chars). Any other
   * value is logged with a warning and omitted (the event is still sent, without
   * a status), because the server would reject the event.
   */
  executionStatus?: string;

  /** Optional HTTP context, sent as top-level fields. */
  endpointPath?: string;
  httpMethod?: string;
  statusCode?: number;
  responseTimeMs?: number;
}

/** Internal event with all fields resolved (the exact wire shape). */
export interface ResolvedEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  idempotencyKey: string;
  occurredAt: string;
  productType: string;
  metadata?: Record<string, string | number | boolean>;
  /** Normalized (trimmed, upper-cased) execution status; omitted when not set. */
  executionStatus?: string;
  endpointPath?: string;
  httpMethod?: string;
  statusCode?: number;
  responseTimeMs?: number;
  sessionId?: string;
  sessionBoundary?: 'HEARTBEAT' | 'SESSION_END';
}

/** Batch request body sent to POST /v1/ingest/batch. */
export interface BatchRequest {
  events: ResolvedEvent[];
}

/** Response from the ingestor batch endpoint. */
export interface BatchResponse {
  accepted: number;
  duplicates: number;
  failed: number;
  errors: Array<{ index: number; message: string }>;
  killedSessionIds?: string[];
}

/** Options for Express/Koa/Fastify middleware. */
export interface MiddlewareOptions {
  /** Aforo API key. */
  apiKey: string;

  /** Base URL for the ingestor. */
  baseUrl?: string;

  /**
   * Product type stamped on every metered request (top-level `productType`).
   * Default: the client default ("API", or `clientOptions.productType`).
   */
  productType?: string;

  /**
   * Metric to record for each request: a fixed name, or a function of the
   * request/response. Default: `"api_calls"` (DEFAULT_METRIC_NAME).
   *
   * Must name a metric that exists in your Aforo catalog. The ingestor rejects
   * unknown metrics, and one rejected event fails the whole batch it is in.
   */
  metricName?: string | ((req: any, res: any) => string);

  /** Static quantity or function to derive from request/response. Requests with quantity <= 0 are not metered. */
  quantity?: number | ((req: any, res: any) => number);

  /**
   * Aforo customer id: a fixed value, or a function of the request.
   * Default: the authenticated user's id (`req.user.id` / `.sub`), then the
   * `X-Customer-Id` header. Requests with no customer are not metered. The
   * caller's `X-Api-Key` header is never used -- it is a secret, not an id.
   */
  customerId?: string | ((req: any) => string | null);

  /** Paths to exclude from metering. Default: ["/health", "/ready", "/metrics", "/favicon.ico"] */
  excludePaths?: string[];

  /** Status codes to exclude. Default: none */
  excludeStatusCodes?: number[];

  /** Function to extract metadata from request/response. */
  metadata?: (req: any, res: any) => Record<string, string | number | boolean>;

  /** AforoClient options (flushCount, flushInterval, etc.) */
  clientOptions?: Omit<AforoOptions, 'apiKey' | 'baseUrl'>;
}

/** Flush result for internal tracking. */
export interface FlushResult {
  sent: number;
  failed: number;
  /** Why the batch failed, when failed > 0. Absent on success. */
  reason?: DropReason;
  /**
   * Events the ingestor rejected individually inside a batch it otherwise
   * accepted (per-event `errors[]` in the response). `index` is the position
   * in the sent batch. Present only when the response identified them.
   */
  rejected?: Array<{ index: number; message: string }>;
  /** Server-provided explanation for a failed batch, when one was returned. */
  message?: string;
}
