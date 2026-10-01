# hello_agent — Python example for `aforo-agent-metering`

Runnable smoke that opens an AI_AGENT session and records **10 capability
invocations** using the 5 canonical capabilities from
[`agent-samples/manifests/research-agent.yaml`](../../../agent-samples/manifests/research-agent.yaml).
Sibling of [`node-agent/examples/hello-agent`](../../../node-agent/examples/hello-agent) — same plan, same event
shape, different language.

## Run

```bash
cd examples/hello_agent
cp .env.example .env    # then edit — set AFORO_TENANT_ID, AFORO_PRODUCT_ID, AFORO_API_KEY
pip install -r requirements.txt
python main.py
```

`AFORO_INGEST_URL` defaults to `https://api.aforo.ai`. Set it to
`http://localhost:8084` to target a usage-ingestor on your machine (see
`.env.example`). The API key is sent as `X-API-Key`.

## What it does

Emits one AI_AGENT session against Aforo's usage-ingestor:

1. `AforoAgentClient` construction with env-driven config
2. `client.start()` kicks off the periodic-flush background task
3. Session id is caller-managed — the example mints
   `sess_<hex>` and passes it on every `record_capability` call so all
   10 invocations correlate as one session downstream
4. Ten `client.record_capability()` calls across the 5 capabilities:
   - `summarize_url` × 3
   - `extract_entities` × 2
   - `verify_claim` × 2 (one flagged as `HITL_REQUIRED`)
   - `rank_sources` × 2
   - `answer_question` × 1
5. `client.shutdown()` stops the periodic flush and forces a final drain

The Python SDK's `record_capability` writes events with
`metric_name = 'ai_agent.capability_invocations'` and stamps
`capability_name` in metadata (snake_case). usage-ingestor's
`ProductTypeEventExtractor.extractAiAgentFields` bridges that to
`event.toolName` for per-capability billing (dimensionPricing).

## Expected event count

The Python SDK's `record_capability` emits **one** event per call — no
sibling `token_usage` event (unlike the Node SDK which emits both).
So per run:

- **10** `ai_agent.capability_invocations` events (one per invocation)

**Total: 10 events** into usage-ingestor per run.

Downstream:
- `usage_events` (usage-ingestor Postgres): **10 rows** (one per
  emitted event).
- `ai_agent_invocations` (analytics-service ClickHouse via
  `AiAgentEventConsumer`): **10 rows**, one per invocation, each
  keyed by `capability_name`.

Different from the Node example (which emits 22 events — 1 session_start
+ 10 agent_step + 10 token_usage + 1 session_end) because the two SDKs
have different event granularity. Both surfaces produce the same 10
`ai_agent_invocations` rows in ClickHouse.

## Verify

```sql
-- usage-ingestor Postgres
SELECT metric_name, count(*)
FROM usage_events
WHERE tenant_id = '<AFORO_TENANT_ID>'
  AND session_id = '<session id printed by the run>'
GROUP BY 1;
-- expected:
-- ai_agent.capability_invocations | 10

-- analytics-service ClickHouse
SELECT capability_name, count(*)
FROM ai_agent_invocations
WHERE tenant_id = '<AFORO_TENANT_ID>'
  AND session_id = '<session id printed by the run>'
GROUP BY 1
ORDER BY 1;
-- expected: 5 rows keyed by capability_name, counts matching the plan:
--   answer_question   | 1
--   extract_entities  | 2
--   rank_sources      | 2
--   summarize_url     | 3
--   verify_claim      | 2
```

## Idempotency

Each event carries an `idempotencyKey` stamped by the SDK at creation:
`agent:{uuid4()}` — see `python-agent/aforo_agent_metering/client.py`
`_build_event`. Re-running produces fresh keys — the ingestor won't
dedup them, so **each run generates 10 new events**. The idempotency
key exists so a SDK-side retry after a drop is dedup-safe against a
partially-delivered batch; it isn't a run deduplicator.

## Fatal errors

- `[hello_agent] missing required env vars: ...` — copy `.env.example`
  to `.env` and set the three required vars.
- `[hello_agent] dropped N event(s) — reason` — the ingestor rejected
  or timed out on N events. Check the target URL, API key, and
  usage-ingestor health. Reasons: `rejected` (non-retryable 4xx, or
  events the ingestor rejected individually in a 202), `retry_exhausted`
  (5xx / 408 / 429 / network — after 3 attempts), `invalid` (the SDK
  refused the event before sending: blank or over-limit field).
