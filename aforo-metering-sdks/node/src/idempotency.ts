import { createHash, randomUUID } from 'node:crypto';

/**
 * Generate a deterministic idempotency key from event fields.
 * Uses SHA-256, truncated to 32 hex chars for compact storage.
 *
 * Formula: SHA256(customerId + metricName + quantity + occurredAt)
 *
 * WARNING - collapse hazard: two legitimately DISTINCT events with identical
 * fields in the same timestamp instant produce the SAME key, so the second
 * dedups away (silent under-billing). The SDK therefore no longer uses this
 * as the automatic fallback for keyless track() calls (2026-07-05 - mirrors
 * Aforo ingest's April 2026 H4 fix). Use it only when your events are
 * guaranteed unique per (customer, metric, quantity, occurredAt).
 */
export function generateIdempotencyKey(
  customerId: string,
  metricName: string,
  quantity: number,
  occurredAt: string,
): string {
  const input = `${customerId}:${metricName}:${quantity}:${occurredAt}`;
  return createHash('sha256').update(input).digest('hex').substring(0, 32);
}

/**
 * Generate a random UUID key - the automatic fallback for keyless track()
 * calls. No caller key = dedup opt-out: every call is a distinct event; the
 * key is stamped once at enqueue so flush retries stay dedup-safe.
 */
export function generateRandomKey(): string {
  return randomUUID();
}
