import { MiddlewareOptions } from '../types.js';
import { isPreflight, resolveMetricName, httpMethodOf, middlewareClient, customerLookup, endpointPathFor } from './common.js';

const DEFAULT_EXCLUDE_PATHS = ['/health', '/ready', '/metrics', '/favicon.ico'];

/**
 * Koa middleware that records one usage event per request, after `await next()`.
 * Metering never throws into the request.
 *
 * ```typescript
 * import { AforoClient } from '@aforoai/metering';
 * import { koaMiddleware } from '@aforoai/metering/middleware/koa';
 * const aforo = new AforoClient({ apiKey: process.env.AFORO_API_KEY!, productType: 'API' });
 * app.use(koaMiddleware({ client: aforo, customerResolver: (ctx) => ctx.state.user?.aforoCustomerId }));
 * ```
 *
 * `customerResolver` receives the Koa context.
 */
export function koaMiddleware(options: MiddlewareOptions) {
  // customerResolver receives the Koa context; the deprecated customerId function kept receiving ctx.request.
  const legacy = options.customerId;
  const lookupCustomer = customerLookup(
    {
      ...options,
      customerResolver:
        options.customerResolver ?? (typeof legacy === 'function' ? (ctx: any) => legacy(ctx?.request) : undefined),
    },
    (ctx) => ctx?.get?.('x-customer-id') || ctx?.request?.headers?.['x-customer-id'],
  );
  const client = middlewareClient(options);

  const excludePaths = options.excludePaths ?? DEFAULT_EXCLUDE_PATHS;
  const excludeStatusCodes = options.excludeStatusCodes ?? [];

  const handler = async function aforoMeteringMiddleware(ctx: any, next: any) {
    const startTime = Date.now();
    await next();

    try {
      const path: string = ctx.path || ctx.url || '/';
      const method: string = ctx.method || 'UNKNOWN';
      const statusCode: number = ctx.status || 0;

      if (isPreflight(method)) return;
      if (excludePaths.some((p: string) => path.startsWith(p))) return;
      if (excludeStatusCodes.includes(statusCode)) return;

      const quantity =
        typeof options.quantity === 'function' ? options.quantity(ctx.request, ctx.response) : options.quantity ?? 1;
      if (!(quantity > 0)) return; // The ingestor rejects quantity <= 0

      client.track({
        customerId: lookupCustomer(ctx) ?? '',
        metricName: resolveMetricName(options, ctx.request, ctx.response),
        quantity,
        metadata: options.metadata ? options.metadata(ctx.request, ctx.response) : undefined,
        productType: options.productType,
        endpointPath: endpointPathFor(options, path, ctx, ctx._matchedRoute ?? ctx.routerPath),
        httpMethod: httpMethodOf(method),
        statusCode,
        responseTimeMs: Date.now() - startTime,
      }).catch((err) => console.debug(`[aforo] metering skipped: ${err?.message ?? err}`));
    } catch (err) {
      // Never let metering affect the API.
      console.debug(`[aforo] metering skipped: ${(err as Error)?.message ?? err}`);
    }
  };
  return Object.assign(handler, { client });
}
