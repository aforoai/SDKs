/**
 * @file The proxy's own requests to Aforo (heartbeat send, quota check) never
 * follow a redirect: each carries X-API-Key, and following a 3xx would hand
 * the key to whatever host the Location names. Real HTTP: server A answers
 * 307 to server B; B must see nothing.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { IngestorClient } from '../src/telemetry/IngestorClient.js';
import { QuotaGuard } from '../src/interceptor/QuotaGuard.js';
import type { ProxyUsageEvent } from '../src/types.js';

function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

function event(): ProxyUsageEvent {
  return {
    customerId: 'c', metricName: 'system.session.heartbeat', quantity: 1,
    occurredAt: new Date().toISOString(), idempotencyKey: 'hb-1', productType: 'MCP_SERVER',
    toolName: 't', agentId: 'a', executionStatus: 'SUCCESS',
  };
}

describe('redirects from the ingestor are never followed', () => {
  let a: { server: http.Server; url: string };
  let b: { server: http.Server; url: string };
  const seenByB: Array<string | undefined> = [];

  before(async () => {
    b = await listen((req, res) => {
      seenByB.push(req.headers['x-api-key'] as string | undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { decision: 'ALLOW', accepted: 1, duplicates: 0, failed: 0 } }));
    });
    a = await listen((req, res) => {
      req.resume();
      res.writeHead(307, { Location: `${b.url}${req.url}` });
      res.end();
    });
  });

  after(() => {
    a.server.close();
    b.server.close();
  });

  it('a heartbeat answered with 307 is not re-sent to the Location host', async () => {
    const client = new IngestorClient({ baseUrl: a.url, apiKey: 'proxy-secret-key', tenantId: 't' });
    assert.equal(await client.sendSingle(event()), null);
    assert.deepEqual(seenByB, []);
  });

  it('a quota check answered with 307 is not re-sent to the Location host, and is treated as unavailable', async () => {
    const guard = new QuotaGuard({ ingestorUrl: a.url, tenantId: 't', apiKey: 'proxy-secret-key', enabled: true });
    // Default fail mode is open: the call is allowed, the key stays home.
    assert.equal(await guard.check('cust_1', 'mcp_server.tool_invocations', 1), null);
    assert.deepEqual(seenByB, []);
  });
});
