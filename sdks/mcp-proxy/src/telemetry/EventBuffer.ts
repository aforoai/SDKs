/**
 * @file Simple array event buffer with flush-on-count and flush-on-timer.
 * Not a ring buffer (proxy has bounded lifetime — no overflow concern).
 */

import type { ProxyUsageEvent } from '../types.js';
import type { IngestorClient } from './IngestorClient.js';
import { logger } from '../util/logger.js';

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
    const events = this.buffer.splice(0);

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
    } finally {
      this.flushing = false;
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
