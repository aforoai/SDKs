import { createHash, randomUUID } from 'node:crypto';

/**
 * Generate a deterministic idempotency key from event fields.
 * Uses SHA-256, truncated to 32 hex chars for compact storage.
 *
 * Formula: SHA256(customerId + metricName + quantity + occurredAt)
 *
 * NOT the client default any more. `occurredAt` only carries millisecond
 * precision, so two genuinely distinct events for the same customer + metric
 * + quantity inside one millisecond hash to the same key and the ingestor
 * drops the second as a DUPLICATE — silent under-billing. Kept exported for
 * callers who deliberately want content-addressed dedup (e.g. replaying a
 * fixed batch) and pass the result to `track({ idempotencyKey })` themselves.
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
 * Generate a random UUID v4. This is the default key for an event whose caller
 * supplied none: every event gets its own key, so no two distinct events can
 * collide. Dedup stays opt-in via an explicit `idempotencyKey`.
 */
export function generateRandomKey(): string {
  return randomUUID();
}
