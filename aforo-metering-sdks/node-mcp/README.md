# @aforoai/mcp-metering

Wrap your MCP server's tool handlers so every `tools/call` is metered for billing, with session tracking, without changing your tool logic. Use it when you own the MCP server source and want metering inline, not a sidecar.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i @aforoai/mcp-metering
```

> **Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on npm yet, install from source:
> ```bash
> git clone https://github.com/aforoai/SDKs.git
> cd SDKs/aforo-metering-sdks/node-mcp
> npm install && npm run build
> npm pack        # produces aforo-mcp-metering-2.0.0.tgz
> # then in your MCP server: npm i /path/to/aforo-mcp-metering-2.0.0.tgz
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
  // Who each call is billed to, from identity your server authenticated
  // (the MCP SDK passes it to the handler as extra.authInfo):
  customerResolver: (request, extra: any) => extra?.authInfo?.extra?.aforoCustomerId,
});

server.setRequestHandler(
  CallToolRequestSchema,
  billing.wrapToolHandler(async (request, extra) => {
    // your tool logic, unchanged
    return { content: [{ type: 'text', text: 'done' }] };
  }),
);

// The SDK installs no signal handlers. Send what is queued from your own:
process.once('SIGTERM', async () => { await billing.shutdown(); process.exit(0); });
```

### Who is billed

`wrapToolHandler` needs a customer source and throws without one:

| Option | Use it when |
|---|---|
| `customerResolver: (request, extra) => customerId` | Your server authenticates callers (OAuth token, API key, session). Return the Aforo customer id; return nothing to leave a call unmetered (its event is dropped as `invalid`, the tool still runs). May be async; the tool's response never waits for it. Wins over the other two. |
| `customerId: 'cust_acme'` | The server serves one customer. |
| `trustCustomerHeader: true` | You control every client and they put the customer in `params._meta.customer_id`. Any client can put any id there, so this is off by default. Calls without one fall back to `customerId`. |

A call is never billed to its agent id or to a placeholder customer.

The wrapper reads `agent_id` and `session_id` from `request.params._meta`. If a `session_id` is present, the first wrapped call starts the session. Session heartbeats (`system.session.heartbeat`) are sent once when the session starts, every `heartbeatIntervalMs` (30s) while it is active, and as a final `SESSION_END` on `endSession()`. Each carries quantity 1, top-level `sessionId`, `productType` and `sessionBoundary`, and the session's customer (`startSession({ customerId })`, the first call's customer, the `customerId` config, else `"system"`; heartbeats are never billed). Each heartbeat is POSTed in its **own** `/v1/ingest/batch` request, never inside a usage batch, so the ingestor always intercepts it before billing. Heartbeats are best-effort: sent once, failures reported to `onError` and otherwise ignored, never affecting usage delivery. The timer is unref'd and stops on `endSession()`/`shutdown()`.

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
| `customerResolver` | `(request, extra) => string \| undefined \| Promise<…>` | unset | Decides the customer per call from authenticated identity (see [Who is billed](#who-is-billed)). |
| `customerId` | `string` | unset | One customer billed for every call. Also the heartbeat customer. |
| `trustCustomerHeader` | `boolean` | `false` | Bill `params._meta.customer_id` as the client sends it. |
| `agentId` | `string` | `"unknown"` | Agent id used when a call has no `_meta.agent_id`. |
| `entitlementMode` | `'SERVER_LEVEL' \| 'TOOL_LEVEL'` | unset | Reserved for entitlement scoping. Accepted but not enforced client-side at this version. |
| `sessionConfig.idleTimeoutSec` | `number` | unset | Reserved for session idle/duration policy. Accepted; not enforced client-side at this version. |
| `sessionConfig.maxDurationSec` | `number` | unset | Reserved; same as above. |
| `flushIntervalMs` | `number` | `5000` | Queued events are sent at least this often. |
| `flushCount` | `number` | `500` | Events per request; reaching it wakes the sender (capped at 1000). |
| `maxQueueSize` | `number` | `10000` | Most events held while the ingestor is unreachable; past it the oldest is dropped (`overflow`). |
| `maxRetries` | `number` | `3` | Retries per request (full-jitter backoff, `Retry-After` honoured in both forms, capped at 60 s) before the batch is re-queued and the sender pauses. |
| `timeoutMs` | `number` | `10000` | Total deadline per ingest request. |
| `shutdownTimeoutMs` | `number` | `5000` | How long `shutdown()` keeps sending; what is left is dropped as `shutdown`. |
| `flushOnExit` | `boolean` | `true` | Send what is queued on the process `beforeExit` event. |
| `allowInsecureHttp` | `boolean` | `false` | Allow plain `http://` on a host other than localhost / 127.0.0.1 / ::1. Otherwise `ingestorUrl` must be `https://`. |
| `heartbeatIntervalMs` | `number` | `30000` | Interval between session heartbeats. |
| `heartbeatEnabled` | `boolean` | `true` | Send session heartbeats while a session is active. |
| `onError` | `(err: Error) => void` | logs to `console.error` | Called when the ingestor becomes unreachable (events kept), on rejected events, on a shutdown that left events behind, on a bad `statusResolver` or `customerResolver`, and on failed heartbeats. Delivery reports are a `CoreTransportError`: branch on `err.kind` (`outage`, `auth`, `rejected`, `shutdown`, `closed`) and read `err.events`, not the message. |
| `onDrop` | `(events, reason) => void` | unset | Called with usage events the SDK is about to lose. `reason` is `rejected`, `invalid`, `overflow`, `shutdown` or `closed`. See [Execution status and dropped events](#execution-status-and-dropped-events). |
| `onSessionKilled` | `(sessionId, reason) => void` | unset | Fired when a heartbeat or usage-batch response lists the active session in `killedSessionIds`. |

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
| `rejected` | The ingestor refused the batch with a non-retryable 4xx (400, 422, ...), or refused these events individually inside a batch it otherwise accepted. Per-event errors marked `retryable` are re-sent instead. |
| `invalid` | The event failed a client-side check and was never queued or sent: no customer (the resolver returned nothing, or no source applied), blank `toolName`, `agentId` over 36, `customerId` over 64, `sessionId` over 64, `productType` over 20. A tool name over 64 characters is not a drop: it is cut to 64 and the event is sent (one warning per label). |
| `overflow` | The queue was full (`maxQueueSize`) during an outage; the oldest event made room. |
| `shutdown` | Still queued when `shutdown()` reached `shutdownTimeoutMs`. |
| `closed` | Recorded after `shutdown()`. |

An ingest outage is not a drop: on network errors, timeouts, 401, 403, 408, 429 and 5xx the batch is retried, then put back at the front of the queue with the same idempotency keys while the sender pauses (5 s, doubling with jitter up to 5 min). A wrong or revoked key (401/403) is logged once per outage, and the usage is sent once a valid key is in place. `recordToolInvocation` and the wrapper never throw. When a 2xx response reports failures without saying which events, the count is added to `droppedCount` and `onDrop` is not called. A failed heartbeat is not a drop. Only one ingest request is in flight at a time.

## Walk me through it

Step-by-step from install to a verified metered tool call: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

This SDK **records** tool usage and reacts to a server kill signal — it does **not** pre-flight a quota check or block a call before it runs. Pre-flight quota gating lives in `@aforoai/mcp-proxy` (the sidecar), not here. Events wait in memory during an outage (up to `maxQueueSize`); they are lost if the process dies before they are sent, and there is no disk spool. Heartbeats report uptime and (where the runtime exposes it) process heap — they are not an SLA monitor.
