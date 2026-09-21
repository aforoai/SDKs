/**
 * @file Simple array event buffer with flush-on-count and flush-on-timer.
 * Not a ring buffer (proxy has bounded lifetime — no overflow concern).
 */

import type { ProxyUsageEvent } from '../types.js';
import type { IngestorClient } from './IngestorClient.js';
import { logger } from '../util/logger.js';

/** The ingestor's per-request cap on POST /v1/ingest/batch (IngestBatchRequest). */
export const MAX_BATCH_EVENTS = 1000;

export interface EventBufferConfig {
  flushCount: number;
  flushIntervalMs: number;
  client: IngestorClient;
}

export class EventBuffer {
  private buffer: ProxyUsageEvent[] = [];
  private readonly flushCount: number;
  private readonly client: IngestorClient;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(config: EventBufferConfig) {
    this.flushCount = config.flushCount;
    this.client = config.client;
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
      const result = await this.client.sendBatch(events);
      if (result) {
        logger.debug('Flushed events', {
          accepted: result.accepted,
          duplicates: result.duplicates,
          failed: result.failed,
        });
      } else {
        logger.warn('Flush failed — events dropped', { count: events.length });
      }
    } catch (err) {
      logger.error('Flush error', { error: (err as Error).message, count: events.length });
    }
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
