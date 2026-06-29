/** Options for creating an AforoClient instance. */
export interface AforoOptions {
  /** Aforo API key for authentication. */
  apiKey: string;

  /** Base URL for the Aforo ingestor service. Defaults to https://ingest.aforo.ai */
  baseUrl?: string;

  /** Maximum events to buffer before flushing. Default: 50 */
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
}

/** A usage event to track. */
export interface TrackEvent {
  /** Customer identifier (who is being billed). */
  customerId: string;

  /** Metric name (e.g., "api_calls", "ai_tokens", "GET /users"). */
  metricName: string;

  /** Quantity of usage. Default: 1 */
  quantity?: number;

  /** Optional override for idempotency key. Auto-generated if omitted. */
  idempotencyKey?: string;

  /** When the event occurred. Defaults to now. ISO 8601 string or epoch ms. */
  occurredAt?: string | number;

  /** Arbitrary key-value metadata attached to the event. */
  metadata?: Record<string, string | number | boolean>;
}

/** Internal event with all fields resolved. */
export interface ResolvedEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  idempotencyKey: string;
  occurredAt: string;
  metadata?: Record<string, string | number | boolean>;
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
  errors: Array<{ index: number; error: string }>;
}

/** Options for Express/Koa/Fastify middleware. */
export interface MiddlewareOptions {
  /** Aforo API key. */
  apiKey: string;

  /** Base URL for the ingestor. */
  baseUrl?: string;

  /** Static metric name or function to derive from request. */
  metricName?: string | ((req: any, res: any) => string);

  /** Static quantity or function to derive from request/response. */
  quantity?: number | ((req: any, res: any) => number);

  /** Static customer ID or function to derive from request. */
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
}
