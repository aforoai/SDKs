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
   * Customer billed for tool calls that carry no `_meta.customer_id` (else the
   * call's agentId is billed). Also the customer of session heartbeats.
   */
  customerId?: string;
  /**
   * Top-level `productType` on every event (required by the ingestor).
   * Default `MCP_SERVER`; trimmed and uppercased, unknown values pass through.
   */
  productType?: string;
  quotaEnforcement?: boolean;
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
  flushIntervalMs?: number;
  flushCount?: number;
  heartbeatIntervalMs?: number;
  debug?: boolean;
}

/**
 * Why usage events were permanently dropped.
 * - 'retry_exhausted': the batch failed every send attempt.
 * - 'rejected': the ingestor refused the batch with a non-retryable 4xx, or
 *   refused these events individually inside a batch it otherwise accepted.
 * - 'invalid': the tool call failed a client-side check (agentId over 36
 *   chars, customerId over 64, sessionId over 64) and its event was never
 *   buffered or sent. An over-long toolName is truncated to 64, not dropped.
 */
export type DropReason = 'retry_exhausted' | 'rejected' | 'invalid';

export type ToolStatusResolver = (result: unknown, error: JsonRpcError | undefined) => string | undefined;

export interface ListenConfig {
  port: number;
  host?: string;
}

export interface ProxyConfig {
  transport: TransportType;

  // stdio mode
  command?: string;
  args?: string[];
  env?: Record<string, string>;

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
