# @aforoai/mcp-metering

Wrap your MCP server's tool handlers so every `tools/call` is metered for billing, with session tracking, without changing your tool logic. Use it when you own the MCP server source and want metering inline, not a sidecar.

**Version:** 1.3.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i @aforoai/mcp-metering
```

> **Install `1.3.2` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `1.3.2` is not on npm yet, install from source:
> ```bash
> git clone https://github.com/aforoai/SDKs.git
> cd SDKs/aforo-metering-sdks/node-mcp
> npm install && npm run build
> npm pack        # produces aforo-mcp-metering-1.3.2.tgz
> # then in your MCP server: npm i /path/to/aforo-mcp-metering-1.3.2.tgz
> ```

Requires Node >= 18 (uses the built-in `fetch` and `AbortSignal.timeout`).

## Quickstart

Wrap the handler you already pass to `setRequestHandler`. The wrapper times the call, fires a usage event, and re-throws any error unchanged:

```ts
import { AforoMcpBilling } from '@aforoai/mcp-metering';
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
| `onError` | `(err: Error) => void` | logs to `console.error` | Called on a non-retryable 4xx, after retries are exhausted, on per-event rejections, on a bad `statusResolver` and on failed heartbeats. |
| `onDrop` | `(events, reason) => void` | unset | Called with usage events the SDK is about to lose. `reason` is `retry_exhausted`, `rejected` or `invalid`. See [Execution status and dropped events](#execution-status-and-dropped-events). |
| `onSessionKilled` | `(sessionId, reason) => void` | unset | Fired when a batch or heartbeat response lists the active session in `killedSessionIds`. |

## Execution status and dropped events

`wrapToolHandler` sets `executionStatus` on each event:

| Outcome | `executionStatus` |
|---|---|
| Normal result | `SUCCESS` |
| Result with `isError: true` | `ERROR` |
| Thrown error / JSON-RPC error | `ERROR` |
| `TimeoutError`, or an MCP error with code `-32001` | `TIMEOUT` |

To decide the status yourself, pass a resolver. It receives the result and the error; return one of `EXECUTION_STATUSES` (`SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`), or nothing to use the default. It must be synchronous: a Promise, a value outside the 11 statuses, or an exception is reported to `onError` and the default is used.

```ts
billing.wrapToolHandler(handler, {
  statusResolver: (result, error) => (result?.structuredContent?.partial ? 'PARTIAL' : undefined),
});
```

Every usage event the SDK loses is counted in `billing.droppedCount`, WARN-logged, and passed to the opt-in `onDrop(events, reason)` hook. Events keep their idempotency keys, so re-sending them is dedup-safe.

| `reason` | When |
|---|---|
| `retry_exhausted` | A batch failed all 3 attempts (network error, 5xx, 408, 429). |
| `rejected` | The ingestor refused the batch with a non-retryable 4xx, or refused these events individually inside a batch it otherwise accepted. |
| `invalid` | The event failed a client-side check and was never buffered or sent: blank `toolName`, `agentId` over 36, `customerId` over 64, `sessionId` over 64, `productType` over 20. A tool name over 64 characters is not a drop: it is cut to 64 and the event is sent (one warning per label). |

`recordToolInvocation` and the wrapper never throw for an invalid event. When a 2xx response reports failures without saying which events, the count is added to `droppedCount` and `onDrop` is not called. A failed heartbeat is not a drop.

## Walk me through it

Step-by-step from install to a verified metered tool call: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

This SDK **records** tool usage and reacts to a server kill signal — it does **not** pre-flight a quota check or block a call before it runs. Pre-flight quota gating lives in `@aforoai/mcp-proxy` (the sidecar), not here. Delivery is best-effort with a 3-attempt exponential backoff (408/429/5xx/network errors; `Retry-After` honoured on 429; other 4xx are not retried); after that the batch is dropped with reason `retry_exhausted` (see above). Heartbeats report uptime and (where the runtime exposes it) process heap — they are not an SLA monitor.
