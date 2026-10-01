# @aforoai/agent-metering — User Guide

**Version:** 1.2.0 · **Updated:** 2026-10-01 · **Audience:** engineers instrumenting an AI agent (Claude, GPT, LangChain, CrewAI, AutoGen, or a custom loop) for Aforo billing and analytics.

## What you'll build

An agent run that opens an Aforo session, records each reasoning step and tool call with token counts and timing, and closes the session — with the events landing in your Aforo tenant. By the end you'll have confirmed a metered event arrived, not just that the call returned.

## Prerequisites

- Node >= 18 (built-in `fetch`). On Node < 18 you'll pass `fetchImpl` — see Step 2.
- An Aforo **API key**, a **tenant id**, an AI_AGENT **product id**, and the **customer id** to bill. These come from your Aforo console.
- An agent (or a stand-in script) whose lifecycle you can hook: where the run starts, where each step happens, where it ends.

## Step 1 — Install the SDK

Public install (once published):

```bash
npm i @aforoai/agent-metering
```

Install `1.2.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog. If `1.2.0` is not on npm yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/node-agent
npm install && npm run build
npm pack        # produces aforoai-agent-metering-1.2.0.tgz
```

Then in your agent project:

```bash
npm i /path/to/aforo-metering-sdks/node-agent/aforoai-agent-metering-1.2.0.tgz
```

## Step 2 — Create the client once per process

One `AforoAgent` instance is enough for the whole process — every session shares its flush queue.

```ts
import { AforoAgent } from '@aforoai/agent-metering';

const agent = new AforoAgent({
  tenantId: 'tenant_smartai',
  productId: 'prod_agent_001',
  apiKey: process.env.AFORO_API_KEY!,
  customerId: 'cust_acme_001',
  productType: 'AI_AGENT', // default; override per session or per event
  // ingestorUrl: 'http://localhost:8084/v1/ingest', // override for local dev
});
```

> ⚠ On Node < 18 there is no global `fetch`. The constructor throws `no fetch available` unless you pass `fetchImpl` (e.g. `fetchImpl: require('node-fetch')`).

The constructor validates `tenantId`, `productId`, and `apiKey` up front and throws if any is missing — so a misconfigured client fails at startup, not silently at flush time. `customerId` can instead be passed per run to `startSession({ customerId })`. If neither is set nothing throws: the session's events are dropped with reason `invalid` (counted in `agent.droppedCount`, WARN-logged, passed to `onDrop`).

## Step 3 — Open a session at the start of a run

```ts
const session = await agent.startSession({
  agentId: 'agt_001',
  framework: 'CLAUDE',
  modelProvider: 'ANTHROPIC',
  modelName: 'claude-sonnet-4-6',
});
```

This emits an `agent_session_start` event immediately and returns a session handle. The `framework`, `modelProvider`, and `modelName` you set here ride along in the `properties` of every subsequent event — set them once.

> ⚠ If you don't pass a `sessionId`, the SDK generates one (`sess_…`). Capture `session.sessionId` if you need to correlate the run with your own logs — there's no way to look it up later.

## Step 4 — Record each step as the agent reasons

Call `recordStep` once per turn of the agent loop. Pass token counts and timing if you have them:

```ts
await session.recordStep({
  stepKind: 'TOOL_CALL',
  capabilityName: 'web-search',
  inputTokens: 320,
  outputTokens: 84,
  durationMs: 510,
  executionStatus: 'SUCCESS',
});
```

For the common case where the step *is* a tool call, use the shortcut — it stamps `stepKind: 'TOOL_CALL'` and the capability name for you:

```ts
await session.recordToolCall('web-search', {
  inputTokens: 320,
  outputTokens: 84,
  durationMs: 510,
});
```

> ⚠ A step carrying any token count emits **two** events — one `agent_step` and one `token_usage`. Steps and tokens are billed as separate metrics on the AI_AGENT product. Configure your rate plan against the metric you actually charge on; don't try to reconcile the two into one number.

Record a failed step with its status, so error-rate analytics and outcome-based pricing see it. `executionStatus` takes one of `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`; an unknown value is logged and left off.

```ts
await session.recordStep({ stepKind: 'TOOL_CALL', capabilityName: 'db-query', executionStatus: 'ERROR' });
```

## Step 5 — End the session and flush

```ts
await session.end({ taskCompleted: true });
```

`end()` emits a final `agent_session_end` event (carrying the total step count and the task outcome) **and forces a flush**, so everything you recorded is delivered before the process can exit. If the run failed, say so:

```ts
await session.end({ taskCompleted: false, errorMessage: 'tool budget exhausted' });
```

> ⚠ If your process can exit between sessions without ever calling `end()` — e.g. you only use the low-level `agent.emitEvent(...)` — call `await agent.flush()` yourself before exit. A timed flush won't fire if the event loop is already draining.

## Step 6 — Verify it landed in Aforo

Watch the ingest calls leave the process before you trust the dashboard. Point the client at a local catcher to see the exact requests:

```bash
# In one terminal — a throwaway HTTP echo that prints each POST body:
node -e "require('http').createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{console.log(req.method,req.url,b);res.writeHead(202).end('{}')})}).listen(8084)"
```

```ts
const agent = new AforoAgent({
  tenantId: 'tenant_smartai',
  productId: 'prod_agent_001',
  apiKey: process.env.AFORO_API_KEY!,
  customerId: 'cust_acme_001',
  ingestorUrl: 'http://localhost:8084/v1/ingest',
});
```

Run your Step 2–5 script. The catcher prints one `POST /v1/ingest/events` per event (with an `X-API-Key` header; the key is never in the body). For the run above that is four requests:

```json
{"eventType":"agent_session_start","metricKey":"session_count","value":1,"customerId":"cust_acme_001","productType":"AI_AGENT","timestamp":"2026-…Z","idempotencyKey":"agent:…","properties":{"framework":"CLAUDE","agentId":"agt_001","sessionId":"sess_…","productId":"prod_agent_001",…}}
{"eventType":"agent_step","metricKey":"step_count","value":1,"capabilityName":"web-search","properties":{"stepKind":"TOOL_CALL","stepIndex":1,"inputTokens":320,"outputTokens":84,"durationMs":510,"executionStatus":"SUCCESS",…},…}
{"eventType":"token_usage","metricKey":"tokens_total","value":404,…}
{"eventType":"agent_session_end","metricKey":"session_completed","value":1,"properties":{"stepCount":1,"taskCompleted":true,…},…}
```

If you see those requests, the SDK is wired correctly. Then remove the `ingestorUrl` override (the default is `https://api.aforo.ai/v1/ingest`) and confirm the step/session counts appear against `prod_agent_001` in your Aforo usage view. If the dashboard stays empty but the local catcher saw the requests, the problem is auth or tenant/product scope — see Troubleshooting.

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant scope. Stamped on every event + sent as `X-Tenant-Id`. |
| `productId` | `string` | — (required) | The AI_AGENT product the events bill against. |
| `apiKey` | `string` | — (required) | Sent as `X-API-Key: <apiKey>`. |
| `customerId` | `string` | — | Customer billed for the usage, sent top-level on every event. Set here, per session (`startSession({ customerId })`) or per event. |
| `productType` | `string` | `AI_AGENT` | `productType` on every event. Overridable per session (`startSession({ productType })`) and per event (`emitEvent({ productType })`). |
| `ingestorUrl` | `string` | `https://api.aforo.ai/v1/ingest` | Ingest base URL; each event goes to `<ingestorUrl>/events`. Override per environment. |
| `flushBatchSize` | `number` | `50` | Buffer size before a forced flush. |
| `flushIntervalMs` | `number` | `5000` | Max buffer dwell time before a timed flush. |
| `maxRetries` | `number` | `3` | Attempts per event for 408/429/5xx/network failures (other 4xx are not retried). |
| `retryBaseDelayMs` | `number` | `1000` | Base backoff, doubling per attempt; a 429's `Retry-After` wins. |
| `onDrop` | `(events, reason) => void` | unset | Called with events the SDK is about to lose (`retry_exhausted`, `rejected`, `invalid`). |
| `fetchImpl` | `typeof fetch` | global `fetch` | Custom transport; required on Node < 18. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `AforoAgent: tenantId/productId/apiKey is required` thrown at construction | A required config value is empty or undefined | Provide all three. The constructor fails fast on purpose. |
| `no fetch available — pass fetchImpl in config (Node <18)` | Running on Node < 18 with no global `fetch` | Pass `fetchImpl` (e.g. `node-fetch`), or upgrade to Node >= 18. |
| `[aforo-agent] ingestor returned 401` in the console; events dropped | Bad or missing API key | Check `AFORO_API_KEY`. The key goes out as `X-API-Key`. |
| `[aforo-agent] ingestor returned 4xx`; dashboard empty | Tenant/product mismatch or unknown metric on the product | Confirm `tenantId`/`productId` match the AI_AGENT product, and that `step_count`/`tokens_total`/`session_count`/`session_completed` exist on it. |
| Process exits, no events arrive, no error logged | A timed flush never fired before exit | Call `await session.end(...)` (or `await agent.flush()`) before the process exits. |
| Token charges look doubled | Counting both `agent_step` and `token_usage` for the same step | They're distinct metrics by design — bill against one. |
| `[aforo-agent] flush failed…; dropped N events — retry_exhausted` repeatedly | Network/DNS failure reaching `ingestorUrl` | Verify the URL is reachable from the agent host. Each event is retried up to `maxRetries` times first; after that it is dropped. Persist the events from `onDrop` and re-send them later (their idempotency keys make that dedup-safe), or front the agent with a gateway plugin. |
| `[aforo-agent] event … is invalid: …; dropped 1 events — invalid` | The event failed a client-side check; the message names the field | Fix the value (most often a missing `customerId`, or an `agentId` over 36 characters). |

## What this guide does NOT cover

- **Guaranteed delivery.** After its in-flush retries, a failed event is dropped: counted, logged and passed to `onDrop`. There is no on-disk queue. If a lost event is unacceptable, persist from `onDrop` or meter through an Aforo gateway plugin.
- **Quota enforcement.** This SDK records usage; it does not block the agent when a limit is hit. Pre-flight quota gating lives in the MCP proxy (`@aforoai/mcp-proxy --quota-enforcement`), not here.
- **Rate-plan / metric setup.** Creating the AI_AGENT product, its metrics, and its rate plan is done in the Aforo console, not in this SDK.
