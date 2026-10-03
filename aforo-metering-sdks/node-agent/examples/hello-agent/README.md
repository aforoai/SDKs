# hello-agent — Node.js example for `@aforoai/agent-metering`

Runnable smoke that opens an AI_AGENT session and records **10 capability
invocations** using the 5 canonical capabilities from
[`agent-samples/manifests/research-agent.yaml`](../../../agent-samples/manifests/research-agent.yaml).

## Run

```bash
cd examples/hello-agent
cp .env.example .env    # then edit — set AFORO_TENANT_ID, AFORO_PRODUCT_ID, AFORO_API_KEY, AFORO_CUSTOMER_ID
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

Each recordStep passes `capabilityName` — the SDK stamps this at the
event's top level AND in `metadata.capability_name` so usage-ingestor's
`ProductTypeEventExtractor.extractAiAgentFields` bridges it to
`event.toolName` for per-capability billing.

## Expected event count

The SDK emits one event per `recordStep` call as `agent_step`, plus a
second `token_usage` event whenever `inputTokens + outputTokens > 0`.
The invocation plan sets non-zero tokens on every step, so per run:

- **1** `agent_session_start`
- **10** `agent_step` (one per capability invocation)
- **10** `token_usage` (one per step — matches token-based analytics)
- **1** `agent_session_end`

**Total: 22 events** into usage-ingestor per run.

Downstream:
- `usage_events` (usage-ingestor Postgres): **22 rows** (one per emitted event).
- `ai_agent_invocations` (analytics-service ClickHouse via
  `AiAgentEventConsumer` — sibling of the MCP consumer, populated
  by the `agent_step` events with a `capability_name` metadata field):
  **10 rows**, one per invocation.

## Verify

```sql
-- usage-ingestor Postgres
SELECT event_type, count(*)
FROM usage_events
WHERE tenant_id = '<AFORO_TENANT_ID>'
  AND event_time > now() - interval '1 minute'
GROUP BY 1;
-- expected:
-- agent_session_start | 1
-- agent_step          | 10
-- token_usage         | 10
-- agent_session_end   | 1

-- analytics-service ClickHouse
SELECT capability_name, count(*)
FROM ai_agent_invocations
WHERE tenant_id = '<AFORO_TENANT_ID>'
  AND event_time > now() - INTERVAL 1 MINUTE
GROUP BY 1
ORDER BY 1;
-- expected: 5 rows keyed by capability name, counts matching the plan.
```

## Idempotency

Each event carries an `idempotencyKey` stamped by the SDK at creation
time (see `node-agent/src/index.ts` `genKey()`). Re-running this example
against the same target with the same env produces a fresh set of keys —
the ingestor won't dedup them, so **each run generates 22 new events**.
The idempotency key exists so a SDK-side retry after a drop is
dedup-safe against a partially-delivered batch; it isn't a run
deduplicator.

## Fatal errors

- `[hello-agent] missing required env vars: ...` — copy `.env.example`
  to `.env` and set the three required vars.
- `[hello-agent] fatal: ...` — the SDK constructor failed. Likely
  cause: missing tenant/product/API key.
- `[hello-agent] dropped N event(s) — ...` — the ingestor rejected or
  timed out on N events. Check the target URL, API key, and
  usage-ingestor health.
