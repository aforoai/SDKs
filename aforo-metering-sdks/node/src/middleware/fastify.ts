import { MiddlewareOptions } from '../types.js';
import { isPreflight, resolveMetricName, httpMethodOf, middlewareClient, customerLookup, endpointPathFor } from './common.js';

const DEFAULT_EXCLUDE_PATHS = ['/health', '/ready', '/metrics', '/favicon.ico'];

/**
 * Fastify plugin that records one usage event per request in the
 * `onResponse` hook (after the response is sent).
 *
 * ```typescript
 * import { AforoClient } from '@aforoai/metering';
 * import { fastifyPlugin } from '@aforoai/metering/middleware/fastify';
 * const aforo = new AforoClient({ apiKey: process.env.AFORO_API_KEY!, productType: 'API' });
 * fastify.register(fastifyPlugin, { client: aforo, customerResolver: (request) => request.user?.aforoCustomerId });
 * ```
 *
 * When the plugin creates its own client (apiKey instead of client), it shuts
 * that client down in Fastify's onClose hook. A client you pass in is yours to shut down.
 */
export async function fastifyPlugin(fastify: any, options: MiddlewareOptions) {
  const lookupCustomer = customerLookup(options, (request) => request.headers?.['x-customer-id']);
  const owned = !options.client;
  const client = middlewareClient(options);

  const excludePaths = options.excludePaths ?? DEFAULT_EXCLUDE_PATHS;
  const excludeStatusCodes = options.excludeStatusCodes ?? [];

  fastify.addHook('onResponse', (request: any, reply: any, done: any) => {
    try {
      const path: string = request.url || '/';
      const method: string = request.method || 'UNKNOWN';
      const statusCode: number = reply.statusCode || 0;

      if (isPreflight(method)) return done();
      if (excludePaths.some((p: string) => path.startsWith(p))) return done();
      if (excludeStatusCodes.includes(statusCode)) return done();

      const quantity = typeof options.quantity === 'function' ? options.quantity(request, reply) : options.quantity ?? 1;
      if (!(quantity > 0)) return done(); // The ingestor rejects quantity <= 0

      const elapsed = typeof reply.elapsedTime === 'number'
        ? reply.elapsedTime
        : typeof reply.getResponseTime === 'function' ? reply.getResponseTime() : undefined;

      client.track({
        customerId: lookupCustomer(request) ?? '',
        metricName: resolveMetricName(options, request, reply),
        quantity,
        metadata: options.metadata ? options.metadata(request, reply) : undefined,
        productType: options.productType,
        endpointPath: endpointPathFor(options, path, request, request.routeOptions?.url ?? request.routerPath),
        httpMethod: httpMethodOf(method),
        statusCode,
        ...(typeof elapsed === 'number' ? { responseTimeMs: Math.round(elapsed) } : {}),
      }).catch((err) => console.debug(`[aforo] metering skipped: ${err?.message ?? err}`));
    } catch (err) {
      // Never let metering affect the API.
      console.debug(`[aforo] metering skipped: ${(err as Error)?.message ?? err}`);
    }

    done();
  });

  if (owned) {
    fastify.addHook('onClose', async () => {
      await client.shutdown();
    });
  }
}

// Mark as fastify plugin
(fastifyPlugin as any)[Symbol.for('skip-override')] = true;
(fastifyPlugin as any)[Symbol.for('fastify.display-name')] = 'aforo-metering';
