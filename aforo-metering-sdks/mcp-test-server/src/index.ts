// Public entry — re-exports the pieces a downstream consumer (loadgen test
// harness, docker-compose regression stack, sales demo) might want to
// programmatically wire in, plus the CLI transport starters.

export { McpTestServer, type ServerOptions } from './server.js';
export { startHttp, type HttpTransportOptions } from './transport/http.js';
export { startStdio, type StdioTransportOptions } from './transport/stdio.js';
export { startSse, type SseTransportOptions } from './transport/sse.js';
export { listTools, hasTool, callTool } from './tools.js';
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpTool,
  McpToolsCallResult,
} from './types.js';
