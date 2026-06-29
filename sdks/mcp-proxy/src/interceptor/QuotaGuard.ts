/**
 * @file Pre-flight quota check with fail-open semantics.
 * - 50ms timeout on pre-flight call (latency budget)
 * - In-process deny cache (5s TTL) to avoid hammering endpoint
 * - Returns JSON-RPC error -32000 on DENY
 * - Fail-open on any error (network, timeout, unexpected response)
 */

import type { QuotaCheckResponse, JsonRpcResponse } from '../types.js';
import { logger } from '../util/logger.js';

const DENY_CACHE_TTL_MS = 5000;
const PREFLIGHT_TIMEOUT_MS = 50;
const QUOTA_ERROR_CODE = -32000;

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
          'Authorization': `Bearer ${this.apiKey}`,
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

      const result = await response.json() as QuotaCheckResponse;

      if (result.decision === 'DENY') {
        // Cache the deny decision
        this.denyCache.set(cacheKey, {
          response: result,
          expiresAt: Date.now() + DENY_CACHE_TTL_MS,
        });
        logger.info('Quota denied', { customerId, metricName, currentUsage: result.currentUsage, limit: result.limit });
        return this.buildDenyResponse(requestId, result);
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
        message: 'Quota exceeded',
        data: {
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
