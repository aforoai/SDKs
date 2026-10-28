/**
 * @file Liveness file for container health checks (G306).
 *
 * While the proxy is serving (stdio child running, or HTTP listener open) it
 * rewrites this file every `intervalMs`; a health check tests that the file is
 * fresh. It is removed on shutdown, so a stopped or hung proxy fails the check.
 */

import { unlinkSync, writeFileSync } from 'node:fs';
import { logger } from './logger.js';

export const DEFAULT_HEALTH_INTERVAL_MS = 10_000;

export class HealthFile {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly path: string, private readonly intervalMs: number = DEFAULT_HEALTH_INTERVAL_MS) {}

  start(): void {
    if (this.timer) return;
    this.touch();
    this.timer = setInterval(() => this.touch(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      unlinkSync(this.path);
    } catch (err) {
      logger.debug('Health file not removed', { path: this.path, error: (err as Error).message });
    }
  }

  private touch(): void {
    try {
      writeFileSync(this.path, `${new Date().toISOString()}\n`);
    } catch (err) {
      logger.warn('Could not write the health file', { path: this.path, error: (err as Error).message });
    }
  }
}
