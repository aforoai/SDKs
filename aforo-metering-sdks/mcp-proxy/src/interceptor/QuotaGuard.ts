/**
 * @file Pre-flight quota check with fail-open semantics.
 * - 50ms timeout on pre-flight call (latency budget)
 * - In-process deny cache (5s TTL) to avoid hammering endpoint
 * - Returns JSON-RPC error -32000 on DENY
 * - Reads the ingestor's {success, data: {decision}} envelope (bare {decision} also accepted)
 * - WARN is allowed and logged once per minute per customer + metric
 * - Fail-open on any error (network, timeout, unexpected response)
 */

import type { QuotaCheckResponse, JsonRpcResponse } from '../types.js';
import { logger } from '../util/logger.js';

const DENY_CACHE_TTL_MS = 5000;
const PREFLIGHT_TIMEOUT_MS = 50;
const QUOTA_ERROR_CODE = -32000;
const WARN_LOG_WINDOW_MS = 60000;

interface DenyCacheEntry {
  response: QuotaCheckResponse;
  expiresAt: number;
}

export interface QuotaGuardConfig {
  ingestorUrl: string;
  tenantId: string;
  apiKey: string;
  enabled: boolean;
}

export class QuotaGuard {
  private readonly ingestorUrl: string;
  private readonly tenantId: string;
  private readonly apiKey: string;
  private readonly enabled: boolean;
  private readonly denyCache = new Map<string, DenyCacheEntry>();
  private readonly warnedUntil = new Map<string, number>();

  constructor(config: QuotaGuardConfig) {
    this.ingestorUrl = config.ingestorUrl.replace(/\/+$/, '');
    this.tenantId = config.tenantId;
    this.apiKey = config.apiKey;
    this.enabled = config.enabled;
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

    const cacheKey = `${customerId}:${metricName}`;

    // Check deny cache first
    const cached = this.denyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug('Quota denied (cached)', { customerId, metricName });
      return this.buildDenyResponse(requestId, cached.response);
    }

    // Expired cache entry — remove it
    if (cached) {
      this.denyCache.delete(cacheKey);
    }

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
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      });

      if (!response.ok) {
        // Fail-open on non-200
        logger.debug('Quota check returned non-OK, fail-open', { status: response.status });
        return null;
      }

      const result = parseQuotaResponse(await response.json());
      if (!result) {
        // Body is not a quota decision (malformed, unknown shape) — fail-open
        logger.debug('Quota check returned an unrecognised body, fail-open');
        return null;
      }

      if (result.decision === 'DENY') {
        // Cache the deny decision
        this.denyCache.set(cacheKey, {
          response: result,
          expiresAt: Date.now() + DENY_CACHE_TTL_MS,
        });
        logger.info('Quota denied', { customerId, metricName, reason: result.reason, currentUsage: result.currentUsage, limit: result.limit });
        return this.buildDenyResponse(requestId, result);
      }

      if (result.decision === 'WARN') {
        // Allowed, but close to the limit — log once per window, not per call
        const warnedUntil = this.warnedUntil.get(cacheKey) ?? 0;
        if (warnedUntil <= Date.now()) {
          this.warnedUntil.set(cacheKey, Date.now() + WARN_LOG_WINDOW_MS);
          logger.warn('Quota warning — approaching limit', { customerId, metricName, reason: result.reason, currentUsage: result.currentUsage, limit: result.limit });
        }
      }

      // ALLOW or WARN — let it through
      return null;

    } catch (err) {
      // Fail-open on timeout, network error, etc.
      logger.debug('Quota check failed, fail-open', { error: (err as Error).message });
      return null;
    }
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
