/**
 * @file Unit tests for QuotaGuard — deny cache, fail-open, timeout behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaGuard } from '../src/interceptor/QuotaGuard.js';

describe('QuotaGuard', () => {
  it('returns null when disabled', async () => {
    const guard = new QuotaGuard({
      ingestorUrl: 'http://localhost:9999',
      tenantId: 'test',
      apiKey: 'key',
      enabled: false,
    });

    const result = await guard.check('customer_1', 'mcp_server.tool_invocations', 1);
    assert.equal(result, null);
  });

  it('fails open when ingestor is unreachable', async () => {
    const guard = new QuotaGuard({
      ingestorUrl: 'http://localhost:1', // Unreachable port
      tenantId: 'test',
      apiKey: 'key',
      enabled: true,
    });

    const result = await guard.check('customer_1', 'mcp_server.tool_invocations', 1);
    // Should fail-open (return null = allow)
    assert.equal(result, null);
  });

  it('returns JSON-RPC error with code -32000 structure', () => {
    // Test the error response shape directly
    const guard = new QuotaGuard({
      ingestorUrl: 'http://localhost:9999',
      tenantId: 'test',
      apiKey: 'key',
      enabled: true,
    });

    // Access private method via prototype for testing
    const response = (guard as any).buildDenyResponse(42, {
      decision: 'DENY',
      reason: 'Quota exceeded',
      currentUsage: 1000,
      limit: 1000,
      retryAfterMs: 3600000,
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 42);
    assert.ok(response.error);
    assert.equal(response.error.code, -32000);
    assert.equal(response.error.message, 'Quota exceeded');
    assert.equal(response.error.data.currentUsage, 1000);
    assert.equal(response.error.data.limit, 1000);
    assert.equal(response.error.data.retryAfterMs, 3600000);
    assert.ok(response.error.data.resetsAt); // ISO string
  });
});
