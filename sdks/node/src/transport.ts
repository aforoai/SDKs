import { ResolvedEvent, BatchRequest, FlushResult } from './types';

export interface TransportOptions {
  baseUrl: string;
  apiKey: string;
  timeout: number;
  maxRetries: number;
  retryBaseMs: number;
}

/**
 * HTTP transport that sends batched usage events to the Aforo ingestor.
 *
 * - POST /v1/ingest/batch with Authorization: Bearer {apiKey}
 * - Retry on 5xx, 408, 429 with exponential backoff
 * - Respects Retry-After header on 429
 * - No retry on 4xx (bad input)
 * - AbortController timeout per request
 */
export class Transport {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeout = options.timeout;
    this.maxRetries = options.maxRetries;
    this.retryBaseMs = options.retryBaseMs;
  }

  /** Send a batch of events. Returns the number sent and failed. */
  async send(events: ResolvedEvent[]): Promise<FlushResult> {
    if (events.length === 0) return { sent: 0, failed: 0 };

    const url = `${this.baseUrl}/v1/ingest/batch`;
    const body: BatchRequest = { events };
    const bodyStr = JSON.stringify(body);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: bodyStr,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          return { sent: events.length, failed: 0 };
        }

        // 4xx (except 408, 429) — bad input, don't retry
        if (response.status >= 400 && response.status < 500
            && response.status !== 408 && response.status !== 429) {
          return { sent: 0, failed: events.length };
        }

        // 429 — respect Retry-After header
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const delayMs = retryAfter
            ? (parseInt(retryAfter, 10) || 1) * 1000
            : this.retryBaseMs * Math.pow(2, attempt);
          if (attempt < this.maxRetries) {
            await this.sleep(delayMs);
            continue;
          }
        }

        // 5xx or 408 — retry with backoff
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryBaseMs * Math.pow(2, attempt));
          continue;
        }

        return { sent: 0, failed: events.length };

      } catch (err: any) {
        // Network error or abort — retry
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryBaseMs * Math.pow(2, attempt));
          continue;
        }
        return { sent: 0, failed: events.length };
      }
    }

    return { sent: 0, failed: events.length };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
