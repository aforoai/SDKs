# @aforo/mcp-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** engineers who own an MCP server's source and want to meter `tools/call` invocations for Aforo billing.

## What you'll build

An MCP server whose tool handlers are wrapped so each invocation fires an Aforo usage event with the tool name, agent id, status, and duration . By the end you'll have confirmed a metered tool call reached the ingestor, not just that the tool returned.

## Prerequisites

- Node >= 18 (built-in `fetch`, `AbortSignal.timeout`).
- An Aforo **API key**, a **tenant id**, and an MCP_SERVER **product id**.
- An MCP server you control, registering handlers via `setRequestHandler(CallToolRequestSchema, ...)`.

## Step 1 — Install the SDK

Public install (once published):

```bash
npm i @aforo/mcp-metering
```

Not on npm yet, so install from source for now:

```bash
git clone https://github.com/aforoai/aforo-metering-sdks.git
cd aforo-metering-sdks/node-mcp
npm install && npm run build
npm pack        # produces aforo-mcp-metering-1.0.0.tgz
```

Then in your MCP server project:

```bash
npm i /path/to/aforo-metering-sdks/node-mcp/aforo-mcp-metering-1.0.0.tgz
```

## Step 2 — Create the billing client

```ts
import { AforoMcpBilling } from '@aforo/mcp-metering';

const billing = new AforoMcpBilling({
  tenantId: 'tenant_smartai',
  productId: 'prod_mcp_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai',
  productType: 'MCP_SERVER',   // default; sent as top-level productType on every event
  // customerId: 'cust_acme',  // optional: bill this customer instead of the agentId
});
```

The constructor validates `tenantId`, `productId`, `apiKey`, and `ingestorUrl` and throws if any is missing — and it starts the periodic flush timer immediately.

> ⚠ `ingestorUrl` is the **base** URL. The SDK appends `/v1/ingest/batch`. Pass `https://api.aforo.ai` — not the full batch path. A trailing slash is trimmed for you, so either form of the base works.

## Step 3 — Wrap your tool handler

Wrap the exact function you already pass to `setRequestHandler`. The wrapper times the call, records the invocation in a `finally` block (so failures are still metered), and re-throws any error unchanged:

```ts
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

server.setRequestHandler(
  CallToolRequestSchema,
  billing.wrapToolHandler(async (request) => {
    const { name, arguments: args } = request.params;
    // ... your tool logic ...
    return { content: [{ type: 'text', text: 'result' }] };
  }),
);
```

> ⚠ The wrapper pulls `agent_id`, `session_id` and `customer_id` from `request.params._meta`. The customer is `_meta.customer_id`, else the `customerId` config, else the agentId. If the calling agent doesn't set `_meta.agent_id` and no `agentId` config is set, the event's `agentId` (and, without a customer, its `customerId`) fall back to the literal string `"unknown"` — your usage rolls up under one phantom customer. Make sure your agents stamp `_meta.agent_id`, or set `agentId` / `customerId` in the config.

## Step 4 — Manage the session (optional but recommended)

If a `session_id` rides in on `_meta`, the first wrapped call starts the session. To bound the session explicitly, call the lifecycle methods yourself:

```ts
billing.startSession('sess_abc', { customerId: 'cust_acme' }); // starts heartbeats
// ... tool calls happen ...
await billing.endSession();           // SESSION_END heartbeat, clears the session + flushes
```

Session heartbeats (`system.session.heartbeat`) are sent once when the session starts, every `heartbeatIntervalMs` (30s) while it is active, and as a final `SESSION_END` on `endSession()`. Each carries quantity 1, top-level `sessionId`, `productType` and `sessionBoundary`, and the session's customer (`startSession({ customerId })`, the first call's customer, the `customerId` config, else `"system"`). Each heartbeat is POSTed in its **own** `/v1/ingest/batch` request, never inside a usage batch, so the ingestor always intercepts it before billing. Heartbeats are best-effort: sent once, failures reported to `onError` and otherwise ignored, never affecting usage delivery. The timer is unref'd and stops on `endSession()`/`shutdown()`. Set `heartbeatEnabled: false` to turn them off.

## Step 5 — React to a server kill signal

The batch response can carry `killedSessionIds`. When the active session appears in that list, the SDK clears the session and calls your `onSessionKilled` callback. The ingestor computes `killedSessionIds` while processing heartbeats, so the signal arrives on heartbeat responses (every `heartbeatIntervalMs`) as well as on batch flushes:

```ts
const billing = new AforoMcpBilling({
  tenantId: 'tenant_smartai',
  productId: 'prod_mcp_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai',
  onSessionKilled: (sessionId, reason) => {
    console.warn(`Aforo killed session ${sessionId}: ${reason}`);
    // tear down the agent connection on your side
  },
});
```

> ⚠ The kill signal is only seen when a heartbeat or batch response returns it. It is **not** a real-time interrupt — a session may run until the next heartbeat (≤ `heartbeatIntervalMs`) or flush before the kill is observed. If you need to gate a call *before* it executes, use the proxy's quota enforcement, not this SDK.

## Step 6 — Flush on shutdown

The periodic timer flushes on its own, but a process can exit mid-interval. Flush explicitly on shutdown:

```ts
process.on('SIGTERM', async () => {
  await billing.shutdown(); // stops the flush timer, flushes remaining events
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
  ingestorUrl: 'http://localhost:8084',   // SDK appends /v1/ingest/batch
});
```

Invoke a wrapped tool. The catcher prints `POST /v1/ingest/batch` with a body like:

```json
{"events":[
  {"customerId":"agt_001","metricName":"mcp_server.tool_invocations","quantity":1,"productType":"MCP_SERVER","toolName":"web-search","agentId":"agt_001","sessionId":"sess_abc","executionStatus":"SUCCESS","executionDurationMs":42,"metadata":{"productId":"prod_mcp_001","sdk":"nodejs"}}
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
| `flushIntervalMs` | `number` | `5000` | Periodic flush cadence. |
| `flushCount` | `number` | `50` | Force flush at this buffer size (capped at 1000). |
| `productType` | `string` | `MCP_SERVER` | Top-level `productType` on every event; per-call override via `recordToolInvocation(..., { productType })`. |
| `customerId` | `string` | unset | Customer billed when a call has no `_meta.customer_id` (else the agentId); also the heartbeat customer. |
| `agentId` | `string` | `"unknown"` | Agent id when a call has no `_meta.agent_id`. |
| `heartbeatIntervalMs` | `number` | `30000` | Interval between session heartbeats. |
| `heartbeatEnabled` | `boolean` | `true` | Send session heartbeats while a session is active. |
| `onError` | `(err) => void` | `console.error` | Called on non-retryable 4xx, after retries exhausted, on per-event rejections, dropped invalid events and failed heartbeats. |
| `onSessionKilled` | `(sessionId, reason) => void` | unset | Fired when a flush or heartbeat response lists the active session as killed. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `tenantId/productId/apiKey/ingestorUrl is required` thrown at construction | A required config value is empty | Provide all four. The constructor fails fast. |
| Events POST to `…/v1/ingest/batch/v1/ingest/batch` (404) | Passed the full batch path as `ingestorUrl` | Pass only the base URL; the SDK appends `/v1/ingest/batch`. |
| All usage rolls up under customer `"unknown"` | Agents don't set `request.params._meta.agent_id` | Have callers stamp `_meta.agent_id` (and `_meta.session_id` for sessions), or set `customerId` / `agentId` in the config. |
| `Aforo ingestor returned 401/403 — not retrying` via `onError` | Bad API key or tenant mismatch | Check `AFORO_API_KEY` and that `tenantId` matches the product. 4xx (except 408/429) is not retried. |
| Dashboard empty though `onError` never fired | Unknown metric on the product, or wrong `productId` | Confirm `mcp_server.tool_invocations` exists on the MCP_SERVER product and `productId` is correct. |
| Session kill is observed late | Kill signals only arrive on a batch flush or heartbeat response | Lower `heartbeatIntervalMs` / `flushIntervalMs`, or pre-gate calls with the proxy's quota enforcement for real-time blocking. |
| Process exits, last few events missing | Exited mid-flush-interval without `shutdown()` | `await billing.shutdown()` on SIGTERM/SIGINT before exit. |

## What this guide does NOT cover

- **Pre-flight quota / blocking a call before it runs.** This SDK meters after the fact and only reacts to a kill signal on the next flush. Use `@aforo/mcp-proxy --quota-enforcement` for a pre-flight gate.
- **Metering MCP servers you don't own the source of.** Use the proxy sidecar (`@aforo/mcp-proxy`) for stdio/SSE/HTTP servers you can't modify.
- **Product / metric / rate-plan setup.** Creating the MCP_SERVER product and its `mcp_server.tool_invocations` metric is done in the Aforo console.
