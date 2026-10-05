// Wire types for the AI_AGENT test server.
//
// The AI_AGENT wire protocol is REST-shaped (not JSON-RPC like MCP). Sessions
// are first-class resources with their own CRUD endpoints; capability
// invocations POST against an open session. Kept close in spirit to
// mcp-test-server but with a distinct envelope so plugin / SDK / driver code
// can key off the shape without ambiguity.
//
// The four execution_status values match the descriptor at
// aforo-nextgen-common/src/main/resources/descriptors/ai_agent.json
// filterFields[].values so a scenario that flows through this server can
// exercise every branch the usage-ingestor extractor + billing routers care
// about (SUCCESS, FAILURE, BLOCKED, HITL_REQUIRED).

/** Legal execution_status values — mirrors ai_agent.json descriptor. */
export type ExecutionStatus =
  | 'SUCCESS'
  | 'FAILURE'
  | 'BLOCKED'
  | 'HITL_REQUIRED';

/** REST body — POST /agent/session request. */
export interface CreateSessionRequest {
  agentId: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

/** REST body — POST /agent/session response. */
export interface CreateSessionResponse {
  sessionId: string;
  agentId: string;
  startedAt: string;
  idleTimeoutSec: number;
}

/** REST body — POST /agent/invoke request. */
export interface InvokeRequest {
  sessionId: string;
  capability: string;
  input?: Record<string, unknown>;
}

/** REST body — POST /agent/invoke response. */
export interface InvokeResponse {
  invocationId: string;
  sessionId: string;
  capability: string;
  output: Record<string, unknown>;
  executionStatus: ExecutionStatus;
  executionDurationMs: number;
  tokensIn: number;
  tokensOut: number;
}

/** REST body — DELETE /agent/session/{id} response. */
export interface EndSessionResponse {
  sessionId: string;
  agentId: string;
  endedAt: string;
  invocationCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

/** REST body — GET /agent/session/{id} response. */
export interface GetSessionResponse {
  sessionId: string;
  agentId: string;
  startedAt: string;
  invocationCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  status: 'active' | 'ended';
}

/** REST body — error response shape (uniform across every endpoint). */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

/** Stable error codes so downstream drivers can key off them programmatically. */
export const ErrorCode = {
  MalformedBody: 'malformed_body',
  MissingField: 'missing_field',
  UnknownCapability: 'unknown_capability',
  UnknownSession: 'unknown_session',
  SessionEnded: 'session_ended',
  SessionCapacityExceeded: 'session_capacity_exceeded',
  MethodNotAllowed: 'method_not_allowed',
  NotFound: 'not_found',
  BodyTooLarge: 'body_too_large',
  // Reserved for unhandled server-side exceptions escaping the dispatch
  // layer — the transport turns them into a structured 500 body so callers
  // can distinguish a well-formed refusal from a broken server. The message
  // field carries a scrubbed one-liner; the stack never rides on the wire.
  InternalError: 'internal_error',
} as const;

/**
 * Envelope for the stdio transport — one JSON object per line. Method
 * discriminates operation (mirrors JSON-RPC style but our own dispatcher —
 * REST endpoints don't survive stdio, so we keep a compact method enum).
 */
export interface StdioRequest {
  id?: string | number | null;
  method:
    | 'session.create'
    | 'session.get'
    | 'session.end'
    | 'invoke';
  params?: Record<string, unknown>;
}

/** Envelope for stdio responses — mirrors StdioRequest.id echo semantics. */
export interface StdioResponse<T = unknown> {
  id: string | number | null;
  result?: T;
  error?: {
    code: string;
    message: string;
  };
}
