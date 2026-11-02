// Public API for @aforoai/metering

export { AforoClient } from './client.js';
export { expressMiddleware, middleware } from './middleware/express.js';
export { fastifyPlugin } from './middleware/fastify.js';
export { koaMiddleware } from './middleware/koa.js';
export { normalizePath } from './path-normalizer.js';
export { DEFAULT_METRIC_NAME } from './middleware/common.js';
export {
  MAX_LENGTHS,
  MAX_QUANTITY_DECIMAL_PLACES,
  MAX_QUANTITY_INTEGER_DIGITS,
  describeLimitViolation,
  truncateToLimit,
} from './limits.js';

export type {
  AforoOptions,
  TrackEvent,
  MiddlewareOptions,
  FlushResult,
  BatchRequest,
  BatchResponse,
  ResolvedEvent,
  DropReason,
} from './types.js';
