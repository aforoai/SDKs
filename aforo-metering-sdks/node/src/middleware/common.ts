import { MiddlewareOptions } from '../types.js';
import { truncateRequestLabel } from '../limits.js';
import { AforoClient } from '../client.js';
import { normalizePath as heuristicNormalize } from '../path-normalizer.js';

/**
 * Metric recorded for each request when `metricName` is not configured.
 *
 * It must exist in the tenant's Aforo metric catalog: the ingestor rejects an
 * unknown metric, and because it validates a batch as a whole, one such event
 * fails the entire batch with 400. The previous default, `"METHOD /path"`, is a
 * name no catalog contains, so every event failed out of the box.
 */
export const DEFAULT_METRIC_NAME = 'api_calls';

/**
 * CORS preflights are a browser protocol detail, not a billable call, and carry
 * no credentials -- so they never have a customer. They are never metered.
 */
export function isPreflight(method: string | undefined): boolean {
  return (method || '').toUpperCase() === 'OPTIONS';
}

/** Resolve the metric: resolver function, then fixed name, then DEFAULT_METRIC_NAME. */
export function resolveMetricName(options: MiddlewareOptions, req: any, res: any): string {
  if (typeof options.metricName === 'function') {
    return options.metricName(req, res) || DEFAULT_METRIC_NAME;
  }
  return options.metricName || DEFAULT_METRIC_NAME;
}

/**
 * Request path without its query string. Read off the incoming request, so an
 * over-long path is cut to the ingestor's limit (512) instead of dropping the
 * event — otherwise a caller could avoid metering with a long URL.
 */
export function endpointPathOf(url: string): string {
  return truncateRequestLabel('endpointPath', String(url).split('?')[0] || '/');
}

/** HTTP method off the incoming request, cut to the ingestor's limit (16). */
export function httpMethodOf(method: string): string {
  return truncateRequestLabel('httpMethod', String(method));
}

/** First non-empty string among the candidates, or null. */
export function firstNonEmpty(...values: unknown[]): string | null {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const s = String(Array.isArray(v) ? v[0] : v).trim();
    if (s) return s;
  }
  return null;
}

/** The client a middleware meters through: the app's own, or one built from the options. */
export function middlewareClient(options: MiddlewareOptions): AforoClient {
  if (options?.client) return options.client;
  if (!options?.apiKey) {
    throw new Error('Aforo middleware needs either `client` (an AforoClient your app owns) or `apiKey`.');
  }
  return new AforoClient({ ...(options.clientOptions ?? {}), apiKey: options.apiKey, baseUrl: options.baseUrl });
}

/**
 * Build the per-request customer lookup. Throws at setup when neither a
 * resolver nor the explicit `trustCustomerHeader` opt-in is configured: the
 * X-Customer-Id header is set by whoever calls the API, so it is never read
 * by default.
 */
export function customerLookup(
  options: MiddlewareOptions,
  readHeader: (req: any) => unknown,
): (req: any, headerSource?: any) => string | null {
  const legacy = options?.customerId;
  const resolver =
    options?.customerResolver ??
    (typeof legacy === 'function' ? legacy : typeof legacy === 'string' && legacy.trim() ? () => legacy : undefined);
  const trustHeader = options?.trustCustomerHeader === true;
  if (!resolver && !trustHeader) {
    throw new Error(
      'Aforo middleware needs a customerResolver: (req) => the Aforo customer id from identity your app ' +
        'authenticated (session, verified JWT subject, API-key lookup). To bill the X-Customer-Id header ' +
        'instead — only safe behind a proxy that sets it — pass trustCustomerHeader: true.',
    );
  }
  return (req: any, headerSource: any = req) => {
    const fromResolver = resolver ? firstNonEmpty(resolver(req)) : null;
    if (fromResolver) return fromResolver;
    return trustHeader ? firstNonEmpty(readHeader(headerSource)) : null;
  };
}

/**
 * The endpointPath to send: the query string removed, dynamic segments
 * collapsed unless `normalizePath` is false (a framework route template wins),
 * and cut to the ingestor's 512-character limit.
 */
export function endpointPathFor(options: MiddlewareOptions, rawPath: string, req: any, routeTemplate?: unknown): string {
  const path = String(rawPath ?? '/').split('?')[0] || '/';
  const mode = options?.normalizePath ?? true;
  let out = path;
  if (typeof mode === 'function') {
    out = String(mode(path, req) || path);
  } else if (mode) {
    out = heuristicNormalize(path, typeof routeTemplate === 'string' && routeTemplate ? routeTemplate : undefined);
  }
  return endpointPathOf(out);
}
