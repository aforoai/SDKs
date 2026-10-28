# Aforo for MuleSoft (Mule 4 custom policy)

One custom policy, **`aforo-metering`**, that Aforo applies to an API instance in Anypoint API Manager. On every call it checks the end customer's **Aforo API key**, refuses a customer whose hard limit is used up (**429**), lets the call through, and sends the call's usage to Aforo after the response. Your API needs no Aforo code.

**Version:** 3.1.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Target: **Mule 4 runtimes as API gateways** (CloudHub, CloudHub 2.0, Runtime Fabric, hybrid), Mule 4.4 or later, Java 8, 11 or 17. Flex Gateway is not covered (it needs a separate PDK policy).

> **Not verified on a live Anypoint org yet.** The billing logic runs under the open-source DataWeave CLI against 179 cases, and the template's structure is checked statically (see [Tests](#tests)). See [What only a live runtime can prove](#what-only-a-live-runtime-can-prove).

## What Aforo deploys

Aforo's organization service does this when you connect your Anypoint org and deploy an Aforo product to an API instance. To do it by hand, see the [user guide](USER_GUIDE.md).

| What | Where | Notes |
|---|---|---|
| Policy asset `aforo-metering` **3.1.0** | your org's Exchange, groupId = your **Anypoint organization id** | the jar `aforo-metering-3.1.0-mule-policy.jar` plus its definition [`aforo-metering.yaml`](aforo-metering/aforo-metering.yaml) (classifier `policy-definition`) |
| The policy, applied to each API instance | API Manager, per API instance (and environment) | with the [configuration properties](USER_GUIDE.md#configuration-properties) for the Aforo product it sells: `aforo-product-id`, `product-type`, metrics, quota |
| The product ↔ API instance mapping | Aforo, `gateway_product_meterings` | provider `mulesoft`, `gateway_resource_id` = the API instance id |

Aforo pushes **no keys and no client applications** into Anypoint: Anypoint generates its own client ids, so the policy checks the Aforo key itself (below). One Aforo key works on every gateway Aforo supports.

## The single-key model

The end customer calls your API with the key they got from Aforo, in the `x-api-key` header (name: `key-header`):

```bash
curl https://api.example.com/v1/orders -H "x-api-key: sk_live_…"
```

- The key is either an `sk_live_…` / `sk_test_…` key from the storefront, or, for AI_AGENT and MCP_SERVER products, the **client secret** of an agent credential (48 lowercase hex characters). The policy does not judge the shape: Aforo does. Only a missing key, one longer than 1024 characters or one with control characters is refused without asking.
- The policy asks Aforo: `POST {introspect-url}` with `{"key": "<the key>"}` and `X-API-Key: {aforo-api-key}` (the policy's own `usage:ingest` key; the tenant comes from it). Aforo answers `{"active": true, "keyId", "customerId", "subscriptionId", "subscriptionIds", "productIds", "productType", "scopes", "expiresAt"}` or exactly `{"active": false}`, bare or inside `{"success", "data"}`.
- **Allowed** only when the key is active and its `productIds` contain this API instance's `aforo-product-id`. The customer billed is the answer's `customerId`, never anything the client sends.
- The `x-api-key` header is **removed** before the request reaches your API (as Kong's `hide_credentials`).

## Responses

| Status | When | Body | Metered |
|---|---|---|---|
| **401** | no key | `{"message":"No API key found in request"}` | no |
| **401** | unknown, revoked, suspended, expired, another tenant's, or no live subscription (Aforo answers all of these `{"active":false}`) | `{"message":"Invalid authentication credentials"}` | no |
| **403** | active key whose subscriptions do not include this product (`productIds` may be `[]`) | `{"message":"This API key does not grant access to this API"}` | no |
| **429** | the pre-flight quota check said DENY | `{"message": "<reason>", "retryAfter": <s>}`, header `Retry-After: <s>` = max(1, ceil(retryAfterMs / 1000)), 60 when Aforo gives none | no |
| **503** | Aforo's introspection did not answer and no cached answer may be used | `{"message":"Access check unavailable"}`, `Retry-After: 5` | no |
| **503** | the quota check did not answer and `quota-fail-open` is `false` | `{"message":"Quota check unavailable"}`, `Retry-After: 1` | no |
| **503** | the policy is missing `aforo-endpoint`, `aforo-api-key` or `aforo-product-id` | `{"message":"Aforo policy is not configured"}` | no |
| anything else | your API's own answer, unchanged | | yes (see exclusions) |

A refused call never reaches your API.

## Caching and revocation latency

| Cache | Where | How long |
|---|---|---|
| Active key | the policy (per worker, in memory, by SHA-256 of the key) | `identity-cache-ttl-s` = **60 s**, never past the key's `expiresAt` |
| Unknown / inactive key | the policy | `identity-negative-ttl-s` = 10 s |
| Active key | Aforo (server side) | 30 s, **evicted at once** on revoke, cancel, pause, suspend, resume, upgrade and downgrade |
| Unknown / inactive key | Aforo | 10 s |
| Quota ALLOW / WARN | the policy | 1 s (DENY is never cached) |

So **a revoked key or a cancelled subscription stops working at the gateway within about 60 s** (the policy's positive cache; Aforo's own cache is cleared at once). A new key, or a new subscription for a key that was refused, works within about 20 s (both negative caches). While Aforo's introspection is down, an active answer up to `identity-stale-ttl-s` (**900 s**) old is still used, so during an outage a revocation can take up to 15 minutes; with no usable answer the call gets 503 (or passes unchecked and unmetered with `identity-fail-open`).

## Product types

Trusted sources only: the introspected key, the policy configuration, the gateway's own request id, and your API's **response** headers, which a client cannot set. A response header that is present but unusable (control characters, or longer than Aforo allows) skips the event; it never falls back to another identity.

| `product-type` | Events per call | Type-specific fields |
|---|---|---|
| `API` (default) | 1 | none |
| `AGENTIC_API` | 1 | `traceId` = upstream `X-Aforo-Trace-Id` (name: `trace-id-header`), else the gateway request id (one call, one goal). The client's `traceparent` only travels in `event.trace`: it never names the trace and never changes the type. |
| `AI_AGENT` | 1 | `agentId` = upstream `X-Aforo-Agent-Id`, else `agent-id`, else the Aforo product id. `sessionId` = upstream `X-Aforo-Session-Id`, else the gateway request id. `traceId` = `sessionId`. Request headers such as `X-Agent-Id` are never read. |
| `MCP_SERVER` | 1 per JSON-RPC `tools/call`, batches included; **0** for `initialize`, `tools/list`, `ping` and notifications, which are also never quota-refused | `toolName` from the body (`unknown` when missing); `agentId` = upstream `X-Aforo-Agent-Id`, else the customer (never `params._meta.agent_id`); `sessionId` = upstream `X-Aforo-Session-Id`, else the upstream's `Mcp-Session-Id` **response** header (hashed when longer than 64 characters). |

Every event carries `customerId`, `metricName`, `quantity`, `idempotencyKey` (a UUID the policy mints per call; for MCP `mcp:{tenant}:{id}:{n}:{tool}`; never a client header), `occurredAt`, `productType`, `executionStatus`, `endpointPath`, `httpMethod`, `statusCode`, `responseTimeMs`, `trace` (the client's trace headers, for correlation only) and `metadata` (`gateway: mulesoft`, `productId`, `keyId`, …).

- **Metric**: upstream `X-Aforo-Metric`, else the first matching `metric-mappings` rule (Kong's Lua patterns), else for a tool call the product's `default-metric` (unless it is `api_calls`) or `mcp_server.tool_invocations`, else `default-metric`, else `api_calls`. The pre-flight quota check asks about the same metric, minus the response header it cannot know yet.
- **Quantity**: upstream `X-Aforo-Quantity` (name: `quantity-header`; a positive number, rounded to 6 decimals), else 1.
- **`executionStatus`**, the table every Aforo gateway uses: 2xx/3xx `SUCCESS`, 408/504 `TIMEOUT`, 499 `CANCELLED`, 400/422 `VALIDATION_FAILED`, 401/403/429 `BLOCKED`, any other 4xx/5xx `ERROR`. `status-outcomes` overrides it per code.
- **Not metered**: `exclude-paths` (default `/health`, `/ready`, `/metrics` and the paths below them), `exclude-status-codes` (default 401, 403, 429), CORS preflights. The key is still checked on excluded paths.

### Optional upstream response headers

| Header | Effect |
|---|---|
| `X-Aforo-Quantity` | quantity of this call (tokens, minutes, …) |
| `X-Aforo-Metric` | metric of this call |
| `X-Aforo-Agent-Id` | agent (AI_AGENT, MCP_SERVER), at most 36 characters |
| `X-Aforo-Session-Id` | session (AI_AGENT, MCP_SERVER), at most 64 characters |
| `X-Aforo-Trace-Id` | goal / trace (AGENTIC_API), at most 128 characters |
| `Mcp-Session-Id` | MCP's own session header; the MCP session when `X-Aforo-Session-Id` is absent |

## Delivery, latency and loss

- On the request path the policy adds at most one introspection call (1500 ms timeout) when the key is not cached, and one quota call (`quota-timeout-ms`, 1500 ms) when quota is enforced and not cached for that customer and metric.
- Usage is sent **after** the response, in an async scope: `POST {aforo-endpoint}` with `{"events": [...]}` and `X-API-Key: {aforo-api-key}`. The ingestor answers 202 `{"success":true,"data":{"accepted","failed","errors":[{"index","message"}]}}`:
  - an error with `"retryable": true` is transient: only those events are re-sent (from an ingestor that does not send the flag, a message starting "The event could not be stored" counts as retryable);
  - any other per-event error is permanent: logged (`USAGE EVENT REFUSED`) and dropped;
  - no answer (connection error, 10 s timeout), 408, 429 or any 5xx: the whole batch is re-sent;
  - any other status (401, 403, other 4xx, a redirect): logged (`USAGE EVENT REFUSED`, with the status) and dropped. A wrong or revoked `aforo-api-key` therefore loses usage until it is fixed; the policy has no durable queue to hold it.
  - up to 3 attempts. The wait before attempt 2 is a random 0–1 s, before attempt 3 a random 0–2 s (full jitter, base 500 ms, cap 30 s), or the ingestor's `Retry-After` (seconds or an HTTP date) when that is longer, at most 60 s. The wait runs on the runtime's scheduler (an `until-successful` timed by the delivery script) and holds no thread. The idempotency keys never change, so a copy that did land is deduplicated, never billed twice.
- One delivery per API call, carrying that call's events (one, or one per tool call in an MCP batch). A Mule 4 custom policy has no scheduler or flush timer, so calls are not collected into larger batches. The pending usage of each call is held in an in-memory object store entry (`persistent="false"`, per worker) only while its delivery runs: it is the retry state and the backlog count, not a durable queue.
- At most 16 deliveries run at once per policy instance and at most 1000 calls' usage waits; past that the usage is dropped with a `USAGE DROPPED` warning (once a minute). A worker restart loses usage that was still waiting. The policy does not split a batch on 413 (one call's events are far below the ingestor's size limit).
- Warnings that could repeat on every call (introspection or quota unavailable, backlog full) are logged once a minute.

## Build

```bash
cd aforo-gateway-plugins/mulesoft/aforo-metering
docker run --rm -v "$PWD":/src -v "$HOME/.m2":/root/.m2 -w /src eclipse-temurin:17 ./mvnw -B -ntp clean package
# -> target/aforo-metering-3.1.0-mule-policy.jar
```

Everything resolves from MuleSoft's public repository (`repository.mulesoft.org/releases`) and Maven Central: no Anypoint or Nexus EE credentials. The policy bundles the HTTP connector 1.10.3, the ObjectStore connector 1.2.2, the Java module 1.2.16 and the secure configuration property module 1.2.7. `./mvnw deploy -Danypoint.org.id=<org id>` publishes the jar and the definition to your Exchange (credentials in `~/.m2/settings.xml`, server id `exchange-server`).

## Tests

From `aforo-gateway-plugins/`:

```bash
# Structure: package, definition <-> template, flow order, outbound calls, docs
docker run --rm -v "$PWD":/src -w /src node:22 node mulesoft/tests/policy.test.cjs
# Billing logic: the template's 8 DataWeave scripts under the DataWeave CLI 2.12.3
mulesoft/tests/run-dataweave.sh
```

- `dataweave.test.cjs` reads the scripts straight out of `template.xml` (the only copy) and runs them against [`tests/fixtures/`](tests/fixtures): configuration parsing and Lua patterns, the key and its hash, identity and cache decisions (fresh, stale, negative, `expiresAt`, failures, fail-open), quota decisions, the events of all four product types with MCP batches and protocol messages, and the ingestor's 202 handling.
- `policy.test.cjs` checks what the CLI cannot: every property is declared and read exactly once, no property ever reaches DataWeave source text, the quota check and the key removal come before `execute-next`, a refusal never reaches `execute-next`, every variable read is written, the outbound calls' URLs and headers, and that the two copies of the metering block are identical.
- [`tests/policy-contract.md`](tests/policy-contract.md) is the checklist for a test API on a live runtime.

## What only a live runtime can prove

There is no Mule 4 runtime that runs a custom policy offline: policies need the Enterprise runtime with API Gateway, which is not on a public registry, so none of this was run on a runtime.

- That the gateway applies the policy: the Handlebars rendering of `={{property}}` attribute values (double braces HTML-escape, the XML parser decodes), the `{{#if encrypted}}` block, and encrypted `aforo-api-key` values.
- **Key removal**: `propagateMessageTransformations="true"` on `http-policy:source` and the Java module rebuilding `HttpRequestAttributes` without the header (what MuleSoft's own `http-transform:remove-headers` does). If the runtime refuses it, the call still goes through, with the header, and the policy logs `could not remove the x-api-key header`.
- **Refusals**: the listener building the 401/403/429/503 response from `HttpPolicyResponseAttributes`.
- That an API error (APIkit 404, 5xx) reaches the policy's `on-error-propagate` with the error response's status, and that propagating it leaves the client's response unchanged.
- Object store, `async maxConcurrency`, `foreach` and `until-successful` behaviour (the retry wait relies on `millisBetweenRetries` being read as an expression on entry, which Mule 4.4+ does); per-worker caches on multi-worker deployments.
- How a 1.10.3 HTTP connector in the policy coexists with your application's own HTTP connector version.

## Not part of this policy

- **JWT validation.** Aforo ships no JWT policy for MuleSoft. If your API also accepts JWTs, use MuleSoft's own **JWT Validation** policy (as Kong's `jwt` plugin and Apigee's `VerifyJWT` are used on those gateways). This policy does not read JWT claims: the customer always comes from the Aforo key.
- **Compound metering** (several metrics from one call, such as LLM input and output tokens with a shared `correlationId`) is not supported on MuleSoft. Send compound usage from your API with an Aforo SDK, or use a gateway that supports it.
- **Margin guard** is not supported on MuleSoft.
- The 2.x YAML files for these (`compound-metering-policy.yaml`, `margin-guard-policy.yaml`, `preflight-quota-policy.yaml`, `jwt-validation-config.yaml`) were descriptions, not installable policies, and were removed in 3.0.0. The quota pre-flight is part of this policy (`quota-enabled`).

## Known differences from Kong and Apigee

- A quota WARN is not marked with `X-RateLimit-Warning` on the response (the response attributes are not rebuilt).
- A JSON-RPC error inside a 2xx MCP answer is not detected: the response body is streamed to the client and not read. MCP events are classified by HTTP status only.
- Quantity comes from `X-Aforo-Quantity` or is 1; there is no `response_size` option.
- No CORS bypass: apply MuleSoft's CORS policy before this one if browsers call the API.

## Files

| Path | What |
|---|---|
| [`aforo-metering/pom.xml`](aforo-metering/pom.xml) | Maven `mule-policy` project |
| [`aforo-metering/aforo-metering.yaml`](aforo-metering/aforo-metering.yaml) | policy definition: the configuration form, every property |
| [`aforo-metering/src/main/mule/template.xml`](aforo-metering/src/main/mule/template.xml) | the policy, including the DataWeave scripts |
| [`aforo-metering/mule-artifact.json`](aforo-metering/mule-artifact.json) | minimum Mule version, Java versions |
| [`tests/`](tests) | structure tests, DataWeave CLI tests and fixtures, the live checklist |
