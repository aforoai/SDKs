import { AforoClient } from '../client';
import { MiddlewareOptions } from '../types';
import { normalizePath } from '../path-normalizer';

const DEFAULT_EXCLUDE_PATHS = ['/health', '/ready', '/metrics', '/favicon.ico'];

/**
 * Koa middleware that automatically captures API usage events.
 *
 * Captures after `await next()` completes — runs after the response is generated.
 *
 * ```typescript
 * import { koaMiddleware } from '@aforo/metering/middleware/koa';
 * app.use(koaMiddleware({ apiKey: process.env.AFORO_API_KEY }));
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
    await next();

    try {
      const path: string = ctx.path || ctx.url || '/';
      const method: string = ctx.method || 'UNKNOWN';
      const statusCode: number = ctx.status || 0;

      if (excludePaths.some((p: string) => path.startsWith(p))) return;
      if (excludeStatusCodes.includes(statusCode)) return;

      const routeTemplate: string | undefined = ctx._matchedRoute ?? ctx.routerPath;
      const normalizedPath = normalizePath(path.split('?')[0], routeTemplate);

      let metricName: string;
      if (typeof options.metricName === 'function') {
        metricName = options.metricName(ctx.request, ctx.response);
      } else if (options.metricName) {
        metricName = options.metricName;
      } else {
        metricName = `${method} ${normalizedPath}`;
      }

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
        customerId = ctx.state?.user?.id
          ?? ctx.get('x-customer-id')
          ?? ctx.get('x-api-key')
          ?? null;
      }

      if (!customerId) return;

      let metadata: Record<string, string | number | boolean> | undefined;
      if (options.metadata) {
        metadata = options.metadata(ctx.request, ctx.response);
      }

      client.track({ customerId, metricName, quantity, metadata }).catch(() => {});
    } catch {
      // Never let metering affect the API
    }
  };
}
