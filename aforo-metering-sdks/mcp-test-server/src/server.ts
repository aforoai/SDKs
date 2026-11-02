// Transport-agnostic MCP JSON-RPC 2.0 dispatcher.
// Each transport (HTTP, stdio, SSE) parses a raw request into a
// JsonRpcRequest, calls handle(), and writes the JsonRpcResponse back over
// whatever wire it owns. No transport concerns leak into this module.

import { callTool, hasTool, listTools } from './tools.js';
import {
  JsonRpcErrorCode,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpInitializeResult,
  type McpToolsCallParams,
  type McpToolsCallResult,
  type McpToolsListResult,
} from './types.js';

export interface ServerOptions {
  /** Reported in the initialize handshake. Defaults to package name. */
  serverName?: string;
  /** Reported in the initialize handshake. */
  serverVersion?: string;
  /**
   * When true, tools/call sleeps for the tool's simulated latency before
   * returning. Off by default so scenarios can push maximum TPS without
   * artificial delay; enable for demo runs.
   */
  simulateLatency?: boolean;
}

const PROTOCOL_VERSION = '2024-11-05';

export class McpTestServer {
  constructor(private readonly opts: ServerOptions = {}) {}

  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // Notifications (id absent) get no response per JSON-RPC spec.
    const isNotification = request.id === undefined;
    const id = isNotification ? null : (request.id ?? null);

    if (request.jsonrpc !== '2.0') {
      return isNotification ? null : this.error(id, JsonRpcErrorCode.InvalidRequest, 'jsonrpc must be "2.0"');
    }

    try {
      switch (request.method) {
        case 'initialize':
          return this.success<McpInitializeResult>(id, {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: {
              name: this.opts.serverName ?? '@aforoai/mcp-test-server',
              version: this.opts.serverVersion ?? '0.1.0',
            },
            capabilities: { tools: {} },
          });

        case 'initialized':
        case 'notifications/initialized':
          // Client → server notification; no response.
          return null;

        case 'ping':
          return this.success(id, {});

        case 'tools/list':
          return this.success<McpToolsListResult>(id, { tools: listTools() });

        case 'tools/call': {
          const params = (request.params ?? {}) as McpToolsCallParams;
          if (!params.name || typeof params.name !== 'string') {
            return this.error(id, JsonRpcErrorCode.InvalidParams, 'params.name is required');
          }
          // MCP spec: params.arguments MUST be an object when present.
          // Guard so tool handlers never receive a string, array, or number
          // pretending to be an argument bag.
          if (
            params.arguments !== undefined &&
            (params.arguments === null ||
              typeof params.arguments !== 'object' ||
              Array.isArray(params.arguments))
          ) {
            return this.error(id, JsonRpcErrorCode.InvalidParams, 'params.arguments must be an object if present');
          }
          if (!hasTool(params.name)) {
            return this.error(id, JsonRpcErrorCode.MethodNotFound, `unknown tool: ${params.name}`);
          }
          const result = await callTool(
            params.name,
            (params.arguments ?? {}) as Record<string, unknown>,
            { simulateLatency: this.opts.simulateLatency },
          );
          return this.success<McpToolsCallResult>(id, result);
        }

        default:
          if (isNotification) return null;
          return this.error(id, JsonRpcErrorCode.MethodNotFound, `method not found: ${request.method}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return isNotification ? null : this.error(id, JsonRpcErrorCode.InternalError, msg);
    }
  }

  private success<T>(id: JsonRpcRequest['id'], result: T): JsonRpcResponse<T> {
    return { jsonrpc: '2.0', id: id ?? null, result };
  }

  private error(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  }
}
