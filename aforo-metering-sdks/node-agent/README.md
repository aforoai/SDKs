# @aforoai/agent-metering

Instrument an AI agent's runtime lifecycle — start session, record reasoning steps and tool calls, end session — and have Aforo bill and analyze the run. Events are POSTed directly (no peer dependency on `@aforoai/metering`), buffered, and flushed on a size/time threshold.

**Version:** 1.2.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i @aforoai/agent-metering
```

> **Install `1.2.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `1.2.0` is not on npm yet, install from source:
> ```bash
> git clone https://github.com/aforoai/SDKs.git
> cd SDKs/aforo-metering-sdks/node-agent
> npm install && npm run build
> npm pack        # produces aforoai-agent-metering-1.2.0.tgz
> # then in your agent project: npm i /path/to/aforoai-agent-metering-1.2.0.tgz
> ```

Requires Node >= 18 (uses the built-in `fetch`). On Node < 18, pass your own `fetchImpl` in the config.

## Quickstart

The smallest run that lands events in Aforo: open a session, record one step, end it.

```ts
import { AforoAgent } from '@aforoai/agent-metering';

const agent = new AforoAgent({
  tenantId: 'tenant_smartai',
  productId: 'prod_agent_001',
  apiKey: process.env.AFORO_API_KEY!,
  customerId: 'cust_acme_001', // the customer this agent's usage is billed to
  productType: 'AI_AGENT',      // default
});

const session = await agent.startSession({
  agentId: 'agt_001',
  framework: 'CLAUDE',
  modelProvider: 'ANTHROPIC',
  modelName: 'claude-sonnet-4-6',
});

await session.recordStep({
  stepKind: 'TOOL_CALL',
  capabilityName: 'web-search',
  inputTokens: 320,
  outputTokens: 84,
  durationMs: 510,
  executionStatus: 'SUCCESS',
});

await session.end({ taskCompleted: true });
```

`session.end()` forces a final flush, so the events are delivered before your agent process exits. If your agent runs many sessions in one long-lived process, you don't need to do anything else — the buffer flushes on the size/time threshold between sessions too.

> ⚠ A single step with `inputTokens` or `outputTokens` emits **two** events: an `agent_step` (counts toward `step_count`) and a `token_usage` (counts toward `tokens_total`). That's intentional — billing on steps and billing on tokens are separate metrics. Don't double-count them yourself.

## Configuration

Pass these to `new AforoAgent({...})`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant scope. Stamped on every event and sent as `X-Tenant-Id`. Never read from a client header. |
| `productId` | `string` | — (required) | The AI_AGENT product these events bill against. |
| `apiKey` | `string` | — (required) | Sent as `X-API-Key: <apiKey>`. Use `process.env.AFORO_API_KEY`. |
| `customerId` | `string` | — | Aforo customer the usage is billed to, sent top-level on every event. Set it here, per session via `startSession({ customerId })`, or per event. Events without one are dropped as `invalid`. |
| `productType` | `string` | `AI_AGENT` | `productType` on every event. Override per session with `startSession({ productType })` or per event with `emitEvent({ productType })`. Trimmed and uppercased. The `/v1/ingest/events` endpoint derives the product type from the event type (`agent_*` and `token_usage` are AI_AGENT). |
| `ingestorUrl` | `string` | `https://api.aforo.ai/v1/ingest` | Ingest base URL. Each event is POSTed to `<ingestorUrl>/events`. A bare host gets `/v1/ingest` added; a URL ending in `/events` or `/batch` is accepted. |
| `flushBatchSize` | `number` | `50` | Buffer this many events before forcing a flush. Lower it for low-volume agents to surface metrics sooner. |
| `flushIntervalMs` | `number` | `5000` | Max time an event sits in the buffer before a timed flush. `session.end()` flushes regardless. |
| `maxRetries` | `number` | `3` | Attempts per event for 408/429/5xx/network failures. Other 4xx are not retried. |
| `retryBaseDelayMs` | `number` | `1000` | Base backoff between attempts (doubles each time); a 429's `Retry-After` wins. |
| `onDrop` | `(events, reason) => void` | unset | Called with events the SDK is about to lose. `reason` is `retry_exhausted`, `rejected` or `invalid`. See [Dropped events](#dropped-events). |
| `fetchImpl` | `typeof fetch` | global `fetch` | Pluggable transport. Required on Node < 18 where there's no global `fetch`; also the seam used in tests. |

### Per-session and per-step options

`startSession({...})` — `agentId` (required, at most 36 characters), optional `customerId` (overrides the client's), `productType` (overrides the client's), `sessionId` (generated if omitted, at most 64 characters), `traceId`, `framework` (`CLAUDE` \| `GPT` \| `LANGCHAIN` \| `CREWAI` \| `AUTOGEN` \| `CUSTOM`), `modelProvider` (`ANTHROPIC` \| `OPENAI` \| `GOOGLE` \| `COHERE` \| `CUSTOM`), `modelName`, and free-form `metadata`.

`recordStep({...})` — `stepKind` (`TOOL_CALL` \| `THOUGHT` \| `OBSERVATION` \| `FINAL_ANSWER`, required), optional `capabilityName`, `inputTokens`, `outputTokens`, `durationMs`, `executionStatus` (defaults `SUCCESS`; see below), `parentStepId`, and `metadata`. `session.recordToolCall(toolName, opts)` is the shortcut for the common `TOOL_CALL` case.

`end({...})` — `taskCompleted` (required), optional `errorMessage` and `metadata`.

### Execution status

`executionStatus` feeds outcome-based pricing: an OUTCOME_BASED rate plan bills each step at the weight set for its status. Accepted values (exported as `EXECUTION_STATUSES`, type `ExecutionStatus`): `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. The value is trimmed and upper-cased; missing or blank is `SUCCESS`. Any other value is WARN-logged and left off the event, which is still sent and bills at full weight. A `metadata.executionStatus` cannot override the step's status.

### Dropped events

Every event the SDK loses is counted in `agent.droppedCount`, WARN-logged, and passed to the opt-in `onDrop(events, reason)` hook. Events keep their idempotency keys (stamped once, when the event is created), so re-submitting them is dedup-safe.

| `reason` | When |
|---|---|
| `retry_exhausted` | Every send attempt failed (network error, 5xx, 408, 429). |
| `rejected` | The ingestor returned a non-retryable 4xx. The WARN carries the server's message. |
| `invalid` | The event failed a client-side check and was never sent. |

`invalid` covers: no `customerId`; blank `metricKey`, `agentId` or `sessionId`; `value` not > 0; `customerId` over 64 characters, `agentId` over 36, `sessionId` over 64, `capabilityName` over 64, `metricKey` over 255, `productType` over 20. `startSession()` and `emitEvent()` do not throw for these, and nothing is truncated. The WARN is logged for the first invalid event and then every 1000th.

## Walk me through it

Step-by-step from install to a verified event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

Delivery is **best-effort**. 408/429/5xx/network failures are retried (`maxRetries`, default 3; `Retry-After` honoured); after that, or on any other 4xx, the event is dropped and reported (see [Dropped events](#dropped-events)) — there is no on-disk queue. For billing where a dropped event is unacceptable, persist events from `onDrop`, or meter through a gateway plugin instead. This SDK also does not enforce quotas — it records usage, it doesn't gate the agent on a limit.
