/**
 * @file JSON-RPC message parser and router.
 * Parses newline-delimited JSON-RPC messages from streams,
 * detects tool calls and their responses, delegates to ToolCallTracker.
 */

import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from '../types.js';
import { logger } from '../util/logger.js';

/** Methods we meter (bill for tool invocations) */
const METERED_METHODS = new Set(['tools/call']);

/** Methods we track for analytics only (not billed) */
const TRACKED_METHODS = new Set(['tools/list', 'resources/read', 'prompts/get']);

/** Methods we completely ignore */
const IGNORED_METHODS = new Set([
  'initialize', 'initialized', 'ping',
  'notifications/initialized', 'notifications/cancelled',
  'notifications/progress', 'notifications/message',
  'notifications/resources/updated', 'notifications/resources/list_changed',
  'notifications/tools/list_changed', 'notifications/prompts/list_changed',
  'notifications/roots/list_changed',
  'roots/list', 'sampling/createMessage',
]);

export type MessageDirection = 'client-to-server' | 'server-to-client';

export interface ParsedToolCall {
  requestId: string | number;
  toolName: string;
  agentId: string;
}

export interface ParsedToolResponse {
  requestId: string | number;
  hasError: boolean;
  responseBytes: number;
}

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg;
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'result' in msg || 'error' in msg;
}

/**
 * Try to parse a raw string as a JSON-RPC message.
 * Returns null for non-JSON or non-JSON-RPC data.
 */
export function parseMessage(raw: string): JsonRpcMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.jsonrpc === '2.0') {
      return parsed as JsonRpcMessage;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract tool call info from a tools/call JSON-RPC request.
 */
export function extractToolCall(msg: JsonRpcRequest): ParsedToolCall | null {
  if (msg.method !== 'tools/call') return null;
  if (msg.id == null) return null; // notifications have no id

  const params = msg.params as Record<string, unknown> | undefined;
  const toolName = (params?.name as string) ?? 'unknown';
  const meta = params?._meta as Record<string, unknown> | undefined;
  const agentId = (meta?.agent_id as string) ?? 'unknown';

  return { requestId: msg.id, toolName, agentId };
}

/**
 * Check if a JSON-RPC response matches a tracked tool call.
 */
export function extractToolResponse(msg: JsonRpcResponse, rawBytes: number): ParsedToolResponse | null {
  if (msg.id == null) return null;

  return {
    requestId: msg.id,
    hasError: msg.error != null,
    responseBytes: rawBytes,
  };
}

/**
 * Check if a request method should be metered.
 */
export function isMeteredMethod(method: string): boolean {
  return METERED_METHODS.has(method);
}

/**
 * Check if a request method should be tracked (analytics, not billed).
 */
export function isTrackedMethod(method: string): boolean {
  return TRACKED_METHODS.has(method);
}

/**
 * Parse a stream buffer into individual JSON-RPC messages.
 * Handles newline-delimited JSON and Content-Length framing.
 * Returns parsed messages and remaining unparsed buffer.
 */
export function parseStreamBuffer(buffer: string): { messages: string[]; remaining: string } {
  const messages: string[] = [];
  let remaining = buffer;

  // Try newline-delimited JSON first (most common for stdio)
  const lines = remaining.split('\n');
  remaining = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Last element might be incomplete
    if (i === lines.length - 1 && line.length > 0) {
      // Check if it's valid JSON
      try {
        JSON.parse(line);
        messages.push(line);
      } catch {
        // Incomplete — keep as remaining
        remaining = lines[i];
      }
      continue;
    }

    if (line.length > 0) {
      messages.push(line);
    }
  }

  return { messages, remaining };
}
