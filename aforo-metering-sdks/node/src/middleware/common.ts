import { MiddlewareOptions } from '../types.js';
import { truncateRequestLabel } from '../limits.js';

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
