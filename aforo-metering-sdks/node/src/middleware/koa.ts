import { AforoClient } from '../client';
import { MiddlewareOptions } from '../types';
import { isPreflight, resolveMetricName, firstNonEmpty, endpointPathOf } from './common';

const DEFAULT_EXCLUDE_PATHS = ['/health', '/ready', '/metrics', '/favicon.ico'];

/**
 * Koa middleware that automatically captures API usage events.
 *
 * Captures after `await next()` completes — runs after the response is generated.
 *
 * ```typescript
 * import { koaMiddleware } from '@aforo/metering/middleware/koa';
 * app.use(koaMiddleware({ apiKey: process.env.AFORO_API_KEY, productType: 'API' }));
 * ```
 */
export function koaMiddleware(options: MiddlewareOptions) {
  const client = new AforoClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    ...options.clientOptions,
  });

  const excludePaths = options.excludePaths ?? DEFAULT_EXCLUDE_PATHS;
  const excludeStatusCodes = options.excludeStatusCodes ?? [];

  return async function aforoMeteringMiddleware(ctx: any, next: any) {
    const startTime = Date.now();
    await next();

    try {
      const path: string = ctx.path || ctx.url || '/';
      const method: string = ctx.method || 'UNKNOWN';
      const statusCode: number = ctx.status || 0;

      if (isPreflight(method)) return;
      if (excludePaths.some((p: string) => path.startsWith(p))) return;
      if (excludeStatusCodes.includes(statusCode)) return;

      const metricName = resolveMetricName(options, ctx.request, ctx.response);

      let quantity: number;
      if (typeof options.quantity === 'function') {
        quantity = options.quantity(ctx.request, ctx.response);
      } else {
        quantity = options.quantity ?? 1;
      }

      let customerId: string | null;
      if (typeof options.customerId === 'function') {
        customerId = options.customerId(ctx.request);
      } else if (options.customerId) {
        customerId = options.customerId;
      } else {
        // Never the caller's X-Api-Key: that is a secret, not a customer id.
        customerId = firstNonEmpty(ctx.state?.user?.id, ctx.get('x-customer-id'));
      }

      if (!customerId) return;
      if (!(quantity > 0)) return; // The ingestor rejects quantity <= 0

      let metadata: Record<string, string | number | boolean> | undefined;
      if (options.metadata) {
        metadata = options.metadata(ctx.request, ctx.response);
      }

      client.track({
        customerId,
        metricName,
        quantity,
        metadata,
        productType: options.productType,
        endpointPath: endpointPathOf(path),
        httpMethod: method,
        statusCode,
        responseTimeMs: Date.now() - startTime,
      }).catch(() => {});
    } catch {
      // Never let metering affect the API
    }
  };
}
