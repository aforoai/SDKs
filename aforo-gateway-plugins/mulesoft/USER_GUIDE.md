# Aforo for MuleSoft — User Guide

**Version:** 3.0.0 · **Updated:** 2026-10-22 · **Audience:** engineers who own an API in Anypoint API Manager and sell it through Aforo.

Normally you do none of this by hand: when you connect your Anypoint org in Aforo and deploy an Aforo product to an API instance, Aforo publishes the policy to your Exchange and applies it with the right configuration. This guide explains what that does, how to do it manually, and how to check it.

## 1. What you get

- Every call must carry the end customer's **Aforo API key** in `x-api-key`. The policy checks it with Aforo, so one key works on every gateway Aforo supports; Anypoint client applications and contracts are not involved.
- A customer whose hard limit is used up gets **429** before your API is called (when quota is enforced).
- Every call that reaches your API is metered in Aforo, for API, AGENTIC_API, AI_AGENT and MCP_SERVER products. See the [README](README.md#product-types) for the rules per type.
- Your API never sees the `x-api-key` header.

## 2. Requirements

- An API instance managed by API Manager on a **Mule 4.4+ runtime** (CloudHub, CloudHub 2.0, Runtime Fabric or a hybrid server), Java 8, 11 or 17. A basic-endpoint proxy or an application with API autodiscovery both work.
- Outbound HTTPS from the runtime to Aforo (`api.aforo.ai`).
- Your Aforo tenant id, an Aforo API key with scope `usage:ingest`, and the Aforo product id of what this API instance sells.

## 3. Configuration properties

The policy reads only these. Aforo's deploy sets them per API instance; in API Manager they are the policy's configuration form.

| Property | Default | What it does |
|---|---|---|
| `aforo-endpoint` | **required** | Ingest batch URL, `https://api.aforo.ai/v1/ingest/batch`. Its origin is the default origin of the two URLs below. |
| `aforo-api-key` | **required**, sensitive | The policy's own Aforo key (`usage:ingest`). Sent as `X-API-Key` on introspection, quota checks and ingest. Encrypted when your runtime has a gateway encryption key. |
| `aforo-tenant-id` | **required** | Your Aforo tenant id: `X-Tenant-Id` on the quota check, and part of the MCP idempotency key. |
| `aforo-product-id` | **required** | The Aforo product this API instance sells. A key whose `productIds` do not contain it gets 403. |
| `introspect-url` | origin of `aforo-endpoint` + `/api/v1/customer-keys/introspect` | Where keys are checked. |
| `key-header` | `x-api-key` | Request header carrying the end customer's key. Removed before your API. |
| `identity-cache-ttl-s` | `60` (max 3600) | How long an active key is trusted without asking Aforo; never past the key's `expiresAt`. The longest a revoked key keeps working. `0` asks on every call. |
| `identity-negative-ttl-s` | `10` (max 600) | How long an unknown or inactive key is refused without asking. |
| `identity-stale-ttl-s` | `900` (max 86400) | When introspection fails, an active answer up to this old is still used. |
| `identity-fail-open` | `false` | When introspection fails and no answer may be used: `false` answers 503; `true` lets the call through **unchecked and unmetered**. |
| `product-type` | `API` | `API`, `AGENTIC_API`, `AI_AGENT` or `MCP_SERVER`. |
| `default-metric` | `api_calls` | Metric of calls no mapping matches (an MCP tool call: `mcp_server.tool_invocations` unless this is set). |
| `metric-mappings` | none | JSON array `[{"pathPattern": "^/v1/search", "method": "GET", "metricName": "searches"}]`, first match wins. `pathPattern` is a **Lua pattern**, as on Kong (`%d`, `%w`, `[...]`, `.-`, `^`, `$`; unanchored unless it starts with `^`); `%b`, `%f` and back-references are not supported and skip the rule. `method` is optional. |
| `quantity-header` | `X-Aforo-Quantity` | Upstream response header with the event quantity. |
| `agent-id` | the Aforo product id | AI_AGENT: the agent when the upstream sends no `X-Aforo-Agent-Id`. At most 36 characters. |
| `trace-id-header` | `X-Aforo-Trace-Id` | AGENTIC_API: upstream response header naming the trace. |
| `status-outcomes` | none | `{"404": "VALIDATION_FAILED"}` (or `404=VALIDATION_FAILED,429=ERROR`): `executionStatus` per HTTP status. |
| `exclude-paths` | `/health,/ready,/metrics` | Paths neither metered nor quota-checked (the key is still checked). An entry matches itself and the paths below it, not `/healthcare`. `none` meters every path. |
| `exclude-status-codes` | `401,403,429` | Statuses that produce no event. `none` meters every status. |
| `quota-enabled` | `false` | Ask Aforo before your API whether the customer is within quota for the metric the call bills; DENY answers 429. Aforo sets it for products with hard limits. |
| `quota-check-url` | origin of `aforo-endpoint` + `/api/v1/quota/check` | Where quota is checked. |
| `quota-timeout-ms` | `1500` (100–10000) | Quota check timeout. |
| `quota-fail-open` | `true` | When the quota check fails: `true` lets the call through, `false` answers 503. |

Values are rendered into the policy as text. A value must not contain `${` (Mule would read it as a property placeholder).

## 4. Install by hand

1. **Build** the jar ([README → Build](README.md#build)), or take `aforo-metering-3.0.0-mule-policy.jar` from the release.
2. **Publish** it to your Exchange as a policy: groupId = your Anypoint organization id, assetId `aforo-metering`, version `3.0.0`, with `aforo-metering.yaml` as the `policy-definition`. Either `mvn deploy -Danypoint.org.id=<org id>` from `aforo-metering/`, or Exchange → Publish new asset → Policy, uploading both files.
3. **Apply** it in API Manager → your API instance → Policies → Add policy → *Aforo Usage Metering*, filling in the properties above. Put it **first** in the policy order (it is the API's authentication). If browsers call the API, apply MuleSoft's CORS policy before it.
4. **Map** the product in Aforo (Aforo's deploy records the API instance id against the product).

Removing the policy from the API instance stops key checks and metering at once.

## 5. Check it

With a test key for a customer subscribed to the product:

```bash
curl -i https://your-api/v1/orders                                   # 401 No API key found in request
curl -i https://your-api/v1/orders -H "x-api-key: not-a-key"         # 401 Invalid authentication credentials
curl -i https://your-api/v1/orders -H "x-api-key: $KEY_OTHER_PRODUCT"   # 403
curl -i https://your-api/v1/orders -H "x-api-key: $KEY"              # your API's answer; usage appears in Aforo
```

Your API should not receive an `x-api-key` header. The full checklist, including quota, MCP and outage behaviour, is [`tests/policy-contract.md`](tests/policy-contract.md).

## 6. Upgrading from 2.x

3.0.0 is a rewrite and replaces the policy. What changes:

- **Identity**: 2.x took the customer from a JWT claim (`customer-id-claim`, `tenant-id-claim`, MuleSoft's JWT Validation policy) and emitted nothing without one. 3.0.0 takes it from the Aforo key via introspection. Remove the JWT-based setup for Aforo; a missing key is now refused (401).
- **Removed properties**: `customer-id-claim`, `tenant-id-claim`, `mcp-enabled`, `mcp-product-id`, `quantity-source`, `include-metadata` and the deprecated `product_type`, `default_metric`, `quantity_source`, `include_metadata`. MCP is now `product-type: MCP_SERVER`.
- **`metric-mappings`** is now Kong's JSON with Lua patterns (2.2.0 used `KIND|value|metric`).
- **`status-outcomes`** takes JSON (the CSV form still works).
- **AGENTIC_API** no longer reads the client's `traceparent` / `x-trace-id` for the trace, and a trace header no longer changes the product type.
- **MCP**: the agent is no longer `params._meta.agent_id` from the body, the session no longer the request's `Mcp-Session-Id`; batches bill every tool call and protocol messages bill nothing.
- New: 401/403/429/503 answers, the quota pre-flight, key removal, AI_AGENT events, upstream `X-Aforo-*` headers.

Publish 3.0.0 as a new version of the asset and re-apply it on each API instance; the 2.x configuration is not carried over.

## 7. Troubleshooting

All log lines start with `[aforo-metering]`.

| Log line | Meaning |
|---|---|
| `policy not configured: …` (and every call gets 503) | a required property is empty |
| `introspection failed (HTTP 401: Aforo refused aforo-api-key …)` | the policy's key is wrong or lacks `usage:ingest` |
| `introspection failed (no response: …): using the cached answer` | Aforo unreachable; cached answers are used up to `identity-stale-ttl-s` |
| `introspection failed (…): answering 503` | Aforo unreachable and no usable cached answer |
| `quota check unavailable (…): failing OPEN` | quota not enforced while the check fails |
| `could not remove the x-api-key header before the upstream` | the runtime refused the request rewrite; the call still went through, with the header |
| `USAGE EVENT REFUSED (permanent, not retried): <metric> <key>: <reason>` | the ingestor rejected an event (unknown metric, unknown customer, missing field) |
| `USAGE NOT DELIVERED after 3 attempts` | the ingestor did not take the batch; that usage is lost |
| `USAGE DROPPED: 1000 calls' usage is already waiting` | the backlog is full (ingestor down or slow) |
| `events skipped: unusable X-Aforo-… response header` | your API sent a header Aforo cannot use (too long, control characters) |
| `metric-mappings rule … skipped` | the rule has no `metricName` or uses an unsupported Lua pattern |

Repeating warnings (introspection, quota, backlog) are logged at most once a minute.
