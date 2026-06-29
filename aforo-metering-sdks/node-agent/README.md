# @aforoai/agent-metering

Instrument an AI agent's runtime lifecycle — start session, record reasoning steps and tool calls, end session — and have Aforo bill and analyze the run. Sits one layer above the generic `@aforo/metering` client: events are POSTed directly with no peer dependency, buffered, batched, and flushed on a size/time threshold.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i @aforoai/agent-metering
```

> **Not yet on the public npm registry.** Until it's published, install from source:
> ```bash
> git clone https://github.com/aforoai/aforo-metering-sdks.git
> cd aforo-metering-sdks/node-agent
> npm install && npm run build
> npm pack        # produces aforoai-agent-metering-1.0.0.tgz
> # then in your agent project: npm i /path/to/aforoai-agent-metering-1.0.0.tgz
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
| `apiKey` | `string` | — (required) | Sent as `Authorization: Bearer <apiKey>`. Use `process.env.AFORO_API_KEY`. |
| `ingestorUrl` | `string` | `https://usage-ingestor.aforo.ai/v1/ingest` | Full ingest URL. Override for local dev or air-gapped deployments. |
| `flushBatchSize` | `number` | `50` | Buffer this many events before forcing a flush. Lower it for low-volume agents to surface metrics sooner; raise it to amortize per-batch HTTP cost. |
| `flushIntervalMs` | `number` | `5000` | Max time an event sits in the buffer before a timed flush. `session.end()` flushes regardless. |
| `fetchImpl` | `typeof fetch` | global `fetch` | Pluggable transport. Required on Node < 18 where there's no global `fetch`; also the seam used in tests. |

### Per-session and per-step options

`startSession({...})` — `agentId` (required), optional `sessionId` (a UUID is generated if omitted), `framework` (`CLAUDE` \| `GPT` \| `LANGCHAIN` \| `CREWAI` \| `AUTOGEN` \| `CUSTOM`), `modelProvider` (`ANTHROPIC` \| `OPENAI` \| `GOOGLE` \| `COHERE` \| `CUSTOM`), `modelName`, and free-form `metadata`.

`recordStep({...})` — `stepKind` (`TOOL_CALL` \| `THOUGHT` \| `OBSERVATION` \| `FINAL_ANSWER`, required), optional `capabilityName`, `inputTokens`, `outputTokens`, `durationMs`, `executionStatus` (`SUCCESS` \| `ERROR` \| `TIMEOUT` \| `CANCELLED` \| `HITL_REQUIRED`, defaults `SUCCESS`), and `metadata`. `session.recordToolCall(toolName, opts)` is the shortcut for the common `TOOL_CALL` case.

`end({...})` — `taskCompleted` (required), optional `errorMessage` and `metadata`.

## Walk me through it

Step-by-step from install to a verified event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

Delivery is **best-effort**. On an HTTP failure `flush()` logs a warning and **drops** the batch — there's no on-disk queue or dead-letter. That's the same posture as the generic and MCP SDKs: direct SDK emit is for first-party customers running their own agents. For billing where a dropped event is unacceptable, meter through a gateway plugin instead. This SDK also does not enforce quotas — it records usage, it doesn't gate the agent on a limit.
