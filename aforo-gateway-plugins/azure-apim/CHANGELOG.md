# Changelog — Aforo Metering Azure APIM Policy

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file. This artifact ships on the shared `aforo-gateway-plugins` monorepo tag — see the repo-root `CHANGELOG.md` for the cross-plugin release record.

## [Unreleased]

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
