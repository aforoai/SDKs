# @aforo/mcp-metering

Wrap your MCP server's tool handlers so every `tools/call` is metered for billing, with session tracking — without changing your tool logic. Best when you own the MCP server source and want metering inline, not a sidecar.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i @aforo/mcp-metering
```

> **Not yet on the public npm registry.** Until it's published, install from source:
> ```bash
> git clone https://github.com/aforoai/aforo-metering-sdks.git
> cd aforo-metering-sdks/node-mcp
> npm install && npm run build
> npm pack        # produces aforo-mcp-metering-1.0.0.tgz
> # then in your MCP server: npm i /path/to/aforo-mcp-metering-1.0.0.tgz
> ```

Requires Node >= 18 (uses the built-in `fetch` and `AbortSignal.timeout`).

## Quickstart

Wrap the handler you already pass to `setRequestHandler`. The wrapper times the call, fires a usage event, and re-throws any error unchanged:

```ts
import { AforoMcpBilling } from '@aforo/mcp-metering';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const billing = new AforoMcpBilling({
  tenantId: 'tenant_smartai',
  productId: 'prod_mcp_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai',
  productType: 'MCP_SERVER',   // default; sent as top-level productType on every event
  customerId: 'cust_acme',     // optional; else _meta.customer_id, else the agentId
});

server.setRequestHandler(
  CallToolRequestSchema,
  billing.wrapToolHandler(async (request) => {
    // your tool logic, unchanged
    return { content: [{ type: 'text', text: 'done' }] };
  }),
);

// On shutdown, flush remaining events and stop timers:
process.on('SIGTERM', () => billing.shutdown());
```

The wrapper reads `agent_id`, `session_id` and `customer_id` from `request.params._meta`. If a `session_id` is present, the first wrapped call starts the session. Session heartbeats (`system.session.heartbeat`) are sent once when the session starts, every `heartbeatIntervalMs` (30s) while it is active, and as a final `SESSION_END` on `endSession()`. Each carries quantity 1, top-level `sessionId`, `productType` and `sessionBoundary`, and the session's customer (`startSession({ customerId })`, the first call's customer, the `customerId` config, else `"system"`). Each heartbeat is POSTed in its **own** `/v1/ingest/batch` request, never inside a usage batch, so the ingestor always intercepts it before billing. Heartbeats are best-effort: sent once, failures reported to `onError` and otherwise ignored, never affecting usage delivery. The timer is unref'd and stops on `endSession()`/`shutdown()`.

> ⚠ `ingestorUrl` is the **base** URL — the SDK appends `/v1/ingest/batch` itself. Pass `https://api.aforo.ai`, not `https://api.aforo.ai/v1/ingest/batch`. A trailing slash is stripped for you.

## Configuration

Pass these to `new AforoMcpBilling({...})`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant scope. Sent as `X-Tenant-Id`. |
| `productId` | `string` | — (required) | The MCP_SERVER product these events bill against. Carried in event metadata. |
| `apiKey` | `string` | — (required) | Sent as `X-API-Key: <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Base ingestor URL. The SDK appends `/v1/ingest/batch`. |
| `productType` | `string` | `MCP_SERVER` | Top-level `productType` on every event (required by the ingestor). Per-call override: `recordToolInvocation(..., { productType })`. Trimmed and uppercased. |
| `customerId` | `string` | unset | Customer billed when a call has no `_meta.customer_id`. Unset: the agentId is billed. Also the heartbeat customer. |
| `agentId` | `string` | `"unknown"` | Agent id used when a call has no `_meta.agent_id`. |
| `entitlementMode` | `'SERVER_LEVEL' \| 'TOOL_LEVEL'` | unset | Reserved for entitlement scoping. Accepted but not enforced client-side at this version. |
| `sessionConfig.idleTimeoutSec` | `number` | unset | Reserved for session idle/duration policy. Accepted; not enforced client-side at this version. |
| `sessionConfig.maxDurationSec` | `number` | unset | Reserved; same as above. |
| `flushIntervalMs` | `number` | `5000` | Periodic flush interval. A timer flushes the buffer on this cadence. |
| `flushCount` | `number` | `50` | Force a flush once the buffer reaches this many events (capped at 1000). |
| `heartbeatIntervalMs` | `number` | `30000` | Interval between session heartbeats. |
| `heartbeatEnabled` | `boolean` | `true` | Send session heartbeats while a session is active. |
| `onError` | `(err: Error) => void` | logs to `console.error` | Called on a non-retryable 4xx, after retries are exhausted, on per-event rejections, on dropped invalid events and on failed heartbeats. |
| `onSessionKilled` | `(sessionId, reason) => void` | unset | Fired when a batch or heartbeat response lists the active session in `killedSessionIds`. |

## Walk me through it

Step-by-step from install to a verified metered tool call: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

This SDK **records** tool usage and reacts to a server kill signal — it does **not** pre-flight a quota check or block a call before it runs. Pre-flight quota gating lives in `@aforo/mcp-proxy` (the sidecar), not here. Delivery is best-effort with a 3-attempt exponential backoff (408/429/5xx/network errors; `Retry-After` honoured on 429; other 4xx are not retried); after that the batch is handed to `onError` and dropped. Heartbeats report uptime and (where the runtime exposes it) process heap — they are not an SLA monitor.

> Source note: `package.json` declares version `1.0.0` and the docs track that. The source carries an internal `SDK_VERSION = '1.1.0'` constant (stamped into heartbeat metadata), and `recordToolInvocation` stamps `sdkVersion: '1.0.0'` in its own metadata — an internal inconsistency that is metadata-only and doesn't affect behavior. The authoritative package version is `1.0.0`.
