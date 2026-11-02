// Public entry — re-exports the pieces a downstream consumer (loadgen test
// harness, docker-compose regression stack, sales demo) might want to
// programmatically wire in, plus the CLI transport starters.

export { AgentTestServer, type ServerOptions, type DispatchResult } from './server.js';
export { startHttp, type HttpTransportOptions } from './transport/http.js';
export { startStdio, type StdioTransportOptions } from './transport/stdio.js';
export { startSse, type SseTransportOptions } from './transport/sse.js';
export { listCapabilities, hasCapability, callCapability } from './capabilities.js';
export {
  SessionStore,
  SessionCapacityExceededError,
  SessionEndedError,
  UnknownSessionError,
  type Session,
  type SessionStatus,
  type SessionStoreOptions,
} from './sessions.js';
export type {
  CreateSessionRequest,
  CreateSessionResponse,
  InvokeRequest,
  InvokeResponse,
  EndSessionResponse,
  GetSessionResponse,
  ErrorResponse,
  ExecutionStatus,
  StdioRequest,
  StdioResponse,
} from './types.js';
export { ErrorCode } from './types.js';
