# hello-agent — Node.js example for `@aforoai/agent-metering`

Runnable smoke that opens an AI_AGENT session and records **10 capability
invocations** using the 5 canonical capabilities from
[`agent-samples/manifests/research-agent.yaml`](../../../agent-samples/manifests/research-agent.yaml).

## Run

```bash
cd examples/hello-agent
cp .env.example .env    # then edit — set AFORO_API_KEY and AFORO_CUSTOMER_ID
npm install
node index.js
```

`AFORO_INGEST_URL` defaults to `http://localhost:8084`. Set it to
`https://api.aforo.ai` for production (see `.env.example`).

## What it does

Emits one AI_AGENT session against Aforo's usage-ingestor:

1. `AforoAgent` construction with env-driven config
2. `startSession()` → session id printed to stderr
3. Ten `session.recordStep()` calls across the 5 capabilities:
   - `summarize_url` × 3
   - `extract_entities` × 2
   - `verify_claim` × 2 (one flagged as `HITL_REQUIRED`)
   - `rank_sources` × 2
   - `answer_question` × 1
4. `session.end({taskCompleted: true})` with final flush

Each step is recorded with `stepKind: 'TOOL_CALL'` and a `capabilityName`,
which the SDK sends as the event's top-level `capabilityName`.

## Expected event count

All events go to `POST /v1/ingest/batch`. Per run:

- **10** `Agent Steps` (one per step)
- **10** `Agent Tool Calls` (every step is a TOOL_CALL)
- **10** `Tokens Consumed` (input + output tokens of each step)
- **1** `Tasks Completed`
- **1** `Agent Sessions` (carries `sessionBoundary: SESSION_END`)

**Total: 32 events** per run.

## Idempotency

Each event's `idempotencyKey` is `<sessionId>:<n>` (n counts up within the
session). The session id is a fresh UUID per run, so every run produces 32
new events; a retried batch re-sends the same keys and is deduplicated.

## Fatal errors

- `[hello-agent] missing required env vars: ...` — copy `.env.example`
  to `.env` and set the required vars.
- `[hello-agent] fatal: ...` — the SDK constructor failed. Likely
  cause: missing API key.
- `[hello-agent] retrying: ...` — the ingestor was unreachable or returned
  429/5xx; the events stay buffered and are re-sent on the next flush.
- `[hello-agent] rejected|partial|invalid: ...` — events were refused
  (bad API key, unknown customer, bad field). The message says why.
