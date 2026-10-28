import { MiddlewareOptions } from '../types.js';
import { isPreflight, resolveMetricName, httpMethodOf, middlewareClient, customerLookup, endpointPathFor } from './common.js';

const DEFAULT_EXCLUDE_PATHS = ['/health', '/ready', '/metrics', '/favicon.ico'];

/**
 * Express middleware that records one usage event per request.
 *
 * Hooks into `res.on('finish')` — runs AFTER the response is sent, so it adds
 * no latency to the request. Metering never throws into the request.
 *
 * ```typescript
 * import { AforoClient } from '@aforoai/metering';
 * import { expressMiddleware } from '@aforoai/metering/middleware/express';
 * const aforo = new AforoClient({ apiKey: process.env.AFORO_API_KEY!, productType: 'API' });
 * app.use(expressMiddleware({ client: aforo, customerResolver: (req) => req.user?.aforoCustomerId }));
 * process.once('SIGTERM', async () => { await aforo.shutdown(); process.exit(0); });
 * ```
 */
export function expressMiddleware(options: MiddlewareOptions) {
  const lookupCustomer = customerLookup(options, (req) => req.headers?.['x-customer-id']);
  const client = middlewareClient(options);

  const excludePaths = options.excludePaths ?? DEFAULT_EXCLUDE_PATHS;
  const excludeStatusCodes = options.excludeStatusCodes ?? [];

  const handler = function aforoMeteringMiddleware(req: any, res: any, next: any) {
    const startTime = Date.now();

    res.on('finish', () => {
      try {
        const path: string = req.originalUrl || req.url || '/';
        const method: string = req.method || 'UNKNOWN';
        const statusCode: number = res.statusCode || 0;

        if (isPreflight(method)) return;
        if (excludePaths.some((p: string) => path.startsWith(p))) return;
        if (excludeStatusCodes.includes(statusCode)) return;

        const quantity = typeof options.quantity === 'function' ? options.quantity(req, res) : options.quantity ?? 1;
        if (!(quantity > 0)) return; // The ingestor rejects quantity <= 0

        const route = typeof req.route?.path === 'string' ? `${req.baseUrl ?? ''}${req.route.path}` : undefined;
        // No customer → track() drops it as 'invalid' and counts it; the request is unaffected.
        client.track({
          customerId: lookupCustomer(req) ?? '',
          metricName: resolveMetricName(options, req, res),
          quantity,
          metadata: options.metadata ? options.metadata(req, res) : undefined,
          productType: options.productType,
          endpointPath: endpointPathFor(options, path, req, route),
          httpMethod: httpMethodOf(method),
          statusCode,
          responseTimeMs: Date.now() - startTime,
        }).catch((err) => console.debug(`[aforo] metering skipped: ${err?.message ?? err}`));
      } catch (err) {
        // Never let metering errors affect the API.
        console.debug(`[aforo] metering skipped: ${(err as Error)?.message ?? err}`);
      }
    });

    next();
  };
  return Object.assign(handler, { client });
}

// Also export as `middleware` for convenience
export const middleware = expressMiddleware;
