/**
 * @file Idempotency key generation for proxy usage events.
 * Format: mcp:proxy:{agentId}:{sessionId}:{toolName}:{requestId}
 */

import { createHash } from 'node:crypto';

export function generateIdempotencyKey(
  agentId: string,
  sessionId: string,
  toolName: string,
  requestId: string | number,
): string {
  const input = `mcp:proxy:${agentId}:${sessionId}:${toolName}:${requestId}:${Date.now()}`;
  return createHash('sha256').update(input).digest('hex').substring(0, 32);
}

export function generateHeartbeatKey(sessionId: string): string {
  // Random suffix: a SESSION_END can fire in the same millisecond as a HEARTBEAT.
  return `hb:proxy:${sessionId}:${Date.now()}:${Math.random().toString(36).substring(2, 10)}`;
}
