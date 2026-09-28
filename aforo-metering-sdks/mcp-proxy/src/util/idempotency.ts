/**
 * @file Idempotency key generation for proxy usage events.
 * Format: mcp:proxy:{agentId}:{sessionId}:{toolName}:{requestId}
 *
 * Keys are minted once, when the event is created and pushed into the buffer —
 * never at flush or retry time — so a retried batch carries the same keys and
 * the ingestor deduplicates it. Every distinct event gets a distinct key: a key
 * derived purely from event content would make two genuinely separate tool calls
 * collide (a client is free to re-use a JSON-RPC id), and the ingestor answers
 * DUPLICATE and silently drops the second one, which under-bills.
 */

import { createHash, randomUUID } from 'node:crypto';

export function generateIdempotencyKey(
  agentId: string,
  sessionId: string,
  toolName: string,
  requestId: string | number,
): string {
  // randomUUID() is what makes this unique per call: requestId is the client's
  // JSON-RPC id and Date.now() only has millisecond resolution, so neither is
  // enough on its own to keep two back-to-back invocations of the same tool apart.
  const input = `mcp:proxy:${agentId}:${sessionId}:${toolName}:${requestId}:${Date.now()}:${randomUUID()}`;
  return createHash('sha256').update(input).digest('hex').substring(0, 32);
}

export function generateHeartbeatKey(sessionId: string): string {
  // Random suffix: a SESSION_END can fire in the same millisecond as a HEARTBEAT.
  return `hb:proxy:${sessionId}:${Date.now()}:${Math.random().toString(36).substring(2, 10)}`;
}
