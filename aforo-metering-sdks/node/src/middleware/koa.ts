import { MiddlewareOptions } from '../types.js';
import {
  isPreflight, resolveMetricName, httpMethodOf, middlewareClient, customerLookup, endpointPathFor,
  DEFAULT_EXCLUDE_PATHS, isExcludedPath, reportMeteringFailure,
} from './common.js';

/**
 * Koa middleware that records one usage event per request once `await next()`
 * settles, including when a later middleware throws (`ctx.throw(404)`, a
 * crash: metered with the status Koa answers). Metering never throws into the
 * request and never changes Koa's error handling.
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

  const meter = (ctx: any, statusCode: number, startTime: number) => {
    const path: string = ctx.path || ctx.url || '/';
    const method: string = ctx.method || 'UNKNOWN';
    try {
      if (isPreflight(method)) return;
      if (isExcludedPath(path, excludePaths)) return;
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
      // A metering function threw: counted as an 'invalid' drop. Never affects the API.
      reportMeteringFailure(client, options, err, { path, method, statusCode });
    }
  };

  const handler = async function aforoMeteringMiddleware(ctx: any, next: any) {
    const startTime = Date.now();
    let failed = false;
    let thrown: unknown;
    try {
      await next();
    } catch (err) {
      failed = true;
      thrown = err;
      throw err; // Koa's error handling is untouched
    } finally {
      // Metered on success AND when a downstream middleware throws (ctx.throw(404), a crash):
      // the error answer is a served request, as with Express and Fastify.
      meter(ctx, failed ? errorStatus(thrown) : ctx.status || 0, startTime);
    }
  };
  return Object.assign(handler, { client });
}

/** The status Koa answers for a thrown error: its 4xx/5xx `status` / `statusCode`, otherwise 500. */
function errorStatus(err: unknown): number {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  return status !== undefined && status >= 400 && status < 600 ? status : 500;
}
