import type { AforoClient } from './client.js';

/**
 * Why events were permanently lost. Every dropped event keeps its
 * idempotency key, so re-tracking it after recovery is dedup-safe.
 * - 'overflow': the queue was full — the OLDEST event was evicted to make room.
 * - 'rejected': the ingestor refused the event (a non-retryable 4xx, a
 *   per-event rejection inside an accepted batch, or 413 on a single event).
 * - 'invalid': the event failed a client-side check at track() (blank
 *   customerId/metricName, quantity <= 0, a field over the ingestor's size
 *   limit, a malformed occurredAt), or a middleware customer resolver
 *   returned nothing. It was never queued or sent.
 * - 'shutdown': still queued when the shutdown deadline passed.
 * - 'closed': track() was called after shutdown().
 * - 'retry_exhausted': kept for compatibility; not produced by 2.x (an outage
 *   requeues the batch behind a breaker instead of dropping it).
 */
export type DropReason = 'overflow' | 'retry_exhausted' | 'rejected' | 'invalid' | 'shutdown' | 'closed';

/** Options for creating an AforoClient instance. */
export interface AforoOptions {
  /** Aforo API key, sent as X-API-Key. Never logged or shown by inspect(). */
  apiKey: string;

  /**
   * Base URL for the Aforo ingestor. Default https://api.aforo.ai.
   * Must be https:// — plain http:// is accepted only for localhost,
   * 127.0.0.1 and ::1, or with `allowInsecureHttp: true`.
   */
  baseUrl?: string;

  /** Allow a plain http:// baseUrl on a non-local host. Default false. */
  allowInsecureHttp?: boolean;
  /**
   * Request compression: 'gzip' (default) sends batches of 1 KiB or more with
   * Content-Encoding: gzip (needs usage-ingestor wave 8 or later); 'none'
   * always sends plain JSON.
   */
  compression?: 'gzip' | 'none';

  /**
   * Default product type stamped on every event (top-level `productType`).
   * Required by the Aforo ingestor in production. One of API, AGENTIC_API,
   * AI_AGENT, MCP_SERVER, GRPC_API, GRAPHQL_API, WEBSOCKET_API, MQTT_BROKER.
   * Values are trimmed, uppercased and passed through. Default: "API".
   * A per-event `productType` on `track()` overrides this.
   */
  productType?: string;

  /** Events per request (capped at 1000, the ingestor's batch limit). Default: 500 */
  flushCount?: number;

  /** Flush at least this often, in milliseconds. Default: 5000 */
  flushInterval?: number;

  /** Queue capacity. The oldest event is dropped on overflow. Default: 10000 */
  maxQueueSize?: number;

  /** Retries per batch on network errors, timeouts, 408, 429 and 5xx before the breaker opens. Default: 3 */
  maxRetries?: number;

  /** Base delay in ms for full-jitter backoff. Default: 500 */
  retryBaseMs?: number;

  /** Total deadline per request, in milliseconds. Default: 10000 */
  timeout?: number;

  /** How long shutdown() keeps sending, in milliseconds. Default: 5000 */
  shutdownTimeoutMs?: number;

  /**
   * Flush queued events when the process is about to exit naturally
   * (`beforeExit`), within shutdownTimeoutMs. Default true. The SDK installs
   * no signal handlers: call `await client.shutdown()` from your own SIGTERM
   * handler before exiting.
   */
  flushOnExit?: boolean;

  /**
   * OPT-IN hook invoked with events the SDK is about to lose permanently
   * (see DropReason), so the app can persist / alert / replay them. Dropped
   * events keep their idempotency keys — re-submitting them via track() after
   * recovery is dedup-safe. Default: none (drops are still counted in
   * droppedCount and WARN-logged). An exception thrown by the hook is caught
   * and logged; it never breaks flushing.
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
  errors: Array<{ index: number; message: string; retryable?: boolean }>;
  killedSessionIds?: string[];
}

/** Options for Express/Koa/Fastify middleware. */
export interface MiddlewareOptions {
  /**
   * An AforoClient the app owns (recommended): the app can flush it, read
   * droppedCount and call shutdown() from its SIGTERM handler. When omitted,
   * the middleware creates one from apiKey/baseUrl/clientOptions and exposes
   * it as `middleware.client`.
   */
  client?: AforoClient;

  /** Aforo API key (only when `client` is not given). */
  apiKey?: string;

  /** Base URL for the ingestor (only when `client` is not given). */
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
   * unknown metrics.
   */
  metricName?: string | ((req: any, res: any) => string);

  /** Static quantity or function to derive from request/response. Requests with quantity <= 0 are not metered. */
  quantity?: number | ((req: any, res: any) => number);

  /**
   * Who is billed for a request, from identity your app authenticated (the
   * session, a verified JWT subject, an API-key lookup). Required unless
   * `trustCustomerHeader` is true. Return null/undefined/'' when the request
   * has no billable customer: the event is dropped as 'invalid' and counted;
   * the request itself is never blocked.
   */
  customerResolver?: (req: any) => string | null | undefined;

  /**
   * @deprecated Use `customerResolver`. A function is used as the resolver; a
   * fixed string bills every request to that customer.
   */
  customerId?: string | ((req: any) => string | null | undefined);

  /**
   * Read the customer from the `X-Customer-Id` request header. That header is
   * set by whoever calls your API, so only turn this on when a trusted proxy
   * in front of the app sets it and strips any client copy. Default false.
   */
  trustCustomerHeader?: boolean;

  /**
   * Collapse dynamic path segments before sending `endpointPath`
   * (`/users/123` → `/users/:id`; the framework's route template wins when
   * there is one). Default true, so per-id paths do not create unbounded
   * label cardinality. Pass a function to normalize yourself, or false to send
   * the raw path.
   */
  normalizePath?: boolean | ((path: string, req: any) => string);

  /** Paths to exclude from metering. Default: ["/health", "/ready", "/metrics", "/favicon.ico"] */
  excludePaths?: string[];

  /** Status codes to exclude. Default: none */
  excludeStatusCodes?: number[];

  /** Function to extract metadata from request/response. */
  metadata?: (req: any, res: any) => Record<string, string | number | boolean>;

  /** AforoClient options (flushCount, flushInterval, etc.) when the middleware creates the client. */
  clientOptions?: Omit<AforoOptions, 'apiKey' | 'baseUrl'>;
}

/** Flush result for internal tracking. */
export interface FlushResult {
  sent: number;
  failed: number;
  /** Events put back on the queue (ingestor outage or a per-event retryable failure). */
  requeued: number;
  /** Events still queued after the flush. */
  queued: number;
}
