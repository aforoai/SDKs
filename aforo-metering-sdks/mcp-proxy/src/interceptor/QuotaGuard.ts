/**
 * @file Pre-flight quota check.
 * - Default timeout 1000 ms (`quotaTimeoutMs`); 50 ms was shorter than a
 *   normal round trip, so the check almost always timed out and let the call
 *   through (G304).
 * - DENY answers are reused for 5 s, ALLOW answers for `quotaAllowCacheMs`
 *   (default 1 s, 0 = off); WARN answers are never reused. Every cache is
 *   capped and expires (G306).
 * - Returns JSON-RPC error -32000 on DENY.
 * - Reads the ingestor's {success, data: {decision}} envelope (bare {decision} also accepted).
 * - WARN is allowed and logged once per minute per customer + metric.
 * - When the check cannot answer: `quotaFailMode: 'open'` (default) lets the
 *   call through; `'closed'` refuses it with -32000.
 */

import type { QuotaCheckResponse, JsonRpcResponse } from '../types.js';
import { BoundedMap } from '../util/BoundedMap.js';
import { logger } from '../util/logger.js';

const DENY_CACHE_TTL_MS = 5000;
export const DEFAULT_QUOTA_TIMEOUT_MS = 1000;
export const DEFAULT_QUOTA_ALLOW_CACHE_MS = 1000;
const QUOTA_ERROR_CODE = -32000;
const WARN_LOG_WINDOW_MS = 60000;
const MAX_CACHE_ENTRIES = 10_000;

export type QuotaFailMode = 'open' | 'closed';

export interface QuotaGuardConfig {
  ingestorUrl: string;
  tenantId: string;
  apiKey: string;
  enabled: boolean;
  /** Deadline for one quota check in ms (default 1000). */
  timeoutMs?: number;
  /** How long an ALLOW answer is reused, in ms (default 1000; 0 = never). */
  allowCacheMs?: number;
  /** What to do when the check cannot answer (default 'open'). */
  failMode?: QuotaFailMode;
  /** Most entries in each cache (default 10 000). */
  maxCacheEntries?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export class QuotaGuard {
  private readonly ingestorUrl: string;
  private readonly tenantId: string;
  private readonly apiKey: string;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly allowCacheMs: number;
  private readonly failMode: QuotaFailMode;
  private readonly now: () => number;
  private readonly denyCache: BoundedMap<string, QuotaCheckResponse>;
  private readonly allowCache: BoundedMap<string, true>;
  private readonly warnedUntil: BoundedMap<string, true>;

  constructor(config: QuotaGuardConfig) {
    this.ingestorUrl = config.ingestorUrl.replace(/\/+$/, '');
    this.tenantId = config.tenantId;
    this.apiKey = config.apiKey;
    this.enabled = config.enabled;
    this.timeoutMs = positiveOr(config.timeoutMs, DEFAULT_QUOTA_TIMEOUT_MS);
    this.allowCacheMs = config.allowCacheMs !== undefined && Number.isFinite(config.allowCacheMs) && config.allowCacheMs >= 0
      ? config.allowCacheMs
      : DEFAULT_QUOTA_ALLOW_CACHE_MS;
    if (config.failMode !== undefined && config.failMode !== 'open' && config.failMode !== 'closed') {
      throw new Error(`quotaFailMode must be "open" or "closed" (got ${String(config.failMode)})`);
    }
    this.failMode = config.failMode ?? 'open';
    this.now = config.now ?? Date.now;
    const maxEntries = positiveOr(config.maxCacheEntries, MAX_CACHE_ENTRIES);
    this.denyCache = new BoundedMap({ maxEntries });
    this.allowCache = new BoundedMap({ maxEntries });
    this.warnedUntil = new BoundedMap({ maxEntries });
  }

  /**
   * Check if a tool call is allowed. Returns null if allowed,
   * or a JSON-RPC error response if denied.
   */
  async check(
    customerId: string,
    metricName: string,
    requestId: string | number,
  ): Promise<JsonRpcResponse | null> {
    if (!this.enabled) return null;

    const cacheKey = `${customerId}\u0000${metricName}`;
    const now = this.now();

    const denied = this.denyCache.get(cacheKey, now);
    if (denied) {
      logger.debug('Quota denied (cached)', { customerId, metricName });
      return this.buildDenyResponse(requestId, denied);
    }
    if (this.allowCache.get(cacheKey, now)) return null;

    let result: QuotaCheckResponse | null;
    try {
      const url = `${this.ingestorUrl}/api/v1/quota/check`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'X-Tenant-Id': this.tenantId,
        },
        body: JSON.stringify({
          customerId,
          metricName,
          estimatedQuantity: 1,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
        // Never follow a redirect: it would send the API key to another host.
        redirect: 'manual',
      });

      if (!response.ok) {
        const redirected = response.status === 0 || (response.status >= 300 && response.status < 400);
        return this.unavailable(
          requestId,
          redirected ? `HTTP ${response.status} redirect (not followed; check the ingestor URL)` : `HTTP ${response.status}`,
        );
      }
      result = parseQuotaResponse(await response.json());
    } catch (err) {
      return this.unavailable(requestId, (err as Error).message);
    }
    if (!result) {
      return this.unavailable(requestId, 'the answer had no recognisable decision');
    }

    if (result.decision === 'DENY') {
      this.denyCache.set(cacheKey, result, DENY_CACHE_TTL_MS, this.now());
      logger.info('Quota denied', { customerId, metricName, reason: result.reason, currentUsage: result.currentUsage, limit: result.limit });
      return this.buildDenyResponse(requestId, result);
    }

    if (result.decision === 'WARN') {
      // Allowed, but close to the limit — log once per window, not per call.
      if (!this.warnedUntil.get(cacheKey, this.now())) {
        this.warnedUntil.set(cacheKey, true, WARN_LOG_WINDOW_MS, this.now());
        logger.warn('Quota warning — approaching limit', { customerId, metricName, reason: result.reason, currentUsage: result.currentUsage, limit: result.limit });
      }
      return null;
    }

    if (this.allowCacheMs > 0) this.allowCache.set(cacheKey, true, this.allowCacheMs, this.now());
    return null;
  }

  /** The check could not answer: allow (fail-open) or refuse (fail-closed). */
  private unavailable(requestId: string | number, detail: string): JsonRpcResponse | null {
    if (this.failMode === 'open') {
      logger.debug('Quota check unavailable, fail-open', { detail });
      return null;
    }
    logger.warn('Quota check unavailable, refusing the call (fail-closed)', { detail });
    return {
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: QUOTA_ERROR_CODE,
        message: 'Quota check unavailable; the call was refused',
        data: { reason: 'QUOTA_CHECK_UNAVAILABLE' },
      },
    };
  }

  /** Entries held in the deny, allow and warn caches (for tests and diagnostics). */
  get cacheSizes(): { deny: number; allow: number; warn: number } {
    return { deny: this.denyCache.size, allow: this.allowCache.size, warn: this.warnedUntil.size };
  }

  private buildDenyResponse(requestId: string | number, quota: QuotaCheckResponse): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: QUOTA_ERROR_CODE,
        message: quota.reason || 'Quota exceeded',
        data: {
          reason: quota.reason,
          currentUsage: quota.currentUsage,
          limit: quota.limit,
          resetsAt: quota.retryAfterMs
            ? new Date(Date.now() + quota.retryAfterMs).toISOString()
            : undefined,
          retryAfterMs: quota.retryAfterMs,
        },
      },
    };
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a quota decision from a `POST /api/v1/quota/check` body.
 *
 * The ingestor answers 200 with the envelope `{success, data: {decision, ...}}`;
 * a bare `{decision, ...}` is accepted too. Returns null — the caller fails
 * open — for anything else: non-objects, a missing or unknown decision.
 * Never throws.
 */
export function parseQuotaResponse(body: unknown): QuotaCheckResponse | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const outer = body as Record<string, unknown>;
  const inner = outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data)
    ? outer.data as Record<string, unknown>
    : outer;
  const decision = typeof inner.decision === 'string' ? inner.decision.trim().toUpperCase() : '';
  if (decision !== 'ALLOW' && decision !== 'DENY' && decision !== 'WARN') return null;
  const retryAfterMs = finiteNumber(inner.retryAfterMs);
  return {
    decision,
    reason: typeof inner.reason === 'string' ? inner.reason : '',
    currentUsage: finiteNumber(inner.currentUsage),
    limit: finiteNumber(inner.limit),
    retryAfterMs: retryAfterMs !== undefined && retryAfterMs >= 0 ? retryAfterMs : undefined,
    tierName: typeof inner.tierName === 'string' ? inner.tierName : undefined,
  };
}
