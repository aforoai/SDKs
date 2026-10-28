# @aforoai/agent-metering

Meter an AI agent's runs in Aforo: open a session, record steps, tool calls and tokens, end the session. Events are buffered and sent in batches to the Aforo usage ingestor (`POST https://api.aforo.ai/v1/ingest/batch`, header `X-API-Key`). No runtime dependencies.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i @aforoai/agent-metering
```

If `2.0.0` is not on npm yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/node-agent
npm install && npm run build && npm pack   # aforoai-agent-metering-2.0.0.tgz
```

Requires Node >= 18 (built-in `fetch`). On older Node, pass `fetchImpl`.

## Quickstart

```ts
import { AforoAgent } from '@aforoai/agent-metering';

const agent = new AforoAgent({
  apiKey: process.env.AFORO_API_KEY!, // workspace API key
  customerId: 'cust_123',             // Aforo customer billed for the usage
  agentId: 'support-bot',             // <= 36 chars
  productId: 'prod_abc',              // optional, sent as metadata.productId
  onError: (err) => console.error(`[aforo] ${err.kind}: ${err.message}`),
});

const session = agent.startSession({
  framework: 'CLAUDE',
  modelProvider: 'ANTHROPIC',
  modelName: 'claude-sonnet-4-6',
});

try {
  await session.recordStep({ stepKind: 'THOUGHT' });
  await session.recordToolCall('web_search', { durationMs: 510, executionStatus: 'SUCCESS' });
  await session.recordTokens('claude-sonnet-4-6', 320, 84);
  await session.endSession({ taskCompleted: true });   // flushes
} catch (e) {
  await session.endSession({ taskCompleted: false, errorMessage: String(e) });
  throw e;
}

await agent.shutdown(); // before the process exits
```

## What gets sent

| Call | Metric (default name) | Quantity |
|---|---|---|
| `recordStep(opts)` | `Agent Steps` | 1 |
| `recordStep({ stepKind: 'TOOL_CALL' })` / `recordToolCall(name, opts)` | `Agent Steps` + `Agent Tool Calls` | 1 each |
| `recordTokens(model, input, output)`, or a step with `inputTokens`/`outputTokens` | `Tokens Consumed` | input + output |
| `recordUsage('knowledgeQueries' \| 'gpuHours' \| 'executionMinutes' \| 'activeAgents' \| '<catalog name>', qty)` | that metric | `qty` |
| `endSession({ taskCompleted: true })` | `Tasks Completed` | 1 |
| `endSession({ executionMinutes })` | `Execution Minutes` | the value |
| `endSession()` (always, last) | `Agent Sessions`, with `sessionBoundary: "SESSION_END"` | 1 |

Zero quantities are skipped (never sent). Each event looks like this:

```json
{
  "customerId": "cust_123", "metricName": "Tokens Consumed", "quantity": 404,
  "occurredAt": "2026-10-21T10:00:00.000Z", "idempotencyKey": "<sessionId>:3",
  "productType": "AI_AGENT", "agentId": "support-bot", "sessionId": "<uuid>",
  "traceId": "<32 hex>", "subscriptionId": "sub_1",
  "metadata": { "model_provider": "ANTHROPIC", "model_name": "claude-sonnet-4-6",
                "input_tokens": 320, "output_tokens": 84, "productId": "prod_abc" }
}
```

Tool-call and step events also carry `capabilityName`, `executionStatus`, `executionDurationMs` and `stepNumber`.

**Idempotency keys** are deterministic: `<sessionId>:<n>`, where `n` counts the session's events. A retried batch re-sends the same keys, so the ingestor deduplicates it. The generated `sessionId` is a UUID; if you pass your own, it must be unique per run, or a later run's events are treated as duplicates. Each session gets one `traceId` (32 hex chars, generated unless you pass one).

## Configuration

| Option | Default | |
|---|---|---|
| `apiKey` | required | Workspace API key, sent as `X-API-Key` (never `Authorization: Bearer`). |
| `customerId` | — | Customer billed. Required here or per session (`startSession({ customerId })`). |
| `agentId` | — | Required here or per session. At most 36 chars. |
| `subscriptionId` | — | Optional; per session too. |
| `productId` | — | Optional; sent as `metadata.productId`. |
| `endpoint` | `https://api.aforo.ai/v1/ingest/batch` | A bare host gets `/v1/ingest/batch`; `…/v1/ingest` gets `/batch`. |
| `metricNames` | see below | Override any catalog metric name. |
| `flushIntervalMs` | `5000` | Max time an event waits before a timed send. |
| `maxBatchSize` | `500` | Events per request (max 1000). A full batch wakes the sender. |
| `maxBufferSize` | `10000` | Max events held in memory, including ones kept during an outage. Past it the oldest is dropped (`overflow`). |
| `maxRetries` | `4` | Attempts per request on 408 / 429 / 5xx / network errors / timeouts, with full-jitter backoff. `Retry-After` (seconds or HTTP-date) is honoured, capped at 60 s. |
| `retryBaseDelayMs` | `500` | Backoff base, doubled per attempt (random delay up to that ceiling, at most 30 s). |
| `requestTimeoutMs` | `10000` | Total deadline per request. |
| `shutdownTimeoutMs` | `5000` | How long `shutdown()` keeps sending. What is still queued then is dropped as `shutdown`. |
| `flushOnExit` | `true` | Send what is queued on the process `beforeExit` event, within `shutdownTimeoutMs`. |
| `allowInsecureHttp` | `false` | Allow a plain `http://` endpoint on a host other than localhost / 127.0.0.1 / ::1. Otherwise the endpoint must be `https://`. |
| `onError` | — | `(err: AforoAgentError) => void`. Called for every delivery problem. |
| `logger` | `console` | Used for warnings when `onError` is unset. `null` silences. |
| `fetchImpl` | global `fetch` | Custom transport (tests, Node < 18). |

`metricNames` defaults (the default AI_AGENT catalog metrics):

```ts
{ sessions: 'Agent Sessions', steps: 'Agent Steps', toolCalls: 'Agent Tool Calls',
  tokens: 'Tokens Consumed', executionMinutes: 'Execution Minutes', gpuHours: 'GPU Hours',
  knowledgeQueries: 'Knowledge Queries', tasksCompleted: 'Tasks Completed', activeAgents: 'Active Agents' }
```

### Execution status

`executionStatus` accepts `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED` (exported as `EXECUTION_STATUSES`). The value is trimmed and upper-cased; missing means `SUCCESS`; anything else is left off the event, with a warning.

## Delivery and errors

`record*` calls never throw and never wait for the network: they put the event on a bounded queue, and one background sender posts batches (never two requests at once). `flush()`, `endSession()` and `shutdown()` resolve to `{ accepted, failed, requeued, pending }`.

| `err.kind` | When | Events |
|---|---|---|
| `retrying` | Every attempt failed with a network error, timeout, 401, 403, 408, 429 or 5xx | **Kept** on the queue with their idempotency keys; the sender pauses (5 s, doubling with jitter up to 5 min) and re-sends them. `err.events` is empty, `err.willRetry === true`. |
| `rejected` | Another 4xx for the whole batch (400, 422), or per-event errors in a 2xx answer | Dropped; `err.events` lists them. Per-event errors marked `retryable` are re-sent instead. |
| `invalid` | Missing `customerId` / `agentId`, quantity ≤ 0, field too long | Never sent |
| `overflow` | Queue above `maxBufferSize` | Oldest dropped |
| `shutdown` | Still queued when `shutdown()` hit `shutdownTimeoutMs` | Dropped |
| `closed` | Recorded after `shutdown()` | Dropped |

A 401 or 403 is treated as an outage, not a rejection: a wrong or revoked key is logged once per outage, and the usage is sent once a valid key is in place. `agent.droppedCount` and `agent.pendingCount` expose the totals. Events held in memory are lost if the process dies before they are sent. The SDK installs no signal handlers; call `await agent.shutdown()` from yours:

```ts
process.once('SIGTERM', async () => { await agent.shutdown(); process.exit(0); });
```

## Upgrading from 2.x

`FlushResult` is `{ accepted, failed, requeued, pending }` (no `duplicates`; duplicates count as accepted). `err.kind` `partial` is gone: per-event rejections are `rejected` with the dropped events in `err.events`; `AforoAgentError` has no `status` or `errors` fields. 401 / 403 are retried as an outage instead of dropped. `maxRetries` now defaults to 4 attempts and `maxBatchSize` to 500. A plain `http://` endpoint needs `allowInsecureHttp: true` unless it is localhost.

## Upgrading from 1.x

1.x options still work but are deprecated: `tenantId` (ignored; the API key identifies the tenant), `ingestorUrl` (use `endpoint`), `flushBatchSize` (use `maxBatchSize`), `onDrop` (use `onError`). `session.end()` is still there (`endSession()` is an alias). `startSession()` now returns the session directly; `await agent.startSession(...)` still works. The emitted metric names changed to the catalog names above. If your product's metrics are named `step_count` / `tokens_total` / etc., set `metricNames`. See the [changelog](CHANGELOG.md).
