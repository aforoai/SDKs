import { createHash, randomUUID } from 'node:crypto';

/**
 * Generate a deterministic idempotency key from event fields.
 * Uses SHA-256, truncated to 32 hex chars for compact storage.
 *
 * Formula: SHA256(customerId + metricName + quantity + occurredAt)
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

/** Generate a random UUID for cases where deterministic keys don't apply. */
export function generateRandomKey(): string {
  return randomUUID();
}
