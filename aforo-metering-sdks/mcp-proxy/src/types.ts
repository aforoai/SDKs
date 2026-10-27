/**
 * @file Shared types for @aforoai/mcp-proxy
 */

// ─── Configuration ──────────────────────────────────────────────────────────

export type TransportType = 'stdio' | 'sse' | 'streamable-http';

export interface AforoConfig {
  tenantId: string;
  productId: string;
  apiKey: string;
  ingestorUrl: string;
  agentId?: string;
  /**
   * One customer billed for every tool call (a single-tenant sidecar). Also
   * the customer of session heartbeats. One of `customerId`,
   * `customerResolver`, a bearer-token → customer map
   * (`listen.authTokensFile`) or `trustClientCustomerId` is required.
   */
  customerId?: string;
  /**
   * Library use: decides the customer for each tool call from authenticated
   * identity. Receives the call (tool name, agent id, `_meta`) and, on the
   * HTTP transports, the authenticated principal. Return nothing to leave the
   * call unmetered (its event is dropped as `invalid`; the call still runs).
   * When set it wins over every other source.
   */
  customerResolver?: CustomerResolver;
  /**
   * Bill the customer the MCP client names in `_meta.customer_id`. Any client
   * can put any id there, so turn this on only when every client is trusted.
   * Calls without one fall back to `customerId` when it is set.
   */
  trustClientCustomerId?: boolean;
  /**
   * Allow a plain `http://` ingestor URL on a host other than localhost /
   * 127.0.0.1 / ::1. The API key would cross the network unencrypted.
   */
  allowInsecureHttp?: boolean;
  /**
   * Top-level `productType` on every event (required by the ingestor).
   * Default `MCP_SERVER`; trimmed and uppercased, unknown values pass through.
   */
  productType?: string;
  quotaEnforcement?: boolean;
  /** How long the pre-flight quota check may take, in ms (default 1000). */
  quotaTimeoutMs?: number;
  /**
   * How long an ALLOW answer is reused for the same customer, in ms (default
   * 1000; 0 turns the cache off). WARN answers are never reused.
   */
  quotaAllowCacheMs?: number;
  /**
   * What happens when the quota check cannot answer (timeout, network error,
   * non-2xx, unreadable body): `open` (default) lets the call through,
   * `closed` refuses it with JSON-RPC error -32000.
   */
  quotaFailMode?: 'open' | 'closed';
  /**
   * Overrides the executionStatus decided for each tool call (library use —
   * the CLI has no flag for it). Receives the JSON-RPC `result` (undefined on
   * an error response or a timeout) and `error` (the JSON-RPC error object, a
   * `{ code: -32001, message }` timeout marker for a call that never got a
   * response, or undefined). Return a canonical status, or undefined/blank to
   * use the default (see defaultToolStatus).
   */
  statusResolver?: ToolStatusResolver;
  /**
   * How long a tool call may wait for its response before it is metered as
   * TIMEOUT (default 300000 = 5 minutes). Raise it for tools that legitimately
   * run longer; a response that arrives after the timeout is not metered again.
   * The HTTP transports also wait at most this long for the MCP server's
   * answer to a forwarded POST (the client then gets 504).
   */
  responseTimeoutMs?: number;
  /**
   * Opt-in hook (library use — the CLI has no flag for it) called with usage
   * events the proxy is about to lose. Dropped events are also counted and
   * WARN-logged. Events keep their idempotency keys, so re-sending them is
   * dedup-safe. Exceptions thrown by the hook are swallowed. Session
   * heartbeats are never passed here: a failed heartbeat is not a usage drop.
   */
  onDrop?: (events: ProxyUsageEvent[], reason: DropReason) => void;
  /** Send queued events at least this often, in ms (default 5000). */
  flushIntervalMs?: number;
  /** Events per request; reaching it wakes the sender (default 500, max 1000). */
  flushCount?: number;
  /** Most usage events held while the ingestor is unreachable (default 10 000). */
  maxQueueSize?: number;
  /** How long shutdown keeps sending queued events, in ms (default 3000). */
  shutdownTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  debug?: boolean;
}

/**
 * Why usage events were permanently dropped.
 * - 'rejected': the ingestor refused the batch with a non-retryable 4xx, or
 *   refused these events individually inside a batch it otherwise accepted.
 * - 'invalid': the tool call failed a client-side check (no customer, agentId
 *   over 36 chars, customerId over 64, sessionId over 64) and its event was
 *   never queued or sent. An over-long toolName is truncated to 64, not dropped.
 * - 'overflow': the queue was full (maxQueueSize) and the oldest event made room.
 * - 'shutdown': still queued when the shutdown deadline passed.
 * - 'closed': produced after shutdown.
 * - 'retry_exhausted': kept for compatibility. An ingest outage no longer
 *   drops events: they are re-queued with their keys and retried.
 */
export type DropReason = 'retry_exhausted' | 'rejected' | 'invalid' | 'overflow' | 'shutdown' | 'closed';

export type ToolStatusResolver = (result: unknown, error: JsonRpcError | undefined) => string | undefined;

export interface ListenConfig {
  port: number;
  host?: string;
  /**
   * Bearer token every client must send (`Authorization: Bearer <token>`).
   * The HTTP transports refuse to start without `authToken`,
   * `authTokensFile` or `allowUnauthenticated`.
   */
  authToken?: string;
  /**
   * JSON file `{ "<token>": "<customerId>" , ... }`: each client gets its own
   * token, and the token decides the customer its calls are billed to.
   */
  authTokensFile?: string;
  /** Tokens already loaded (library use); same shape as the file. */
  authTokens?: Record<string, string>;
  /**
   * Accept requests without a bearer token. Only allowed when the proxy
   * listens on a loopback address; Host and Origin checks still apply.
   */
  allowUnauthenticated?: boolean;
  /**
   * Host header values accepted, besides localhost / 127.0.0.1 / [::1] and the
   * listen host (with or without the port). Defends against DNS rebinding.
   */
  allowedHosts?: string[];
  /**
   * Browser origins allowed to call the proxy (CORS). Default none: a request
   * that carries an `Origin` header not listed here is refused.
   */
  allowedOrigins?: string[];
  /** Largest request body accepted, in bytes (default 4 MiB). */
  maxBodyBytes?: number;
}

/** Who an HTTP client authenticated as. */
export interface Principal {
  /** Customer the client's token is mapped to (`authTokensFile`), when there is one. */
  customerId?: string;
  /** Non-secret label for logs: `token#<first 8 hex chars of its SHA-256>`. */
  label: string;
}

/** What a {@link CustomerResolver} sees for one tool call. */
export interface CustomerContext {
  toolName: string;
  agentId: string;
  sessionId: string;
  requestId: string | number;
  /** The call's `params._meta`, as the client sent it (untrusted). */
  meta?: Record<string, unknown>;
  /** The authenticated client on the HTTP transports; undefined on stdio. */
  principal?: Principal;
}

export type CustomerResolver = (context: CustomerContext) => string | null | undefined;

export interface ProxyConfig {
  transport: TransportType;

  // stdio mode
  command?: string;
  args?: string[];
  /** Extra variables for the child process (passed as given, except AFORO_*). */
  env?: Record<string, string>;
  /**
   * Names of the proxy's own environment variables the child inherits, on top
   * of the base set (PATH, HOME, locale, temp dirs, ...). Everything else —
   * and every AFORO_* variable — is withheld from the child.
   */
  passEnv?: string[];
  /**
   * File the proxy touches every few seconds while it is serving. A container
   * health check tests that it is fresh. Removed on shutdown.
   */
  healthFile?: string;
  /**
   * Install SIGTERM/SIGINT handlers that flush and exit the process (default
   * true, which is what the CLI wants). Set false when embedding the proxy and
   * call `stop()` yourself.
   */
  handleSignals?: boolean;

  // SSE / Streamable HTTP mode
  upstream?: string;
  listen?: ListenConfig;

  aforo: AforoConfig;
}

// ─── JSON-RPC ───────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

// ─── Telemetry ──────────────────────────────────────────────────────────────

export interface ProxyUsageEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
  idempotencyKey: string;
  productType: string;
  toolName?: string;
  agentId?: string;
  sessionId?: string;
  sessionBoundary?: 'HEARTBEAT' | 'SESSION_END';
  /** One of the canonical statuses (SUCCESS, ERROR, TIMEOUT, ... — see contract/ingest-contract.json). */
  executionStatus: string;
  executionDurationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface BatchIngestResponse {
  accepted: number;
  duplicates: number;
  failed: number;
  errors?: Array<{ index: number; message: string }>;
  killedSessionIds?: string[];
}

// ─── Quota ──────────────────────────────────────────────────────────────────

export type QuotaDecision = 'ALLOW' | 'DENY' | 'WARN';

export interface QuotaCheckResponse {
  decision: QuotaDecision;
  reason: string;
  currentUsage?: number;
  limit?: number;
  retryAfterMs?: number;
  tierName?: string;
}

// ─── Tool Call Tracking ─────────────────────────────────────────────────────

export interface InFlightCall {
  /** Tool name as sent on the event: the request's name, cut to the ingestor's 64-char limit. */
  toolName: string;
  /** The request's tool name, untruncated — what the idempotency key is derived from. */
  keyToolName?: string;
  agentId: string;
  customerId: string;
  startTime: number;
  requestId: string | number;
  /** Session the call ran in — needed to meter a call that never gets a response. */
  sessionId?: string;
  /** Set when the call's event would be rejected by the ingestor; it is dropped as 'invalid' instead of sent. */
  invalid?: string;
}
