// JSON-RPC 2.0 envelope types — matches MCP spec's use of the protocol.

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse<T = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<T = unknown> =
  | JsonRpcSuccessResponse<T>
  | JsonRpcErrorResponse;

// Standard JSON-RPC 2.0 error codes.
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

// ── MCP-specific shapes ──────────────────────────────────────────────────────

export interface McpToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

export interface McpInitializeParams {
  protocolVersion?: string;
  clientInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: { tools: Record<string, never> };
}

export interface McpToolsListResult {
  tools: McpTool[];
}

export interface McpToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
  // Aforo convention: MCP clients tag calls with _meta.agent_id + session_id
  // for gateway plugin extraction. See kong-plugin-aforo-metering/handler.lua
  // detect_mcp_tool_call().
  _meta?: {
    agent_id?: string;
    session_id?: string;
    [k: string]: unknown;
  };
}

export interface McpToolsCallContentItem {
  type: 'text' | 'json';
  text?: string;
  data?: unknown;
}

export interface McpToolsCallResult {
  content: McpToolsCallContentItem[];
  isError?: boolean;
}
