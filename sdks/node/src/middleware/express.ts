import { AforoClient } from '../client';
import { MiddlewareOptions } from '../types';
import { normalizePath } from '../path-normalizer';

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
        if (excludePaths.some((p: string) => path.startsWith(p))) return;
        if (excludeStatusCodes.includes(statusCode)) return;

        // Resolve metric name
        const routeTemplate: string | undefined = req.route?.path;
        const normalizedPath = normalizePath(path.split('?')[0], routeTemplate);
        let metricName: string;
        if (typeof options.metricName === 'function') {
          metricName = options.metricName(req, res);
        } else if (options.metricName) {
          metricName = options.metricName;
        } else {
          metricName = `${method} ${normalizedPath}`;
        }

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

/** Extract customer ID using the standard fallback chain. */
function extractCustomerId(req: any): string | null {
  // 1. JWT/session user ID
  if (req.user?.id) return String(req.user.id);
  if (req.user?.sub) return String(req.user.sub);

  // 2. Explicit customer header
  const customerHeader = req.headers?.['x-customer-id'];
  if (customerHeader) return String(customerHeader);

  // 3. API key header
  const apiKeyHeader = req.headers?.['x-api-key'];
  if (apiKeyHeader) return String(apiKeyHeader);

  // 4. Authorization bearer token (use as identifier, not as customer ID)
  return null;
}

// Also export as `middleware` for convenience
export const middleware = expressMiddleware;
