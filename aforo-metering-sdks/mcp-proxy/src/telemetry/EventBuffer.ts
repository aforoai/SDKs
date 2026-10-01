/**
 * @file Simple array event buffer with flush-on-count and flush-on-timer.
 * Not a ring buffer (proxy has bounded lifetime — no overflow concern).
 *
 * Also owns drop accounting for the proxy: every usage event that is
 * permanently lost is counted (`droppedCount`), WARN-logged and handed to the
 * opt-in `onDrop` hook with a reason.
 */

import type { BatchIngestResponse, DropReason, ProxyUsageEvent } from '../types.js';
import type { IngestorClient } from './IngestorClient.js';
import { logger } from '../util/logger.js';

/** The ingestor's per-request cap on POST /v1/ingest/batch (IngestBatchRequest). */
export const MAX_BATCH_EVENTS = 1000;

export interface EventBufferConfig {
  flushCount: number;
  flushIntervalMs: number;
  client: IngestorClient;
  /** Opt-in hook for permanently dropped usage events. */
  onDrop?: (events: ProxyUsageEvent[], reason: DropReason) => void;
}

export class EventBuffer {
  private buffer: ProxyUsageEvent[] = [];
  private readonly flushCount: number;
  private readonly client: IngestorClient;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly onDrop?: (events: ProxyUsageEvent[], reason: DropReason) => void;
  private dropped = 0;
  private invalidDrops = 0;

  constructor(config: EventBufferConfig) {
    this.flushCount = config.flushCount;
    this.client = config.client;
    this.onDrop = config.onDrop;
    this.flushTimer = setInterval(() => this.flush(), config.flushIntervalMs);
  }

  push(event: ProxyUsageEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.flushCount) {
      this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || this.flushing) return;

    this.flushing = true;
    const pending = this.buffer.splice(0);

    // POST /v1/ingest/batch rejects more than MAX_BATCH_EVENTS events with 400
    // (IngestBatchRequest @Size(max = 1000)), losing every event in the batch.
    // Events pushed while a flush is in flight accumulate past flushCount, so
    // the next flush can hold more than that -- send it in slices.
    try {
      for (let i = 0; i < pending.length; i += MAX_BATCH_EVENTS) {
        await this.sendSlice(pending.slice(i, i + MAX_BATCH_EVENTS));
      }
    } finally {
      this.flushing = false;
    }
  }

  private async sendSlice(events: ProxyUsageEvent[]): Promise<void> {
    try {
      const outcome = typeof this.client.sendBatchDetailed === 'function'
        ? await this.client.sendBatchDetailed(events)
        : { result: await this.client.sendBatch(events) };
      const result = outcome.result;
      if (!result) {
        this.recordDrop(events, outcome.reason ?? 'retry_exhausted', outcome.message);
        return;
      }
      logger.debug('Flushed events', {
        accepted: result.accepted,
        duplicates: result.duplicates,
        failed: result.failed,
      });
      this.recordPartialFailure(events, result);
    } catch (err) {
      this.recordDrop(events, 'retry_exhausted', (err as Error).message);
    }
  }

  /**
   * Events the ingestor rejected individually inside a 2xx batch: dropped with
   * reason 'rejected' — by index when the response names them; otherwise they
   * are counted and logged but not handed to onDrop (which ones is unknown).
   */
  private recordPartialFailure(events: ProxyUsageEvent[], result: BatchIngestResponse): void {
    const seen = new Set<number>();
    const errors = (Array.isArray(result.errors) ? result.errors : []).filter((e) => {
      const index = Number(e?.index);
      if (!Number.isInteger(index) || index < 0 || index >= events.length || seen.has(index)) return false;
      seen.add(index);
      return true;
    });
    const reported = typeof result.failed === 'number' && result.failed > 0 ? Math.floor(result.failed) : 0;
    const count = Math.min(events.length, Math.max(reported, errors.length));
    if (count === 0) return;
    if (errors.length === count) {
      this.recordDrop(errors.map((e) => events[Number(e.index)]), 'rejected', errors[0].message);
    } else {
      this.dropped += count;
      logger.warn('Ingestor rejected events in a batch — dropped', {
        count, batchSize: events.length, totalDropped: this.dropped,
      });
    }
  }

  /**
   * Account for permanently lost usage events: bump the counter, WARN-log and
   * call the opt-in onDrop hook (its exceptions are swallowed). 'invalid'
   * WARNs are throttled (first, then every 1000th) so a client that keeps
   * sending a bad tool call can't storm the log.
   */
  recordDrop(events: ProxyUsageEvent[], reason: DropReason, detail?: string): void {
    if (events.length === 0) return;
    this.dropped += events.length;
    let log = true;
    if (reason === 'invalid') {
      this.invalidDrops += events.length;
      log = this.invalidDrops === 1 || this.invalidDrops % 1000 === 0;
    }
    if (log) {
      logger.warn(reason === 'invalid' ? 'Tool call not metered — invalid event dropped' : 'Events dropped', {
        count: events.length, reason, totalDropped: this.dropped, ...(detail ? { detail } : {}),
      });
    }
    if (this.onDrop) {
      try {
        this.onDrop(events, reason);
      } catch {
        // A hook bug must never break metering.
      }
    }
  }

  /** Usage events permanently dropped since the proxy started. */
  get droppedCount(): number {
    return this.dropped;
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  get size(): number {
    return this.buffer.length;
  }
}
