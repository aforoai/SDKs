// Public API for @aforoai/metering

export { AforoClient } from './client';
export { expressMiddleware, middleware } from './middleware/express';
export { fastifyPlugin } from './middleware/fastify';
export { koaMiddleware } from './middleware/koa';
export { normalizePath } from './path-normalizer';
export { DEFAULT_METRIC_NAME } from './middleware/common';
export {
  MAX_LENGTHS,
  MAX_QUANTITY_DECIMAL_PLACES,
  MAX_QUANTITY_INTEGER_DIGITS,
  describeLimitViolation,
} from './limits';

export type {
  AforoOptions,
  TrackEvent,
  MiddlewareOptions,
  FlushResult,
  BatchRequest,
  BatchResponse,
} from './types';
