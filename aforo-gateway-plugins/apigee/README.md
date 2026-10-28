# Aforo for Apigee X (shared flows)

Two Apigee shared flows that meter every call to your API in Aforo, enforce your end customers' hard limits, and need no code in your API:

- **`aforo-access`** on the environment's **PreProxyFlowHook**: verifies the end customer's API key, works out which Aforo customer is calling and what the call bills to, and answers **429** when that customer's quota is used up.
- **`aforo-metering`** on the environment's **PostProxyFlowHook**: builds the call's usage events and sends them to Aforo.
- **`pubsub-forwarder/`** (optional, for `delivery_mode = pubsub`): a Cloud Run service that reads the events from Pub/Sub and delivers them in batches, so an ingest outage loses nothing.

**Version:** 3.1.1 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Target: **Apigee X and hybrid** (`apigee.googleapis.com/v1/organizations/{org}`). The bundles use only policies Apigee Edge also has, but they are built and documented for X. Apigee bundles have no version field, so the version lives in [`VERSION`](VERSION).

> **Not verified on a live Apigee org yet.** The scripts are unit-tested, both flows run end to end in a Node model of the Apigee runtime ([`tests/`](tests)), and the XML is checked statically. See [What only a live org can prove](#what-only-a-live-org-can-prove).

## What Aforo deploys

Normally Aforo's organization service does all of this when you connect your Apigee org and deploy an Aforo product to it. You can also do it by hand: see the [user guide](USER_GUIDE.md).

| What | Where | Notes |
|---|---|---|
| Shared flow `aforo-access` | bundle [`aforo-access/sharedflowbundle/`](aforo-access/sharedflowbundle) | attached to the **PreProxyFlowHook** of each environment |
| Shared flow `aforo-metering` | bundle [`sharedflowbundle/`](sharedflowbundle) (path kept from 2.x) | attached to the **PostProxyFlowHook** of each environment |
| KVM `aforo-metering-config` | **organization** scope, encrypted | global settings, `managed_proxy__{proxy}` per proxy, settings per API product (below) |
| One developer + one developer app per Aforo end customer | app name `aforo-{customerId}` | both carry the custom attribute **`aforo_customer_id`** = the Aforo customer id (AC1) |
| The end customer's key | the app's credential **consumerKey** | the `sk_live_…` key from the storefront, or the client secret of an agent credential (AI_AGENT, MCP); consumerSecret is random; the app gets the API products of the Aforo products the customer subscribed to, approved (AC4) |

Each bundle imports as a zip whose top-level folder is `sharedflowbundle/`.

A flow hook runs for **every** proxy in the environment. Both flows do nothing on a proxy unless the KVM says `managed_proxy__{proxyName} = true`; an unmanaged proxy costs one cached KVM read.

## How a call is handled

1. **`aforo-access`** (managed proxies only)
   1. Reads the key from header `x-api-key`, header `apikey` or query parameter `apikey`, and runs **VerifyAPIKey**. A missing, unknown or revoked key, or a key whose API products do not include this proxy, gets Apigee's standard **401**. That is the per-product access control Kong's ACL gives (Apigee answers 401 where Kong answers 403).
   2. **Strips the key** (`x-api-key`, `apikey` header and query parameter), so your upstream never receives the end customer's Aforo key (Kong's `hide_credentials`).
   3. **Customer** = the `aforo_customer_id` attribute of the verified key's **app**, else of its **developer**, read from VerifyAPIKey's own flow variables (`verifyapikey.AforoVerifyApiKey.app.aforo_customer_id`, `…developer.aforo_customer_id`). These come from the same lookup that verified the key, so no extra AccessEntity call is needed and nothing the client sends can reach them. The flow never uses the request, the app's name or display name, or the developer's email. A verified app without the attribute (one of your own apps, not Aforo's) is let through **unmetered and unchecked**.
   4. **API product** = the product VerifyAPIKey matched (`verifyapikey.AforoVerifyApiKey.apiproduct.name`); its settings are read from the KVM.
   5. **Pre-flight quota check**, when `enforce_quota__{product}` is `true`: `POST {quota_check_url}` with `{customerId, metricName}` for **the metric this call bills to** (the same code as the metering flow). It does not check MCP messages that are not `tools/call`, excluded paths, or CORS preflights.
      - **DENY**: **429**, `Retry-After: max(1, ceil(retryAfterMs/1000))` (60 when none is given), body `{"message": reason, "retryAfter": seconds}`. The upstream is not called and the call is not metered. DENY is never cached.
      - **ALLOW / WARN**: let through, cached about 1 s (`quota_cache_ttl_ms`). WARN adds `X-RateLimit-Warning: approaching-limit` to the response.
      - **No answer within 1500 ms**, or an error: **fail open**, not cached. With `quota_fail_open = false`, **503** instead.
   6. Hands the verified customer to the metering flow in `aforo.verified.*` flow variables. A client can only reach `request.*` variables, so it cannot set these.
2. Your proxy and upstream run as usual.
3. **`aforo-metering`**: builds the events and sends them to `aforo_endpoint` with `X-API-Key: {api_key}` (see [Delivery](#delivery-latency-and-loss)).

## Product types

Trusted sources only: your config, Apigee's own values, and your upstream's **response** headers. A client cannot set a response header. A header that is present but unusable (control characters, or longer than the ingestor allows) skips the event; it never falls back to another identity.

| Type (`product_type__{p}`) | Events per call | Type-specific fields |
|---|---|---|
| `API` (default) | 1 | none |
| `AGENTIC_API` | 1 | `traceId` = upstream `X-Aforo-Trace-Id` (name: `trace_id_header__{p}`), else Apigee's `messageid` (one call, one goal). The client's `traceparent` only goes into `event.trace`: it never names the trace and never turns an API call into an agentic one. |
| `AI_AGENT` | 1 | `agentId` = upstream `X-Aforo-Agent-Id`, else `agent_id__{p}`, else the proxy name (as Kong uses the service). `sessionId` = upstream `X-Aforo-Session-Id`, else `messageid`. `traceId` = `sessionId`. Request headers such as `X-Agent-Id` are never read. |
| `MCP_SERVER` | 1 per JSON-RPC `tools/call`, inside batches too; **0** for `initialize`, `tools/list`, `ping` and notifications, which are also never refused | `toolName` from the body (`unknown` when missing); `agentId` = upstream `X-Aforo-Agent-Id`, else the customer (never `params._meta.agent_id`); `sessionId` = upstream `X-Aforo-Session-Id`, else the upstream's `Mcp-Session-Id` **response** header (hashed when longer than 64 characters). A JSON-RPC error inside a 2xx answer makes that call `ERROR`. |

Every event carries `customerId`, `metricName`, `quantity`, `idempotencyKey` (Apigee's `messageid`; for MCP `mcp:{tenant}:{messageid}:{n}:{tool}`; never a client header), `occurredAt`, `productType`, `executionStatus`, `endpointPath`, `httpMethod`, `statusCode`, `responseTimeMs`, `trace` (the client's trace headers, for correlation only) and `metadata`.

- **Metric**: upstream `X-Aforo-Metric`, else the first matching `metric_mappings__{p}` rule, else (MCP) the product's `default_metric__{p}`, else `default_metric__{p}`, else `api_calls`.
- **Quantity**: upstream `X-Aforo-Quantity` (name: `quantity_header__{p}`; a positive number, rounded to 6 decimals), else `quantity_source`: `1` (default), a fixed number, or `response_size`. `response_size` uses `Content-Length`, else the body's bytes, so chunked responses are billed too.
- **`executionStatus`**, the table every Aforo gateway uses: 2xx/3xx `SUCCESS`, 408/504 `TIMEOUT`, 499 `CANCELLED`, 400/422 `VALIDATION_FAILED`, 401/403/429 `BLOCKED`, any other 4xx/5xx `ERROR`. `status_outcomes__{p}` overrides it per code.

### Optional upstream response headers

| Header | Effect |
|---|---|
| `X-Aforo-Quantity` | quantity of this call (e.g. tokens, minutes) |
| `X-Aforo-Metric` | metric of this call |
| `X-Aforo-Agent-Id` | agent (AI_AGENT, MCP_SERVER), at most 36 characters |
| `X-Aforo-Session-Id` | session (AI_AGENT, MCP_SERVER), at most 64 characters |
| `X-Aforo-Trace-Id` | goal / trace (AGENTIC_API), at most 128 characters |
| `Mcp-Session-Id` | MCP's own session header; the MCP session when `X-Aforo-Session-Id` is absent |

## Configuration: KVM `aforo-metering-config`

Organization scope. Apigee X encrypts it, and the flows read every value into `private.*` variables, so the values are masked in Debug sessions. Values are cached for 60 s, so a change takes up to a minute to apply.

**Global keys**

| Key | Default | What it does |
|---|---|---|
| `aforo_endpoint` | required | ingest URL, `https://api.aforo.ai/v1/ingest/batch` |
| `api_key` | required | your Aforo API key, scope `usage:ingest`; sent as `X-API-Key` |
| `tenant_id` | required for quota | sent as `X-Tenant-Id` on the quota check; also the JWT tenant binding |
| `quota_check_url` | origin of `aforo_endpoint` + `/api/v1/quota/check` | the pre-flight endpoint |
| `quota_timeout_ms` | `1500` | informational: Apigee takes only literal ServiceCallout timeouts, so the check always waits at most 1500 ms. Change the bundle to change it. |
| `quota_fail_open` | `true` | `false`: no answer means 503 instead of letting the call through |
| `quota_cache_ttl_ms` | `1000` | how long ALLOW/WARN is cached, rounded up to whole seconds; `0` turns the cache off |
| `delivery_mode` | `async` | `async`, `sync` or `pubsub`, see [Delivery](#delivery-latency-and-loss) |
| `pubsub_topic` | none | `pubsub` only: `projects/{project}/topics/{topic}`. Without it `pubsub` falls back to `async`. |
| `max_retries` | `1` | `sync` only: `0` turns the one retry off |
| `exclude_paths` | `/health,/ready,/metrics` | path prefixes never metered or checked (a prefix matches itself and the paths below it, against the full path and the proxy path suffix); `none` excludes nothing |
| `exclude_status_codes` | `401,403,429` | statuses never metered; `none` excludes nothing |
| `include_metadata` | `true` | `false` keeps only `metadata.endpoint_path` |
| `quantity_source` | `1` | `1`, a fixed number, or `response_size` |
| `jwt_validation_enabled` | off | `true`: also require an Aforo JWT (`Authorization: Bearer`), checked against `aforo_jwks_uri` and `aforo_jwt_issuer` (both required), issued for `tenant_id`. Claims go upstream as `X-Customer-Id`, `X-Tenant-Id`, `X-Key-Id`, `X-Scopes`, `X-Environment`, and `key_id` goes into `metadata.keyId`. The billed customer stays the app attribute. See [Token revocation](#token-revocation). |
| `aforo_org_service_url` | none | org-service base URL reachable from Apigee (for example `https://org.aforo.ai`), for the JWT revocation check. Required when `jwt_validation_enabled` is on and `jti_check_enabled` is not `false`; without it every check counts as no answer. |
| `jti_check_enabled` | `true` | with `jwt_validation_enabled`: check that the JWT is not revoked. `false` switches the check off. |
| `jti_check_fallback` | `ALLOW` | what no answer from the revocation check means: `ALLOW` lets the call through, `DENY` answers 503 with `Retry-After: 5` |
| `jti_cache_seconds` | `30` | how long "not revoked" is cached; `0` asks every time. "Revoked" is kept until the token's `exp` (at most 24 h). |
| `jti_breaker_failures` | `3` | unanswered revocation checks in a row before the breaker opens |
| `jti_breaker_seconds` | `30` | how long an open breaker skips the call (the fallback applies meanwhile) |

**Per proxy**: `managed_proxy__{proxyName}` = `true`.

**Per API product** (`{p}` is the raw `apiproduct.name`; Apigee joins composite KVM keys with `__`):

| Key | What it does |
|---|---|
| `product_type__{p}` | `API`, `AGENTIC_API`, `AI_AGENT` or `MCP_SERVER` (default `API`) |
| `default_metric__{p}` | the product's catalog metric |
| `metric_mappings__{p}` | JSON array `[{"pathPattern": "^/v1/sms", "method": "POST", "metricName": "sms_sent"}]`, first match wins. `pathPattern` is a **Lua pattern**, as in the Kong plugin (`^` anchors, `%d`, `%w`, `%.` for a literal dot, `-` is a lazy quantifier), matched against base path + path suffix. `%b`, `%f` and back-references are not supported: such a rule is skipped. `method` is optional. |
| `agent_id__{p}` | AI_AGENT: the agent when the upstream sends none |
| `quantity_header__{p}` | default `X-Aforo-Quantity` |
| `trace_id_header__{p}` | default `X-Aforo-Trace-Id` |
| `enforce_quota__{p}` | `true` runs the pre-flight quota check |
| `aforo_product_id__{p}` | the Aforo product id, sent as `metadata.productId` |
| `status_outcomes__{p}` | JSON `{"404": "VALIDATION_FAILED"}` |

An API product with none of `product_type__`, `default_metric__` and `metric_mappings__` is not Aforo's: its calls go through unmetered.

## Delivery: latency and loss

The PostProxyFlowHook runs **before** the response goes to the client, so how the events are sent decides what the client waits for. We considered three options:

- **JavaScript `httpClient` without waiting** is not reliable on Apigee X. Per Google's Apigee team, a request sent without a callback may never go out once the script ends. With a callback, the policy waits for it, which adds the same latency as waiting.
- **ServiceCallout without a `<Response>` element** is Apigee's documented fire-and-forget: the flow does not wait and cannot see the answer.
- **ServiceCallout with a response and short timeouts**: the client waits for the ingestor.

The flows offer the last two:

| `delivery_mode` | Client waits for Aforo | What can be lost |
|---|---|---|
| `async` (default) | no | Any event the ingestor does not store is lost, and nothing logs it: Aforo unreachable, a 5xx, a refused key, or a per-event "could not be stored". |
| `sync` | yes: the ingestor's response time, at most about 4 s (1 s connect + 2 s answer, plus one retry only when the first failure was quick) | Only what still fails after one retry. The 202's per-event `errors` are read: "The event could not be stored…" is re-sent once (just those events, same `idempotencyKey`, so a copy that did land is deduplicated), other errors are dropped. No answer, a 5xx or a 408 re-sends the batch. 429 and other 4xx are not re-sent. Every loss is `print`ed (visible in Debug). |
| `pubsub` (Apigee X / hybrid) | for one Pub/Sub publish (inside Google Cloud), not for the ingestor | Only a failed publish (Pub/Sub unreachable or the permission missing): that call's events are lost, as in `async`. An ingest outage, 429 or 5xx loses nothing: the [Pub/Sub forwarder](pubsub-forwarder/README.md) acks a message only after the ingestor accepted it, batches up to 500 events per request, and Pub/Sub redelivers what it nacked (7 days by default). |

`async` and `sync` send one HTTP request per API call. `pubsub` is the batched path: one Pub/Sub message per call, and the forwarder sends those to the ingestor 500 events at a time. It needs a topic, a subscription, a Cloud Run service and a deployment service account (see the forwarder README); that is why it is opt-in.

Kong avoids this choice by buffering in shared memory and flushing in the background. Apigee has no such place: anything after the response leaves (PostClientFlow) must be in the proxy itself, cannot be attached by a flow hook, and cannot run JavaScript.

## Token revocation

Since 3.1.1, with `jwt_validation_enabled` the flow also checks that a verified Aforo JWT has not been revoked, with the same contract as the Azure APIM fragment `aforo-jwt-validation`:

- `GET {aforo_org_service_url}/api/v1/public/gateway/token-status?jti=&keyId=&clientId=` with `X-API-Key: {api_key}` (org-service takes the tenant from the key), timeout 2 s. The answer is `{"revoked": true|false, "reason"}`, bare or inside `{success, data}`.
- Runs only for a token that carries `jti` or `key_id` and is for this `tenant_id` (a token for another tenant has already got 401).
- Cached in the environment cache under `aforo-jti` + `tenant|jti|keyId`: "not revoked" for `jti_cache_seconds` (default 30), "revoked" until the token's `exp` (at most 24 h). A revocation therefore takes effect within `jti_cache_seconds`.
- Breaker per tenant and token: after `jti_breaker_failures` (default 3) checks in a row without an answer (timeout, error, non-200, unreadable body) no call for `jti_breaker_seconds` (default 30).
- Revoked: 401 `{"error":"invalid_token","error_description":"Token has been revoked"}`, not metered.
- No answer or open breaker: the call goes through, unless `jti_check_fallback` is `DENY`; then 503 `{"error":"temporarily_unavailable","error_description":"REVOCATION_CHECK_UNAVAILABLE"}` with `Retry-After: 5`.
- `jti_check_enabled = false` switches it off. Without `aforo_org_service_url` every check counts as no answer (and is logged).

The endpoint must be served by your organization-service (the same one the Azure fragment calls). Kong checks revocation in Aforo's Redis instead. The API key itself is checked by VerifyAPIKey on every call, so revoking the key (the app credential) takes effect at once. Not yet run on a live Apigee org.

## Upstream errors (4xx/5xx)

By default Apigee treats a target's 4xx/5xx as a fault and switches to the **error flow**, which skips the PostProxyFlowHook. Those calls are then **not metered**. A flow hook cannot change this: `success.codes` is a literal TargetEndpoint property with no flow-variable form. To bill them, add one step to the proxy (one-time configuration, no code; see the [user guide](USER_GUIDE.md#metering-upstream-errors)):

```xml
<DefaultFaultRule name="aforo">
    <AlwaysEnforce>true</AlwaysEnforce>
    <Step><Name>FC-aforo-metering</Name></Step>
</DefaultFaultRule>
```

Calls that `aforo-access` refused (401/429/503) are never billed this way, because the flow marks them refused.

## Tests

```bash
cd aforo-gateway-plugins
node apigee/tests/run-all.cjs      # Node 22+, no npm install
```

- `static-check.cjs`: the XML is well-formed; manifests, files and Steps agree; every `jsc://` exists; conditions parse; KVM reads are `private.*`; every KVM key is documented; the two copies of `aforo-billing.js` are identical; the scripts are ES5.
- `unit-tests.cjs`: the shared rules (Lua patterns, metric precedence, JSON-RPC, exclusions, status table).
- `flow-tests.cjs`: both flows run end to end in a model of the Apigee runtime, covering keys and identity, quota ALLOW/WARN/DENY/timeout/fail-closed/cache, all four product types, the three delivery modes, error-flow metering and the JWT option.
- `pubsub-forwarder/tests/`: the forwarder against the mock ingestor in `aforo-metering-sdks/mock-ingestor/` (set `AFORO_MOCK_INGESTOR` if that repo is not checked out next to this one).

CI runs them in the `apigee` job.

`aforo-billing.js` exists twice, once in each bundle, because Apigee resolves `jsc://` inside a bundle. Edit `sharedflowbundle/resources/jsc/aforo-billing.js` and copy it to `aforo-access/sharedflowbundle/resources/jsc/`. The static check fails if the two differ.

## What only a live org can prove

- That VerifyAPIKey exposes the custom attributes as `verifyapikey.AforoVerifyApiKey.app.aforo_customer_id` / `.developer.aforo_customer_id` (as documented), and which product it picks when a key has several products for the same proxy.
- That a ServiceCallout without `<Response>` adds no measurable latency, and how often its requests are lost.
- That PublishMessage accepts the topic from a flow variable (`{private.aforo.pubsubTopic}`) as its reference says, how long the publish takes, and that a failed publish with `continueOnError` leaves the response untouched.
- That the PostProxyFlowHook really is skipped on a target 4xx/5xx (the docs do not say), that a DefaultFaultRule FlowCallout sees the target's status in `response.status.code`, and that a RaiseFault from the PreProxyFlowHook reaches the client unchanged, or is reshaped by the proxy's own FaultRules.
- That Apigee joins composite KVM keys exactly as `managed_proxy__{proxy}`, and how a KVM `Get` behaves when its key is missing.
- Rhino quirks the Node model cannot show, the `crypto` object, and JavaScript `timeLimit` under load.
- That a JavaScript policy can set `aforo.access.clientKey` early enough for VerifyAPIKey's `ref`.
