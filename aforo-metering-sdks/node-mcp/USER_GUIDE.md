# @aforoai/mcp-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** engineers who own an MCP server's source and want to meter `tools/call` invocations for Aforo billing.

## What you'll build

An MCP server whose tool handlers are wrapped so each invocation fires an Aforo usage event with the tool name, agent id, status, and duration. By the end you'll have confirmed a metered tool call reached the ingestor, not just that the tool returned.

## Prerequisites

- Node >= 18 (built-in `fetch`, `AbortSignal.timeout`).
- An Aforo **API key**, a **tenant id**, and an MCP_SERVER **product id**.
- An MCP server you control, registering handlers via `setRequestHandler(CallToolRequestSchema, ...)`.

## Step 1 — Install the SDK

Public install (once published):

```bash
npm i @aforoai/mcp-metering
```

Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog. If `2.0.0` is not on npm yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/node-mcp
npm install && npm run build
npm pack        # produces aforo-mcp-metering-2.0.0.tgz
```

Then in your MCP server project:

```bash
npm i /path/to/aforo-metering-sdks/node-mcp/aforo-mcp-metering-2.0.0.tgz
```

## Step 2 — Create the billing client

```ts
import { AforoMcpBilling } from '@aforoai/mcp-metering';

const billing = new AforoMcpBilling({
  tenantId: 'tenant_smartai',
  productId: 'prod_mcp_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai',
  productType: 'MCP_SERVER',   // default; sent as top-level productType on every event
  // Pick ONE customer source (wrapToolHandler throws without one):
  customerResolver: (request, extra: any) => extra?.authInfo?.extra?.aforoCustomerId, // from authenticated identity
  // customerId: 'cust_acme',          // or: one customer for every call
  // trustCustomerHeader: true,        // or: bill params._meta.customer_id (trusted clients only)
});
```

The constructor validates `tenantId`, `productId`, `apiKey`, and `ingestorUrl` and throws if any is missing or if `ingestorUrl` is not `https://` (plain http is accepted for localhost, 127.0.0.1 and ::1, or with `allowInsecureHttp: true`). It starts one background sender that posts queued events in batches.

> ⚠ `ingestorUrl` is the **base** URL. The SDK appends `/v1/ingest/batch`. Pass `https://api.aforo.ai` — not the full batch path. A trailing slash is trimmed for you, so either form of the base works.

## Step 3 — Wrap your tool handler

Wrap the exact function you already pass to `setRequestHandler`. The wrapper times the call, records the invocation in a `finally` block (so failures are still metered), and re-throws any error unchanged:

```ts
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

server.setRequestHandler(
  CallToolRequestSchema,
  billing.wrapToolHandler(async (request, extra) => {
    const { name, arguments: args } = request.params;
    // ... your tool logic ...
    return { content: [{ type: 'text', text: 'result' }] };
  }),
);
```

> ⚠ The customer comes from `customerResolver` (it decides alone when set), else `_meta.customer_id` when `trustCustomerHeader` is on, else `customerId`. With none of the three, `wrapToolHandler` throws. A call whose customer cannot be decided still runs; its event is dropped as `invalid` and counted. The wrapper reads `agent_id` and `session_id` from `request.params._meta`; without `_meta.agent_id` or an `agentId` config the event's `agentId` is `"unknown"` (the agent id is never used as the customer).

The wrapper sets `executionStatus`: `SUCCESS` for a normal result, `ERROR` for a result with `isError: true` or a thrown error, `TIMEOUT` for a `TimeoutError` or MCP error code `-32001`. Pass `{ statusResolver }` as the second argument to decide it yourself (see the [README](README.md#execution-status-and-dropped-events)).

A tool invocation the ingestor would reject (no customer, blank tool name, `agentId` over 36 characters, `customerId` or `sessionId` over 64) is not sent and does not throw: it is counted in `billing.droppedCount`, WARN-logged, and passed to `onDrop` with reason `'invalid'`. A tool name over 64 characters is cut to 64 and the event is still sent.

## Step 4 — Manage the session (optional but recommended)

If a `session_id` rides in on `_meta`, the first wrapped call starts the session. To bound the session explicitly, call the lifecycle methods yourself:

```ts
billing.startSession('sess_abc', { customerId: 'cust_acme' }); // starts heartbeats
// ... tool calls happen ...
await billing.endSession();           // SESSION_END heartbeat, clears the session + flushes
```

Session heartbeats (`system.session.heartbeat`) are sent once when the session starts, every `heartbeatIntervalMs` (30s) while it is active, and as a final `SESSION_END` on `endSession()`. Each carries quantity 1, top-level `sessionId`, `productType` and `sessionBoundary`, and the session's customer (`startSession({ customerId })`, the first call's customer, the `customerId` config, else `"system"`). Each heartbeat is POSTed in its **own** `/v1/ingest/batch` request, never inside a usage batch, so the ingestor always intercepts it before billing. Heartbeats are best-effort: sent once, failures reported to `onError` and otherwise ignored, never affecting usage delivery. The timer is unref'd and stops on `endSession()`/`shutdown()`. Set `heartbeatEnabled: false` to turn them off.

## Step 5 — React to a server kill signal

Heartbeat responses and usage-batch responses can both carry `killedSessionIds`. When the active session appears in that list, the SDK stops the session and its heartbeats and calls your `onSessionKilled` callback, so a kill is noticed at the next heartbeat (every `heartbeatIntervalMs`) or the next batch, whichever comes first:

```ts
const billing = new AforoMcpBilling({
  tenantId: 'tenant_smartai',
  productId: 'prod_mcp_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai',
  customerId: 'cust_acme',
  onSessionKilled: (sessionId, reason) => {
    console.warn(`Aforo killed session ${sessionId}: ${reason}`);
    // tear down the agent connection on your side
  },
});
```

> ⚠ The kill signal is only seen when a heartbeat response returns it. It is **not** a real-time interrupt — a session may run until the next heartbeat (≤ `heartbeatIntervalMs`) before the kill is observed. If you need to gate a call *before* it executes, use the proxy's quota enforcement, not this SDK.

## Step 6 — Flush on shutdown

The sender runs on its own, and on the process `beforeExit` event it sends what is queued. A SIGTERM skips `beforeExit`, and the SDK installs no signal handlers, so call `shutdown()` from yours. It sends for at most `shutdownTimeoutMs` (5 s); what is left is dropped as `shutdown` and counted:

```ts
process.once('SIGTERM', async () => {
  await billing.endSession(); // optional: SESSION_END heartbeat
  await billing.shutdown();   // sends queued events within the deadline
  process.exit(0);
});
```

## Step 7 — Verify it landed in Aforo

Point the client at a local catcher to see the exact batch the SDK posts:

```bash
# A throwaway HTTP echo that prints the POST body and returns a kill-free 202:
node -e "require('http').createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{console.log(req.method,req.url,b);res.writeHead(202,{'content-type':'application/json'}).end('{\"accepted\":1,\"duplicates\":0,\"failed\":0}')})}).listen(8084)"
```

```ts
const billing = new AforoMcpBilling({
  tenantId: 'tenant_smartai',
  productId: 'prod_mcp_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'http://localhost:8084',   // SDK appends /v1/ingest/batch; http is allowed for localhost
  customerId: 'cust_acme',
});
```

Invoke a wrapped tool. The catcher prints `POST /v1/ingest/batch` with a body like:

```json
{"events":[
  {"customerId":"cust_acme","metricName":"mcp_server.tool_invocations","quantity":1,"productType":"MCP_SERVER","toolName":"web-search","agentId":"agt_001","sessionId":"sess_abc","executionStatus":"SUCCESS","executionDurationMs":42,"metadata":{"productId":"prod_mcp_001","sdk":"nodejs"}}
]}
```

If you see that batch hit `/v1/ingest/batch`, the wrapper is wired correctly. Point `ingestorUrl` back at `https://api.aforo.ai` and confirm `mcp_server.tool_invocations` shows up against `prod_mcp_001` in your Aforo usage view. Empty dashboard but the catcher saw the batch → it's auth or tenant/product scope (Troubleshooting).

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Tenant scope; sent as `X-Tenant-Id`. |
| `productId` | `string` | — (required) | MCP_SERVER product; carried in event metadata. |
| `apiKey` | `string` | — (required) | `X-API-Key: <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Base URL; SDK appends `/v1/ingest/batch`. |
| `entitlementMode` | `'SERVER_LEVEL' \| 'TOOL_LEVEL'` | unset | Reserved; accepted, not enforced client-side at this version. |
| `sessionConfig.idleTimeoutSec` / `.maxDurationSec` | `number` | unset | Reserved; accepted, not enforced client-side at this version. |
| `flushIntervalMs` | `number` | `5000` | Queued events are sent at least this often. |
| `flushCount` | `number` | `500` | Events per request; reaching it wakes the sender (capped at 1000). |
| `maxQueueSize` | `number` | `10000` | Most events held during an outage; past it the oldest is dropped (`overflow`). |
| `maxRetries` | `number` | `3` | Retries per request before the batch is re-queued and the sender pauses. |
| `timeoutMs` | `number` | `10000` | Total deadline per ingest request. |
| `shutdownTimeoutMs` | `number` | `5000` | How long `shutdown()` keeps sending. |
| `flushOnExit` | `boolean` | `true` | Send what is queued on `beforeExit`. |
| `allowInsecureHttp` | `boolean` | `false` | Allow plain http on a non-local host. |
| `productType` | `string` | `MCP_SERVER` | Top-level `productType` on every event; per-call override via `recordToolInvocation(..., { productType })`. |
| `customerResolver` | `(request, extra) => string \| undefined \| Promise<…>` | unset | Customer per call from authenticated identity. |
| `customerId` | `string` | unset | One customer for every call; also the heartbeat customer. |
| `trustCustomerHeader` | `boolean` | `false` | Bill `params._meta.customer_id` as the client sends it. |
| `agentId` | `string` | `"unknown"` | Agent id when a call has no `_meta.agent_id`. |
| `heartbeatIntervalMs` | `number` | `30000` | Interval between session heartbeats. |
| `heartbeatEnabled` | `boolean` | `true` | Send session heartbeats while a session is active. |
| `onError` | `(err) => void` | `console.error` | Called when the ingestor becomes unreachable (events kept), on rejected events, on a shutdown that left events behind, a bad `statusResolver` / `customerResolver`, and failed heartbeats. Delivery reports are a `CoreTransportError`: branch on `err.kind` (`outage`, `auth`, `rejected`, `shutdown`, `closed`) and read `err.events`, not the message. |
| `onDrop` | `(events, reason) => void` | unset | Called with usage events the SDK is about to lose (`rejected`, `invalid`, `overflow`, `shutdown`, `closed`). Dropped events are also counted in `billing.droppedCount` and WARN-logged. |
| `onSessionKilled` | `(sessionId, reason) => void` | unset | Fired when a heartbeat or usage-batch response lists the active session as killed. A throw goes to `onError`. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `tenantId/productId/apiKey/ingestorUrl is required` thrown at construction | A required config value is empty | Provide all four. The constructor fails fast. |
| Events POST to `…/v1/ingest/batch/v1/ingest/batch` (404) | Passed the full batch path as `ingestorUrl` | Pass only the base URL; the SDK appends `/v1/ingest/batch`. |
| `wrapToolHandler` throws `no customer source` | None of `customerResolver`, `customerId`, `trustCustomerHeader` is set | Set one (see Step 2). |
| `Dropped N event(s) — invalid: no customer` | The resolver returned nothing for those calls | Return the customer id from the resolver for every authenticated caller. |
| `Aforo ingestor answered HTTP 401` logged, `onError` says unavailable | Bad API key or tenant mismatch | Check `AFORO_API_KEY` and that `tenantId` matches the product. The usage stays queued and is sent once the key works. |
| Dashboard empty though `onError` never fired | Unknown metric on the product, or wrong `productId` | Confirm `mcp_server.tool_invocations` exists on the MCP_SERVER product and `productId` is correct. |
| Session kill is observed late | Kill signals only arrive on a heartbeat response | Lower `heartbeatIntervalMs`, or pre-gate calls with the proxy's quota enforcement for real-time blocking. |
| `Dropped N event(s) — <reason>` WARN | Events were rejected, failed a client-side check, overflowed the queue during an outage, or were still queued at the shutdown deadline | Read the reason in the WARN; pass `onDrop` to capture the events. |
| Process exits, last few events missing | Exited on SIGTERM without `shutdown()` | `await billing.shutdown()` in your SIGTERM/SIGINT handler before exit. |

## What this guide does NOT cover

- **Pre-flight quota / blocking a call before it runs.** This SDK meters after the fact and only reacts to a kill signal on the next heartbeat. Use `@aforoai/mcp-proxy --quota-enforcement` for a pre-flight gate.
- **Metering MCP servers you don't own the source of.** Use the proxy sidecar (`@aforoai/mcp-proxy`) for stdio/SSE/HTTP servers you can't modify.
- **Product / metric / rate-plan setup.** Creating the MCP_SERVER product and its `mcp_server.tool_invocations` metric is done in the Aforo console.
