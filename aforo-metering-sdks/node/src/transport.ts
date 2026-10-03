import { ResolvedEvent, BatchRequest, FlushResult } from './types.js';

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
 * - POST /v1/ingest/batch with X-API-Key: {apiKey} (never Authorization: Bearer -- the ingestor parses Bearer as a JWT and rejects the request 401)
 * - Retry on 5xx, 408, 429 with exponential backoff
 * - Respects Retry-After header on 429
 * - No retry on 4xx (bad input); the server's error message is surfaced
 * - A 2xx whose body reports per-event failures (`errors[]`) is a partial
 *   failure: those events are reported back as rejected
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
            'X-API-Key': this.apiKey,
          },
          body: bodyStr,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          // A 2xx can still carry per-event rejections (`failed` / `errors[]`).
          const rejected = await readRejectedEvents(response, events.length);
          if (rejected.count > 0) {
            return {
              sent: events.length - rejected.count,
              failed: rejected.count,
              reason: 'rejected',
              ...(rejected.identified ? { rejected: rejected.errors } : {}),
              ...(rejected.errors[0] ? { message: rejected.errors[0].message } : {}),
            };
          }
          return { sent: events.length, failed: 0 };
        }

        // 4xx (except 408, 429) — bad input, don't retry
        if (response.status >= 400 && response.status < 500
            && response.status !== 408 && response.status !== 429) {
          const message = await readErrorMessage(response);
          return {
            sent: 0,
            failed: events.length,
            reason: 'rejected',
            message: `HTTP ${response.status}${message ? `: ${message}` : ''}`,
          };
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

        return { sent: 0, failed: events.length, reason: 'retry_exhausted' };

      } catch (err: any) {
        // Network error or abort — retry
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryBaseMs * Math.pow(2, attempt));
          continue;
        }
        return { sent: 0, failed: events.length, reason: 'retry_exhausted' };
      }
    }

    return { sent: 0, failed: events.length, reason: 'retry_exhausted' };
  }

  /**
   * Send a single event in its own request, once, best-effort.
   *
   * Used for session heartbeats: a heartbeat must never share a batch with
   * usage (a large batch takes the high-throughput path, which does not
   * intercept heartbeats), and a lost heartbeat is simply superseded by the
   * next one -- so there is no retry and every failure is swallowed.
   * Resolves to true when the ingestor accepted the request.
   */
  async sendSingleBestEffort(event: ResolvedEvent): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const body: BatchRequest = { events: [event] };
      const response = await fetch(`${this.baseUrl}/v1/ingest/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

interface RejectedEvents {
  count: number;
  /** True when every rejected event is identified by a valid batch index. */
  identified: boolean;
  errors: Array<{ index: number; message: string }>;
}

async function readJson(response: any): Promise<any> {
  try {
    if (typeof response?.json === 'function') return unwrapEnvelope(await response.json());
    if (typeof response?.text === 'function') return unwrapEnvelope(JSON.parse(await response.text()));
  } catch {
    // Empty or non-JSON body — nothing to report.
  }
  return undefined;
}

/** Per-event rejections reported inside a 2xx batch response. */
async function readRejectedEvents(response: any, batchSize: number): Promise<RejectedEvents> {
  const body = await readJson(response);
  const none: RejectedEvents = { count: 0, identified: false, errors: [] };
  if (!body || typeof body !== 'object') return none;

  const seen = new Set<number>();
  const errors: Array<{ index: number; message: string }> = [];
  if (Array.isArray(body.errors)) {
    for (const e of body.errors) {
      const index = Number(e?.index);
      if (!Number.isInteger(index) || index < 0 || index >= batchSize || seen.has(index)) continue;
      seen.add(index);
      errors.push({ index, message: String(e?.message ?? 'rejected by the ingestor').slice(0, 500) });
    }
  }
  const reported = typeof body.failed === 'number' && body.failed > 0 ? Math.floor(body.failed) : 0;
  const count = Math.min(batchSize, Math.max(reported, errors.length));
  // Only name events when the indexes account for every reported failure.
  return { count, identified: errors.length > 0 && errors.length === count, errors };
}

/** Best-effort server explanation for a rejected request. */
async function readErrorMessage(response: any): Promise<string | undefined> {
  const body = await readJson(response);
  if (!body || typeof body !== 'object') return undefined;
  const first = Array.isArray(body.errors) ? body.errors[0] : undefined;
  const text = first?.message ?? body.detail ?? body.message ?? body.error ?? body.title;
  return typeof text === 'string' && text ? text.slice(0, 500) : undefined;
}

/**
 * The ingestor wraps every 2xx JSON body in `{success, data, meta}`. Returns
 * the inner `data` object when present, else the body unchanged (bare shape).
 */
function unwrapEnvelope(body: any): any {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body.data : undefined;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : body;
}
