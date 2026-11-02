# Aforo AI_AGENT — Reference Sample Manifests

Three ready-to-use `agent.yaml` manifests for validating the AI_AGENT product-category end-to-end pipeline. Each manifest is a valid input to catalog-service's `GitRepositoryDiscoveryAdapter` — copy these to a public Git repo, point an AI_AGENT product at the raw URL, and the discovery flow will parse + validate + populate `capability_registry` in one call.

## Manifests

| File | Domain | Capabilities | Model provider | Notes |
|---|---|---|---|---|
| `manifests/research-agent.yaml` | Knowledge / research | 5 (summarize_url, extract_entities, verify_claim, rank_sources, answer_question) | ANTHROPIC | Full-featured — runtime + session + governance blocks populated; 2 PREMIUM capabilities. Best for exercising per-capability multiplier pricing. |
| `manifests/support-agent.yaml` | Customer support triage | 3 (classify_intent, draft_response, escalate_ticket) | CUSTOM (default) | Minimal shape — only required fields populated. Best for exercising the "fresh product with sparse manifest" empty-state path. |
| `manifests/coding-agent.yaml` | Developer productivity | 4 (read_file, write_file, run_tests, explain_diff) | OPENAI | Has governance.hitl_required_for + audit_all_writes. Best for exercising human-in-the-loop and audit-log downstreams. |

All three pass the `AgentManifestValidator` spec verified from source at `aforo-nextgen-catalog-service/src/main/java/com/aforo/billing/catalog/discovery/AgentManifestValidator.java`:

- `name` non-blank, ≤128 chars
- `description` non-blank, ≤2000 chars
- `capabilities[]` present (list, may be empty)
- per-capability `name` matches regex `^[A-Za-z0-9_\-.]{1,128}$`, unique within the manifest
- `input_schema` when present is an object (never a list/string)
- `modelProvider` when present is one of `ANTHROPIC`, `OPENAI`, `GOOGLE`, `COHERE`, `CUSTOM` (unknown → soft warning + treated as CUSTOM)

Optional fields carried through to `capability_registry` JSONB: `overview`, `version`, `tags`, `defaultModel`, `runtime`, `session`, `governance`, per-capability `costTier` + `rateLimit`. The validator is intentionally tolerant of extra fields (see `@JsonIgnoreProperties(ignoreUnknown = true)` on `AgentManifest.java`).

## Fastest way to validate discovery — 4 steps

1. Create a public GitHub / GitLab / Bitbucket repo (any of the four hosts supported by `GitRepositoryDiscoveryAdapter.rawUrl()`). Suggested name: `aforo-agent-samples`.
2. Commit these three files at the repo root, so the raw URLs become e.g. `https://raw.githubusercontent.com/<org>/aforo-agent-samples/main/manifests/research-agent.yaml`.
3. In the Aforo Product UI, create a new AI_AGENT product and use the "Pull from Repository" card. Paste the raw manifest URL. Expected: within 20s the wizard shows `capabilityCount: 5` (or 3 / 4 respectively), the branch, the manifest path, and any soft warnings.
4. Click **Import** → the product is created with `capabilitySource: AUTO_DISCOVERED` and `capabilityRegistry` populated.

Post-import checks (open the product's detail drawer):

- Capabilities tab lists all 5/3/4 capability cards.
- Source Repository row shows the URL + last-synced timestamp.
- "Sync now" button triggers `PATCH /api/v1/products/{id}/sync-capabilities`.

## Fastest way to validate ingestion → billing → analytics — 5 more steps

Once discovery works, drive events:

5. Create a Billable Unit (metric) — e.g. `ai_agent.capability_invocations` (COUNT aggregation).
6. Create a Rate Plan V3 that includes this metric on your AI_AGENT product. In the wizard's per-metric config, set `dimensionPricing` per capability — e.g. `summarize_url: 1.0`, `verify_claim: 3.5`, `answer_question: 5.0`. **Verifies P2 (per-capability pricing UI).**
7. Create an Offering that includes this rate plan → create a Customer + Subscription against the offering. **Verifies P8 (loadgen driver can find a customer to attribute usage to).**
8. Fire real events via `POST /v1/ingest`:
   ```json
   {
     "eventId": "evt_test_001",
     "tenantId": "<your-tenant-id>",
     "productType": "AI_AGENT",
     "customerId": "<customer-id>",
     "metricName": "ai_agent.capability_invocations",
     "quantity": 1,
     "occurredAt": "2026-07-12T10:00:00Z",
     "metadata": {
       "agent_id": "<agent-id-from-storefront>",
       "session_id": "sess_001",
       "capability_name": "verify_claim",
       "execution_status": "SUCCESS",
       "execution_duration_ms": 1240
     }
   }
   ```
   Send 10-20 events across 2-3 different `capability_name` values.
9. Verify:
   - `usage_events` table shows rows with `tool_name` populated (the extractor's snake_case bridge — verifies G4 contract).
   - Bill run generates line items per capability with the correct multipliers (verifies dimension-pricing parity).
   - `ai_agent_invocations` in ClickHouse shows the aggregated MV rows (verifies analytics dual-write).
   - Reports → Agentic → "Revenue by Capability" (RPT_AGT_006, per P11) returns non-empty data.

## Alternative — drive with loadgen (higher-volume validation)

Skip steps 5-9 and use loadgen instead:

```bash
cd aforo-nextgen-loadgen
export AFORO_LOADGEN_INGEST_URL=https://your-cluster/v1/ingest
go run . run --scenario scenarios/ci-ai-agent-rest.yaml
```

This drives 50 TPS × 60s = 3000 events across the built-in capability registry. Confirms the `ai_agent_rest` driver + `capability_name` template (P8).

## What these manifests do NOT include

Deliberate omissions to keep the samples focused:

- No `input_schema` fields that reference `$defs` / `$ref` — the validator accepts them but they add complexity.
- No `output_schema` blocks — the validator ignores them; add if useful for your own agents.
- No governance policy DSL beyond flat key-value — real policies would be product-specific.

## Files

```
agent-samples/
├── README.md                        # this file
└── manifests/
    ├── research-agent.yaml          # ANTHROPIC, 5 capabilities
    ├── support-agent.yaml           # CUSTOM, 3 capabilities
    └── coding-agent.yaml            # OPENAI, 4 capabilities, HITL governance
```
