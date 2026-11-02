/**
 * @file Single-event sender for session heartbeats.
 * POST /v1/ingest/batch with `{"events":[event]}`, X-API-Key + X-Tenant-Id,
 * 10 s timeout, sent once. Usage events go through the EventBuffer's
 * transport core instead (queue, retries, breaker, shutdown deadline).
 */

import type { ProxyUsageEvent, BatchIngestResponse } from '../types.js';
import { checkBaseUrl } from '../transport-core/core.js';
import { logger } from '../util/logger.js';

export interface IngestorClientConfig {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  timeout?: number;
  allowInsecureHttp?: boolean;
}

export class IngestorClient {
  private readonly baseUrl: string;
  private readonly apiKey!: string;
  private readonly tenantId: string;
  private readonly timeout: number;

  constructor(config: IngestorClientConfig) {
    this.baseUrl = checkBaseUrl(config.baseUrl, config.allowInsecureHttp === true);
    // Non-enumerable: the key never shows in inspect() or JSON.
    Object.defineProperty(this, 'apiKey', { value: config.apiKey, enumerable: false });
    this.tenantId = config.tenantId;
    this.timeout = config.timeout ?? 10_000;
  }

  /**
   * POST a single event in its own `{"events":[event]}` request, exactly once.
   *
   * Used for session heartbeats: they must never share a batch with usage (a
   * large batch takes the ingestor's high-throughput path, which does not
   * intercept heartbeats), and a lost heartbeat is superseded by the next one,
   * so there is no retry. Never throws; resolves to the parsed response, or
   * null on any failure.
   */
  async sendSingle(event: ProxyUsageEvent): Promise<BatchIngestResponse | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/ingest/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'X-Tenant-Id': this.tenantId,
        },
        body: JSON.stringify({ events: [event] }),
        signal: AbortSignal.timeout(this.timeout),
        // Never follow a redirect: it would send the API key to another host.
        redirect: 'manual',
      });
      if (!response.ok) {
        if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
          logger.warn('Ingestor answered a redirect for a heartbeat; redirects are not followed, check --ingestor-url', {
            status: response.status,
          });
        } else {
          logger.debug('Single-event send rejected', { status: response.status });
        }
        return null;
      }
      try {
        return unwrapEnvelope(await response.json()) as BatchIngestResponse;
      } catch {
        return { accepted: 1, duplicates: 0, failed: 0 };
      }
    } catch (err) {
      logger.debug('Single-event send failed', { error: (err as Error).message });
      return null;
    }
  }

}

/**
 * The ingestor wraps every 2xx JSON body in `{success, data, meta}`. Returns
 * the inner `data` object when present, else the body unchanged (bare shape).
 */
export function unwrapEnvelope(body: any): any {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body.data : undefined;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : body;
}
