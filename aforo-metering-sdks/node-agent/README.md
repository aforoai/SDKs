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
| `flushIntervalMs` | `5000` | Max time an event waits before a timed flush. |
| `maxBatchSize` | `100` | Events per request (max 1000). A full batch triggers a flush. |
| `maxBufferSize` | `10000` | Max events held in memory, including ones kept after a failed flush. |
| `maxRetries` | `3` | Attempts per request on 408 / 429 / 5xx / network errors. |
| `retryBaseDelayMs` | `500` | Backoff base, doubled per attempt; a 429's `Retry-After` wins. |
| `requestTimeoutMs` | `10000` | Per-request timeout. |
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

`record*` calls never throw and never wait for the network. `flush()`, `endSession()` and `shutdown()` resolve to `{ accepted, duplicates, failed, pending }`.

| `err.kind` | When | Events |
|---|---|---|
| `retrying` | Every attempt failed with a network error, 408, 429 or 5xx | **Kept** in the buffer and re-sent on the next flush (`err.willRetry === true`) |
| `partial` | HTTP 202, but the response reported `data.failed > 0` | The failed ones (`err.errors[]` has index, message, idempotencyKey) are dropped; the rest were accepted |
| `rejected` | Any other 4xx (e.g. 401 bad API key, 400) | Dropped |
| `invalid` | Missing `customerId` / `agentId`, quantity < 0, field too long | Never sent |
| `overflow` | Buffer above `maxBufferSize` | Oldest dropped |

`agent.droppedCount` and `agent.pendingCount` expose the totals. Events held in memory are lost if the process dies before they are sent. Call `await agent.shutdown()` before exiting.

## Upgrading from 1.x

1.x options still work but are deprecated: `tenantId` (ignored; the API key identifies the tenant), `ingestorUrl` (use `endpoint`), `flushBatchSize` (use `maxBatchSize`), `onDrop` (use `onError`). `session.end()` is still there (`endSession()` is an alias). `startSession()` now returns the session directly; `await agent.startSession(...)` still works. The emitted metric names changed to the catalog names above. If your product's metrics are named `step_count` / `tokens_total` / etc., set `metricNames`. See the [changelog](CHANGELOG.md).
