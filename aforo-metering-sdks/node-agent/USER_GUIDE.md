# @aforoai/agent-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** engineers instrumenting an AI agent (Claude, GPT, LangChain, CrewAI, AutoGen, or a custom loop) for Aforo billing.

## What you'll build

An agent run that opens an Aforo session, records each step, tool call and token count, and closes the session, with the events landing in Aforo. By the end you'll have seen the exact requests the SDK sends.

## Prerequisites

- Node >= 18 (built-in `fetch`). On Node < 18, pass `fetchImpl`.
- An Aforo workspace **API key** and the **customer id** to bill (from the Aforo console).
- An AI_AGENT product whose catalog has the default agent metrics (`Agent Sessions`, `Agent Steps`, `Agent Tool Calls`, `Tokens Consumed`, ...). If your metrics are named differently, set `metricNames`.

## Step 1 — Install

```bash
npm i @aforoai/agent-metering
```

If `2.0.0` is not on npm yet: `git clone https://github.com/aforoai/SDKs.git`, then in `SDKs/aforo-metering-sdks/node-agent` run `npm install && npm run build && npm pack`, and `npm i` the `.tgz` in your project.

## Step 2 — Create one client per process

```ts
import { AforoAgent } from '@aforoai/agent-metering';

const agent = new AforoAgent({
  apiKey: process.env.AFORO_API_KEY!,
  customerId: 'cust_acme_001',
  agentId: 'research-agent',     // <= 36 chars
  // endpoint: 'http://localhost:8084', // local dev; default https://api.aforo.ai/v1/ingest/batch
  onError: (err) => console.error(`[aforo] ${err.kind}: ${err.message}`),
});
```

Only `apiKey` is checked when the client is built. A session without a `customerId` or `agentId` does not throw: its events are reported to `onError` as `invalid` and never sent.

## Step 3 — One session per agent run

```ts
const session = agent.startSession({
  framework: 'CLAUDE',
  modelProvider: 'ANTHROPIC',
  modelName: 'claude-sonnet-4-6',
  // customerId / agentId / subscriptionId / sessionId / traceId can be set per session
});
```

The session gets a UUID `sessionId` and a 32-hex `traceId`. Every event it emits carries both, plus the idempotency key `<sessionId>:<n>`.

## Step 4 — Record what the agent does

```ts
await session.recordStep({ stepKind: 'THOUGHT' });                       // Agent Steps
await session.recordToolCall('web_search', { durationMs: 510 });         // Agent Steps + Agent Tool Calls
await session.recordTokens('claude-sonnet-4-6', 320, 84);                // Tokens Consumed = 404
await session.recordUsage('knowledgeQueries', 1);                        // Knowledge Queries
await session.recordToolCall('db_query', { executionStatus: 'ERROR' });  // outcome-based pricing weight
```

A step can carry its tokens directly: `recordStep({ stepKind: 'TOOL_CALL', capabilityName: 'web_search', inputTokens: 320, outputTokens: 84 })` emits Agent Steps, Agent Tool Calls and Tokens Consumed. Zero quantities are skipped.

## Step 5 — End the session

```ts
await session.endSession({ taskCompleted: true });
// or, on failure:
await session.endSession({ taskCompleted: false, errorMessage: 'tool budget exhausted' });
```

This emits `Tasks Completed` (when `taskCompleted` is true), `Execution Minutes` (when you pass `executionMinutes`), then `Agent Sessions` with `sessionBoundary: "SESSION_END"`, and flushes. Before the process exits, call `await agent.shutdown()`.

## Step 6 — See the requests

Point the client at a local catcher:

```bash
node -e "require('http').createServer((q,r)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{console.log(q.method,q.url,q.headers['x-api-key']?'(X-API-Key set)':'(no key)',b);r.writeHead(202,{'content-type':'application/json'}).end(JSON.stringify({success:true,data:{accepted:JSON.parse(b).events.length,duplicates:0,failed:0,errors:[]}}))})}).listen(8084)"
```

With `endpoint: 'http://localhost:8084'`, the catcher prints one `POST /v1/ingest/batch` with body `{"events":[...]}`. Each event has `customerId`, `metricName`, `quantity`, `occurredAt`, `idempotencyKey`, `productType: "AI_AGENT"`, `agentId`, `sessionId` and `traceId`. Then remove the `endpoint` override and check the usage in the Aforo console.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `invalid: ... customerId is required` | No `customerId` on the client or the session | Set one. |
| `invalid: ... agentId is required for AI_AGENT events` | No `agentId` | Set `agentId` on the client or the session (at most 36 chars). |
| `retrying: ... HTTP 401` and a log line saying the API key is wrong or revoked | Wrong or revoked API key, or it was sent as a Bearer token by other code | Use a workspace API key; the SDK sends it as `X-API-Key`. The queued usage is sent once the key works. |
| `rejected: Aforo ingestor rejected N event(s): #i: ...` | The ingestor refused some events (unknown customer, metric not in the catalog, timestamp out of range) | `err.events` lists them; check the customer id and `metricNames`. |
| `retrying: ...` repeatedly | Ingestor unreachable, or 429 / 5xx | The events stay queued (up to `maxBufferSize`) and are re-sent with backoff. Check the network path to `endpoint`. |
| `shutdown: ... still queued when the ... shutdown deadline passed` | `shutdown()` ran out of time during an outage | Raise `shutdownTimeoutMs`, or fix the network path before stopping. |
| Process exits, nothing arrives | It exited before a flush | `await session.endSession(...)` and `await agent.shutdown()` before exit. |
