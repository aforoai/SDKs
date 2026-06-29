/**
 * @file Shared types for @aforo/mcp-proxy
 */

// ─── Configuration ──────────────────────────────────────────────────────────

export type TransportType = 'stdio' | 'sse' | 'streamable-http';

export interface AforoConfig {
  tenantId: string;
  productId: string;
  apiKey: string;
  ingestorUrl: string;
  agentId?: string;
  quotaEnforcement?: boolean;
  flushIntervalMs?: number;
  flushCount?: number;
  heartbeatIntervalMs?: number;
  debug?: boolean;
}

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
  productType: 'MCP_SERVER';
  toolName?: string;
  agentId: string;
  sessionId?: string;
  sessionBoundary?: 'HEARTBEAT' | 'SESSION_START' | 'SESSION_END';
  executionStatus: 'SUCCESS' | 'ERROR';
  executionDurationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface BatchIngestResponse {
  accepted: number;
  duplicates: number;
  failed: number;
  errors?: Array<{ index: number; error: string }>;
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
  toolName: string;
  agentId: string;
  startTime: number;
  requestId: string | number;
}
