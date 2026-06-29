/**
 * @file HTTP client for sending batched usage events to Aforo ingestor.
 * POST /v1/ingest/batch with Bearer auth + X-Tenant-Id header.
 * 3x retry with exponential backoff (1s, 2s, 4s). 10s timeout.
 * Pattern reused from aforo-metering-sdks/node/src/transport.ts
 */

import type { ProxyUsageEvent, BatchIngestResponse } from '../types.js';
import { logger } from '../util/logger.js';

export interface IngestorClientConfig {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  timeout?: number;
  maxRetries?: number;
}

export class IngestorClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly tenantId: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(config: IngestorClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.tenantId = config.tenantId;
    this.timeout = config.timeout ?? 10_000;
    this.maxRetries = config.maxRetries ?? 3;
  }

  async sendBatch(events: ProxyUsageEvent[]): Promise<BatchIngestResponse | null> {
    if (events.length === 0) return { accepted: 0, duplicates: 0, failed: 0 };

    const url = `${this.baseUrl}/v1/ingest/batch`;
    const body = JSON.stringify({ events });

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'X-Tenant-Id': this.tenantId,
          },
          body,
          signal: AbortSignal.timeout(this.timeout),
        });

        if (response.ok) {
          try {
            return await response.json() as BatchIngestResponse;
          } catch {
            // Old ingestor may return empty 202
            return { accepted: events.length, duplicates: 0, failed: 0 };
          }
        }

        // 4xx (except 408, 429) — bad input, don't retry
        if (response.status >= 400 && response.status < 500
            && response.status !== 408 && response.status !== 429) {
          logger.error('Ingestor returned non-retryable error', { status: response.status, attempt });
          return null;
        }

        // 429 — respect Retry-After
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const delayMs = retryAfter
            ? (parseInt(retryAfter, 10) || 1) * 1000
            : Math.pow(2, attempt - 1) * 1000;
          if (attempt < this.maxRetries) {
            await this.sleep(delayMs);
            continue;
          }
        }

        // 5xx or 408 — retry with backoff
        if (attempt < this.maxRetries) {
          await this.sleep(Math.pow(2, attempt - 1) * 1000);
          continue;
        }

        logger.error('Ingestor exhausted retries', { status: response.status, attempts: this.maxRetries });
        return null;

      } catch (err) {
        if (attempt < this.maxRetries) {
          logger.warn('Ingestor request failed, retrying', { attempt, error: (err as Error).message });
          await this.sleep(Math.pow(2, attempt - 1) * 1000);
          continue;
        }
        logger.error('Ingestor request failed after all retries', { error: (err as Error).message });
        return null;
      }
    }

    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
