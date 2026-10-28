# Changelog — Aforo Metering Azure APIM Policy

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file. This artifact ships on the shared `aforo-gateway-plugins` monorepo tag — see the repo-root `CHANGELOG.md` for the cross-plugin release record.

## [Unreleased]

## [2.3.1] - 2026-10-28

Fixes from the wave 6 review. Not run on a live APIM instance or Azure subscription.

### Fixed
- **Event Hub forwarder, compound events**: every compound result with `success: false` was dropped and the checkpoint moved past it, including the ones the ingestor returns for a full queue (`Server busy, retry the batch`) and the batch deadline (`Processing timeout`). Those events were lost. The forwarder now resends a result marked `retryable: true`, or, from an ingestor that does not send that field yet, one with either of those two errors, with the same `correlationId` and within the same retry budget as usage events (`AFORO_MAX_RETRIES`, the invocation budget). Still not stored after the retries, the invocation fails and the checkpoint stays. A redelivered event whose measurements were all stored before (`accepted` 0, `duplicates` > 0) counts as delivered instead of "dropped". Four new tests.
- **Compound metering in Event Hub mode** sent nothing unless `aforo-ingestor-url` was set, although only the forwarder posts in that mode. The gate is now the context variable `aforo-compound-deliverable`: true in `eventhub` mode, otherwise true when `aforo-ingestor-url` is set.
- **Cache keys**: the subscription-map key was `aforo:cust:<version>:<map length>:<subscription id>`, so an edit of the map that kept its length served the old customer until the TTL ran out, and two APIM instances sharing an external cache could read each other's entry for the same subscription name. It is now `aforo:cust:<tenant>:<version>:<map hash>:<subscription id>` (tenant from the context variable `aforo-tenant-id`, else the tenant `aforo-jwt-validation` checked, else `-`; map hash = first 22 base64 characters of its SHA-256). The revocation key `aforo:jti:<jti>:<keyId>` is now `aforo:jti:<tenant>:<jti>:<keyId>`. Existing entries are no longer read and expire on their own. `aforo-context` still references only its five Named Values.
- **Margin guard checks the customer that is billed**: it read `aforo-customer-id`, else the JWT's `customer_id`, else the JWT's `sub`, else the subscription id, with no length cap, while `aforo-metering` bills `aforo-customer-id`, else the subscription id, capped at 64 characters. It now uses exactly the metering rule (same source order, trim, 64-character cap). To check and bill the JWT's `customer_id`, include `aforo-context`. Behaviour change for installs that used `aforo-jwt-validation` without `aforo-context`: margin guard now checks the subscription id, which is what those installs bill.
- **Margin guard breaker**: every non-200 answer counted as a breaker failure, so a 4xx for one request (for example pricing's 400 for an id it refuses) could open the breaker and switch the check off for every customer of the key. A 4xx other than 408 / 429 is now allowed, traced and resets the failure count; only no answer, a timeout, 408, 429 and 5xx count.

### Docs
- `eventhub-forwarder/README.md`: a first deployment of `deploy/aforo-eventhub-forwarder.json` can fail on the APIM logger while the new Data Sender role assignment takes effect; running the same deployment again fixes it. The template is unchanged (`dependsOn` already orders them; no sleep or deployment script is added).

## [2.3.0] - 2026-10-27

Wave 6 W6.3 (gaps G348, G350, G351, G352, G353; G354 is in `azure-arm-templates` 2.0.0). Nothing here has run on a live APIM instance or Azure subscription; the checks are `node azure-apim/tests/policy.test.cjs`, `node azure-arm-templates/tests/deny-policy.test.cjs` and `npm test` in `eventhub-forwarder/` (against the mock ingestor).

### Added

- **Event Hub delivery (G348).** New fragment `aforo-metering-eventhub` (`eventhub-delivery-policy-fragment.xml`) and the forwarder Function `eventhub-forwarder/` with an ARM template (`eventhub-forwarder/deploy/aforo-eventhub-forwarder.json`: Event Hubs namespace + hub + consumer group, the APIM logger `aforo-metering-logger` on the instance's managed identity, the Function on its own identity, both role assignments). Opt-in with the context variable `aforo-delivery-mode` = `eventhub`. The forwarder follows the SDK transport rules (batches of 500 / 4 MiB, full-jitter retries, `Retry-After`, 413 split, 401/403/3xx as an outage, per-event `retryable`) and throws on an outage so the Functions retry policy re-runs the batch without moving the checkpoint.
- **Cache and breaker** on the revocation check, the pre-flight quota check and the margin guard (G351), and on the `aforo-context` subscription-map lookup (G353). See the README, "Caching and breakers".
- `aforo-jti-check-fallback` (`ALLOW` default, `DENY` = 503 `REVOCATION_CHECK_UNAVAILABLE`), `aforo-jti-check-enabled`.
- `aforo-compound-max-body-bytes` (default 1 MiB).

### Changed

- **`aforo-metering` builds the event into `aforo-event-batch` and sends it with ONE `send-one-way-request`** after the gate (was one send per branch). Body, headers, keys and Named Values are unchanged; the direct send is still the default. `org-service` bundles this file (one-click deploy) and needs the new copy (see Upgrade).
- **Revocation and margin-guard calls carry the Aforo API key as `X-API-Key` (G350).** The revocation call no longer sends `X-Internal-Call: apim`, which any client could send and proved nothing. Both now reference the Named Value `aforo-api-key` (or the context variable of that name), so `aforo-jwt-validation` and `aforo-margin-guard` refuse to save on an instance that does not have it.
- **Revocation and margin guard call public, key-authenticated endpoints (G332).** Revocation: org-service `GET /api/v1/public/gateway/token-status?jti=&keyId=&clientId=` (was `/internal/v1/auth/token-check`, which no service served, so every check failed open); the token's `client_id` claim is sent too. Margin guard: pricing `GET /api/v1/margin-guard/quick-check?scopeType=CUSTOMER&scopeId=` (was `/internal/v1/margin-guard/quick-check`, refused by public hosts); no tenant id or `X-Tenant-Id` is sent, pricing takes the tenant from the key. Needs org-service branch `jayaforo/w6.7-gateway-token-status` and pricing branch `jayaforo/w6.7-public-margin-check`.
- **Margin guard reads `verdict`** (`ALLOW` / `WARN` / `THROTTLE` / `BLOCK`, bare or inside `data`). It read `allowed` / `level` / `throttleRate`, which pricing never sent, so nothing was ever blocked. `THROTTLE` is pricing's per-request decision: always a 429 (`Retry-After: 1`), never cached, no local dice. Only `BLOCK` and an `ALLOW` with no active level are cached; `BLOCK`'s `Retry-After` is the cache window. `WARN` sets `X-Margin-Guard-Warning: margin-low` on the backend request.
- Pre-flight DENY answers carry the ingestor's `retryAfterMs` as `Retry-After` (was always 60). A DENY is kept at most 60 s (a wallet top-up must unblock quickly) and 5 s when the answer has no `retryAfterMs`, as Kong 2.8.0.
- **`aforo-jwt-validation` binds the token to the tenant.** organization-service signs every tenant's tokens with one key, so a valid signature did not stop tenant A's token on tenant B's APIM: it was forwarded with `X-Tenant-Id: A` and metered with B's key for A's customer. The token's `tenant_id` claim must now equal `aforo-tenant-id` (Named Value, or the context variable of that name), else 401 `TENANT_MISMATCH` (as Kong). The `X-Tenant-Id` sent upstream is always the configured tenant. Checked before identity headers are set and before the revocation call.
- **Pre-flight and margin-guard cache keys are scoped to the API key**: `aforo:pf:<scope>:<customer>` and `mg:<scope>:<customer>`, `<scope>` = first 22 characters of the base64 SHA-256 of `aforo-api-key`. The pre-flight key had no tenant scope; the margin-guard key used the JWT's `tenant_id` while pricing answers for the key's tenant. `aforo-margin-guard` no longer reads `aforo-tenant-id` or the JWT tenant, and no longer skips when no tenant resolves.
- `eventhub-forwarder` reads the ingestor's answer up to 256 KiB and stops there (it buffered the whole body). A 2xx answer over the cap is retried with the same keys instead of being counted as accepted.
- Revocation: an answer without a boolean `revoked` (bare or inside `{success, data}`) counts as no answer. A token with neither `jti` nor `key_id` is not checked.
- **`aforo-compound-metering` never reads a streaming response (G352)**: `text/event-stream`, `*ndjson*` / `*stream*` types, chunked non-JSON without a `Content-Length`, or bodies over the cap. It writes a trace instead. `llm-emit-token-metric` was not used: it writes to Azure Monitor, not to Aforo. The compound `correlationId` is still the request id (Rule #21).
- The compound event is built into `aforo-compound-event`; with Event Hub delivery it is written by `aforo-metering-eventhub` instead of sent.

### Known limits (server side, not fixed here)

- The revocation endpoint `GET /internal/v1/auth/token-check` does not exist in organization-service, so the check never gets an answer and fails open (now cheaply, behind the breaker). `X-API-Key` is sent so that the endpoint, when it is built on a public path behind the API-key filter, can authenticate the caller.
- `GET /internal/v1/margin-guard/quick-check` (pricing-service) is an internal path: public hosts refuse `/internal/**`, and inside the cluster it checks `X-Internal-Api-Key` (when RBAC is on), not `X-API-Key`. It also takes the tenant from a query parameter. A customer APIM cannot reach it today.

### Upgrade

1. Re-import every fragment you use (format `rawxml`).
2. `aforo-jwt-validation` and `aforo-margin-guard` now need the Named Value `aforo-api-key`. An install that runs `aforo-metering` already has it.
   `aforo-jwt-validation` also needs the Named Value `aforo-tenant-id` (your Aforo tenant id) unless you set the context variable of that name before the include. APIM refuses to save the fragment without it, and every token whose `tenant_id` is not that tenant now gets 401 `TENANT_MISMATCH`.
3. Consumption tier: add an external Redis cache to get the caching; without one, behaviour is as in 2.2.0 (every request calls).
4. Event Hub delivery (optional): deploy `eventhub-forwarder/deploy/aforo-eventhub-forwarder.json`, zip-deploy `eventhub-forwarder/`, import `eventhub-delivery-policy-fragment.xml` as `aforo-metering-eventhub`, set `aforo-delivery-mode` = `eventhub` and include the fragment. Steps: `eventhub-forwarder/README.md`.
5. Behaviour you may notice: a revocation now takes up to 30 s (`aforo-jti-cache-seconds`) to apply on a token that was checked just before; a pre-flight ALLOW is reused for 5 s and a DENY for at most 60 s.

## [2.2.0] - 2026-10-02

Merges the working repository's line (APIM-valid `rawxml` fragments, `executionStatus`, exclusions, frozen keys, AGENTIC_API detection, `tests/`, `scripts/verify-on-apim.sh`) with public release 2.1.0 (verified identity, metric mappings, `productType`, OPTIONS skip, JWT fixes). Mirror work by Gowtham and Eswar. Nothing here has run on a live APIM instance; `node azure-apim/tests/policy.test.cjs` and `scripts/verify-on-apim.sh` are the checks.

### How settings are read

`aforo-metering` (`outbound-policy.xml`) reads **context variables** and references four Named Values: `aforo-endpoint`, `aforo-api-key`, `aforo-mcp-enabled`, `aforo-mcp-product-id`. Release 2.1.0 read `aforo-metric-mappings`, `aforo-default-metric` and (through `aforo-context`) `aforo-product-type` and `aforo-subscription-customer-map` as Named Values. APIM rejects a policy that names a Named Value that does not exist and offers no way to test for one, so a single file cannot read both. The bridge is `aforo-context` (`context-policy-fragment.xml`): it copies those four Named Values into the context variables `aforo-metering` reads.

- **Installed from 2.1.0, metering only**: re-import the fragments (format `rawxml`). `aforo-context` is already in your inbound section and your Named Values keep working. Nothing to add.
- **Installed from the working repository or by Aforo's one-click deploy**: re-import `outbound-policy.xml`. No new Named Value is needed. Set `aforo-default-metric` (context variable) to a catalog metric.

### Deprecated aliases

| Canonical (context variable) | 2.1.0 name (Named Value) | How the alias is read |
|---|---|---|
| `aforo-metric-mappings` | `aforo-metric-mappings` | by `aforo-context`, when the variable is not already set |
| `aforo-default-metric` | `aforo-default-metric` | same |
| `aforo-product-type` | `aforo-product-type` | same |
| `aforo-customer-id` | `aforo-subscription-customer-map` (+ JWT `customer_id`) | resolved by `aforo-context` |
| `aforo-mcp-body` | captured when Named Value `aforo-mcp-enabled` is `true` | by `aforo-context` |
| `aforo-compound-enabled`, `aforo-compound-extraction-paths`, `aforo-compound-dimension-paths`, `aforo-ingestor-url` | same names | **not read automatically** — add the lines below |
| `aforo-preflight-enabled`, `aforo-preflight-url`, `aforo-preflight-fallback` | same names | **not read automatically** — add the lines below |
| `aforo-margin-guard-enabled`, `aforo-margin-guard-url`, `aforo-tenant-id` | same names | **not read automatically** — add the lines below |

### Action needed if you use compound, preflight or margin guard from 2.1.0

These three fragments read context variables again (as they did before 2.1.0). Without the lines below they are switched off after the upgrade — no error, no event, no check. Add the lines for the fragments you use to your API policy, before the `include-fragment`; your Named Values stay as they are:

```xml
<inbound>
    <base />
    <include-fragment fragment-id="aforo-context" />
    <set-variable name="aforo-preflight-enabled" value="{{aforo-preflight-enabled}}" />
    <set-variable name="aforo-preflight-url" value="{{aforo-preflight-url}}" />
    <set-variable name="aforo-preflight-fallback" value="{{aforo-preflight-fallback}}" />
    <include-fragment fragment-id="aforo-preflight" />
    <set-variable name="aforo-margin-guard-enabled" value="{{aforo-margin-guard-enabled}}" />
    <set-variable name="aforo-margin-guard-url" value="{{aforo-margin-guard-url}}" />
    <set-variable name="aforo-tenant-id" value="{{aforo-tenant-id}}" />
    <include-fragment fragment-id="aforo-margin-guard" />
</inbound>
<outbound>
    <base />
    <include-fragment fragment-id="aforo-metering" />
    <set-variable name="aforo-compound-enabled" value="{{aforo-compound-enabled}}" />
    <set-variable name="aforo-compound-extraction-paths" value="{{aforo-compound-extraction-paths}}" />
    <set-variable name="aforo-compound-dimension-paths" value="{{aforo-compound-dimension-paths}}" />
    <set-variable name="aforo-ingestor-url" value="{{aforo-ingestor-url}}" />
    <include-fragment fragment-id="aforo-compound-metering" />
</outbound>
```

The 2.1.0 pair format (`jsonPath=metricName;...`) for the compound paths is still accepted, next to the JSON object format.

### Changes a 2.1.0 user will notice

- Upload format is `rawxml` (expressions hold raw quotes and `<`); 2.1.0 shipped entity-escaped files for `--format xml`.
- `policy-fragment.xml` (the minimal variant) is gone. Use `outbound-policy.xml`.
- 401, 403 and 429 responses and the paths `/health`, `/ready`, `/metrics` are not metered by default. Set `aforo-exclude-status-codes` / `aforo-exclude-paths` to `none` to meter everything.
- Every event carries `executionStatus` from the shared table (2xx/3xx `SUCCESS`, 408/504 `TIMEOUT`, 499 `CANCELLED`, 400/422 `VALIDATION_FAILED`, 401/403/429 `BLOCKED`, other 4xx/5xx `ERROR`), with `aforo-status-outcomes` overrides. 2.1.0 sent `SUCCESS`/`ERROR` on MCP events only.
- A request with a valid W3C `traceparent` (or `x-trace-id`) is sent as `productType: AGENTIC_API` with `traceId`.
- `endpointPath` and `metadata.path` are the current request path (`context.Request.Url.Path`); 2.1.0 sent the client-facing path. Metric mappings still match the client-facing path.
- `aforo-default-metric` = `none` now means `METHOD path`, not a metric named `none`.
- A metric name that is empty or longer than 255 characters stops the event (trace, severity warning).
- When `aforo-context` is included, a `set-variable` of `aforo-customer-id` placed before it wins over the JWT claim and the map.

### Changes a working-repository user will notice

- `customerId` is never the literal `unknown`: a request with no APIM subscription (and no `aforo-customer-id`) sends no event. Ids longer than 64 characters send no event.
- Compound and preflight no longer send `context.Subscription.Key` (the subscription secret) or `context.User.Id` as `customerId`; they use `aforo-customer-id`, else the subscription id.
- `OPTIONS` requests are not metered, checked or sent by any fragment.
- Every event carries a top-level `productType` (default `API`).
- No `X-Tenant-Id` header goes to the ingestor; the Named Value `aforo-tenant-id` is no longer referenced by `aforo-metering`, compound or preflight.
- A `tools/call` without `params._meta.agent_id` is sent under the configured product type instead of `MCP_SERVER` (which the ingestor rejects without an agent id). A body that merely contains the text `tools/call` but is not a `tools/call` request is metered as a standard call.
- `aforo-jwt-validation` needs a new Named Value, `aforo-org-service-url` (it replaces a hardcoded docker-compose hostname), and no longer casts the `validate-jwt` output variable to a string.
- Preflight applies `aforo-preflight-fallback` to a non-200 answer as well as to an error.
- MCP `metadata.productId` is empty when `aforo-mcp-product-id` is `none`.

### Fixed in the merge

- Margin guard built its URL with `context.Variables["aforo-margin-guard-url"]`, which throws when the variable is absent, and put the customer and tenant ids into the query string unescaped. It now skips when the URL is empty and escapes both ids.
- A newline inside `params._meta.agent_id` is stripped, so a caller cannot shift the tool name that is billed.
- Line comments (`//`) inside attribute expressions are block comments now: an XML parser folds the line breaks of an attribute value into spaces, which would comment out the rest of the expression.

### Unchanged

- `idempotencyKey` = the APIM request id (`mcp:<request id>:<toolName>` for MCP), compound `correlationId` = the APIM request id. Same shape in both lines; computed once per request, no clock.
- No retry: `send-one-way-request` reports no failure and `send-request` would delay the client response.


## [2.1.0] — 2026-10-01

### Added
- Named Value `aforo-product-type` (default `API`; `none` = `API`), resolved once by `aforo-context` into the variable `aforo-product-type` (a per-API `set-variable` before `aforo-context` overrides it). Every metering and compound event now carries the `productType` the ingestor requires in production. **Breaking**: the Named Value must exist.

### Fixed (product type)
- MCP `tools/call` without `params._meta.agent_id` was sent as `MCP_SERVER` with an empty `agentId`, which the ingestor rejects. It is now `MCP_SERVER` only when both tool name and agent id are present, otherwise the configured type. Configured types whose required fields a gateway cannot supply are not metered (traced) rather than sent invalid.

Brings the fragments in line with Azure's policy-fragment rules and the ingestor contract. **Breaking**: new required fragment `aforo-context` and new Named Values (`aforo-default-metric`, `aforo-metric-mappings`, `aforo-subscription-customer-map`, `aforo-org-service-url`); compound path Named Values change format. None of this has been run on a live APIM instance.

### Fixed
- Docs: the example ingestor URL is now `https://api.aforo.ai/v1/ingest/batch`. `ingest.aforo.ai` is CloudFront in front of S3: a POST gets a 301 from AmazonS3 and never reaches the ingestor.
- **Auth**: every fragment sent `Authorization: Bearer {{aforo-api-key}}`, which the ingestor never reads (and rejects 401). Now `X-API-Key` alone; `X-Tenant-Id` is no longer sent to the ingestor (tenant comes from the key).
- **Customer identity**: metering sent `context.Subscription.Id` or the literal `"unknown"`; compound and preflight sent `context.Subscription.Key` — the subscription **secret** — as `customerId`. The new `aforo-context` fragment resolves the JWT `customer_id` claim, else an admin-maintained `aforo-subscription-customer-map`; requests with no customer (or > 64 chars) are not metered.
- **Metric**: `{method} {path}` / `{method} {UrlTemplate}` is never a catalog metric, so every event was rejected. Replaced by `aforo-metric-mappings` (EXACT/PREFIX/CONTAINS) + `aforo-default-metric`.
- **Named Values**: compound, preflight and margin-guard read Named Values through `context.Variables`, where they never exist (margin-guard's `context.Variables["aforo-margin-guard-url"]` indexer threw). Now `{{name}}` syntax.
- **Fragment structure**: five fragments wrapped their policies in `<inbound>`/`<outbound>`, which Microsoft's documentation says a fragment cannot contain; `mcp-policy-fragment.xml` included another fragment, which is also not allowed — it is removed (MCP detection is in `outbound-policy.xml`). Where each fragment is included is now documented in the README.
- **Compound**: operator-precedence bug `token != null && A || B` (null dereference on a missing path); `correlationId` is now `context.RequestId` (stable) instead of a fresh GUID.
- **OPTIONS** (CORS preflight) is not metered; idempotency key is `context.RequestId` (was `RequestId:Ticks`, unique per send so nothing could deduplicate).
- **MCP**: the request body is captured in `<inbound>` (by `aforo-context`) — it is not readable in `<outbound>` otherwise.
- **JWT**: org-service URL was hardcoded to `http://org-service:8086`; now `aforo-org-service-url`. The payload decode cast the `validate-jwt` output variable (a `Jwt` object) to `string`, which throws; it now decodes the verified Authorization header.


## [2.0.0] — 2026-06-29

Initial public distribution packaging for the Azure APIM policy — README, user guide, and a `VERSION` file pinned to the monorepo's 2.0.0 line.

The policy itself shipped under the monorepo's **v2.0.0 — 2026-04-23 security release** (tenant-ID IDOR fixes). For Azure APIM specifically that release:

- Rewrote identity sourcing in `margin-guard-policy-fragment.xml` (lines 21–22): `mgCustomerId` = JWT `customer_id`/`sub` claim → APIM subscription ID fallback; `mgTenantId` = JWT `tenant_id` claim → admin-pinned `aforo-tenant-id` Named Value. **No policy reads `X-Customer-Id` / `X-Tenant-Id` from a request.**
- Required `jwt-validation-policy.xml` to be applied in `<inbound>` before any metering / margin-guard policy.

This documentation pass adds the README + user guide + version file; it did not change any policy logic.
