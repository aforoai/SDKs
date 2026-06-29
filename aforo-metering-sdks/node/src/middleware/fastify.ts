import { AforoClient } from '../client';
import { MiddlewareOptions } from '../types';
import { normalizePath } from '../path-normalizer';

const DEFAULT_EXCLUDE_PATHS = ['/health', '/ready', '/metrics', '/favicon.ico'];

/**
 * Fastify plugin that automatically captures API usage events.
 *
 * Uses the `onResponse` hook — runs AFTER the response is sent.
 *
 * ```typescript
 * import { fastifyPlugin } from '@aforo/metering/middleware/fastify';
 * fastify.register(fastifyPlugin, { apiKey: process.env.AFORO_API_KEY });
 * ```
 */
export async function fastifyPlugin(fastify: any, options: MiddlewareOptions) {
  const client = new AforoClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    ...options.clientOptions,
  });

  const excludePaths = options.excludePaths ?? DEFAULT_EXCLUDE_PATHS;
  const excludeStatusCodes = options.excludeStatusCodes ?? [];

  fastify.addHook('onResponse', (request: any, reply: any, done: any) => {
    try {
      const path: string = request.url || '/';
      const method: string = request.method || 'UNKNOWN';
      const statusCode: number = reply.statusCode || 0;

      if (excludePaths.some((p: string) => path.startsWith(p))) return done();
      if (excludeStatusCodes.includes(statusCode)) return done();

      const routeTemplate: string | undefined = request.routeOptions?.url
        ?? request.routerPath;
      const normalizedPath = normalizePath(path.split('?')[0], routeTemplate);

      let metricName: string;
      if (typeof options.metricName === 'function') {
        metricName = options.metricName(request, reply);
      } else if (options.metricName) {
        metricName = options.metricName;
      } else {
        metricName = `${method} ${normalizedPath}`;
      }

      let quantity: number;
      if (typeof options.quantity === 'function') {
        quantity = options.quantity(request, reply);
      } else {
        quantity = options.quantity ?? 1;
      }

      let customerId: string | null;
      if (typeof options.customerId === 'function') {
        customerId = options.customerId(request);
      } else if (options.customerId) {
        customerId = options.customerId;
      } else {
        customerId = (request as any).user?.id
          ?? request.headers?.['x-customer-id']
          ?? request.headers?.['x-api-key']
          ?? null;
      }

      if (!customerId) return done();

      let metadata: Record<string, string | number | boolean> | undefined;
      if (options.metadata) {
        metadata = options.metadata(request, reply);
      }

      client.track({ customerId, metricName, quantity, metadata }).catch(() => {});
    } catch {
      // Never let metering affect the API
    }

    done();
  });

  fastify.addHook('onClose', async () => {
    await client.shutdown();
  });
}

// Mark as fastify plugin
(fastifyPlugin as any)[Symbol.for('skip-override')] = true;
(fastifyPlugin as any)[Symbol.for('fastify.display-name')] = 'aforo-metering';
