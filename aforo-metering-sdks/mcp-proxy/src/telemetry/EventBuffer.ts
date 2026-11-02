/**
 * @file Usage-event queue for the proxy, on the shared Node transport core
 * (`../transport-core/core.ts`, copied from `node/src/transport-core/` — edit
 * it there and run `scripts/sync-transport.sh node`).
 *
 * The core gives the proxy one bounded queue (oldest evicted as 'overflow'),
 * one flusher (`push()` never sends), full-jitter retries with Retry-After, a
 * deadline on every request, re-queue plus a breaker during an outage (events
 * keep their idempotency keys), and a shutdown deadline whose leftovers are
 * reported as 'shutdown'.
 *
 * This class also owns drop accounting for the proxy: every usage event that
 * is permanently lost is counted (`droppedCount`), WARN-logged and handed to
 * the opt-in `onDrop` hook with a reason.
 */

import type { DropReason, ProxyUsageEvent } from '../types.js';
import { TransportCore, type CoreFetch, type CoreFlushResult, type CoreShutdownResult } from '../transport-core/core.js';
import { logger } from '../util/logger.js';
import { PROXY_VERSION } from '../version.js';

/** The ingestor's per-request cap on POST /v1/ingest/batch (IngestBatchRequest). */
export const MAX_BATCH_EVENTS = 1000;

export interface EventBufferConfig {
  /** Ingestor base URL (https; http only for loopback or with allowInsecureHttp). */
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  allowInsecureHttp?: boolean;
  /**
   * Request compression: 'gzip' (default) sends batches of 1 KiB or more with
   * Content-Encoding: gzip (needs usage-ingestor wave 8 or later); 'none'
   * always sends plain JSON.
   */
  compression?: 'gzip' | 'none';
  /** Events per request; reaching it wakes the flusher (default 500, max 1000). */
  flushCount?: number;
  /** Flush at least this often, in ms (default 5000). */
  flushIntervalMs?: number;
  /** Queue capacity (default 10 000). */
  maxQueueSize?: number;
  /** Retries per batch before the breaker opens (default 3). */
  maxRetries?: number;
  /** Total deadline per ingest request, in ms (default 10 000). */
  timeoutMs?: number;
  /** shutdown() deadline, in ms (default 5000). */
  shutdownTimeoutMs?: number;
  /** Opt-in hook for permanently dropped usage events. */
  onDrop?: (events: ProxyUsageEvent[], reason: DropReason) => void;
  /** Injectable for tests. */
  fetch?: CoreFetch;
}

export class EventBuffer {
  private readonly core: TransportCore<ProxyUsageEvent>;

  constructor(config: EventBufferConfig) {
    const onDrop = config.onDrop;
    this.core = new TransportCore<ProxyUsageEvent>({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      allowInsecureHttp: config.allowInsecureHttp,
      compression: config.compression,
      headers: { 'X-Tenant-Id': config.tenantId },
      userAgent: `aforo-mcp-proxy/${PROXY_VERSION}`,
      flushCount: config.flushCount,
      flushIntervalMs: config.flushIntervalMs,
      maxQueueSize: config.maxQueueSize,
      maxRetries: config.maxRetries,
      timeoutMs: config.timeoutMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      // The proxy flushes from its own shutdown path (SIGTERM/SIGINT, child exit).
      flushOnExit: false,
      ...(config.fetch ? { fetch: config.fetch } : {}),
      logger: {
        debug: (m) => logger.debug(m),
        warn: (m) => logger.warn(m),
        error: (m) => logger.error(m),
      },
      onDrop: onDrop ? (events, reason) => onDrop(events, reason) : undefined,
    });
  }

  /** Queue one event. Never sends and never throws. */
  push(event: ProxyUsageEvent): void {
    this.core.enqueue(event);
  }

  /** Send what is queued now and wait for it (on the single flusher). */
  flush(): Promise<CoreFlushResult> {
    return this.core.flush();
  }

  /**
   * Account for usage events lost before they were queued (reason 'invalid'):
   * counted, WARN-logged (throttled) and passed to onDrop.
   */
  recordDrop(events: ProxyUsageEvent[], reason: DropReason, detail?: string): void {
    this.core.reportDrop(events, reason, detail);
  }

  /** Usage events permanently dropped since the proxy started. */
  get droppedCount(): number {
    return this.core.droppedCount;
  }

  /** Stop accepting events and drain until the shutdown deadline. */
  shutdown(): Promise<CoreShutdownResult> {
    return this.core.shutdown();
  }

  /** Events queued and not yet accepted. */
  get size(): number {
    return this.core.queued;
  }
}
