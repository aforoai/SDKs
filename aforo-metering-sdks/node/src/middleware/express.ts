import { AforoClient } from '../client';
import { MiddlewareOptions } from '../types';
import { isPreflight, resolveMetricName, firstNonEmpty } from './common';

const DEFAULT_EXCLUDE_PATHS = ['/health', '/ready', '/metrics', '/favicon.ico'];

/**
 * Express middleware that automatically captures API usage events.
 *
 * Hooks into `res.on('finish')` — runs AFTER the response is sent to the client.
 * Zero latency impact on the API call itself.
 *
 * ```typescript
 * import { expressMiddleware } from '@aforo/metering/middleware/express';
 * app.use(expressMiddleware({ apiKey: process.env.AFORO_API_KEY }));
 * ```
 */
export function expressMiddleware(options: MiddlewareOptions) {
  const client = new AforoClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    ...options.clientOptions,
  });

  const excludePaths = options.excludePaths ?? DEFAULT_EXCLUDE_PATHS;
  const excludeStatusCodes = options.excludeStatusCodes ?? [];

  return function aforoMeteringMiddleware(req: any, res: any, next: any) {
    // Capture timing
    const startTime = Date.now();

    res.on('finish', () => {
      try {
        const path: string = req.originalUrl || req.url || '/';
        const method: string = req.method || 'UNKNOWN';
        const statusCode: number = res.statusCode || 0;

        // Check exclusions
        if (isPreflight(method)) return;
        if (excludePaths.some((p: string) => path.startsWith(p))) return;
        if (excludeStatusCodes.includes(statusCode)) return;

        // Resolve metric name (must be a metric in the tenant's catalog)
        const metricName = resolveMetricName(options, req, res);

        // Resolve quantity
        let quantity: number;
        if (typeof options.quantity === 'function') {
          quantity = options.quantity(req, res);
        } else {
          quantity = options.quantity ?? 1;
        }

        // Resolve customer ID
        let customerId: string | null;
        if (typeof options.customerId === 'function') {
          customerId = options.customerId(req);
        } else if (options.customerId) {
          customerId = options.customerId;
        } else {
          customerId = extractCustomerId(req);
        }

        if (!customerId) return; // Can't meter without a customer

        // Build metadata
        let metadata: Record<string, string | number | boolean> | undefined;
        if (options.metadata) {
          metadata = options.metadata(req, res);
        }

        client.track({
          customerId,
          metricName,
          quantity,
          metadata,
        }).catch(() => {}); // Fire-and-forget

      } catch {
        // Never let metering errors affect the API
      }
    });

    next();
  };
}

/**
 * Default customer resolution: authenticated user id, then X-Customer-Id.
 *
 * The caller's X-Api-Key header is deliberately NOT used: that is the end
 * user's secret, and using it as customerId wrote credentials into billing data
 * while never matching an Aforo customer. Configure `customerId` to map your
 * callers to Aforo customer ids.
 */
function extractCustomerId(req: any): string | null {
  return firstNonEmpty(req.user?.id, req.user?.sub, req.headers?.['x-customer-id']);
}

// Also export as `middleware` for convenience
export const middleware = expressMiddleware;
