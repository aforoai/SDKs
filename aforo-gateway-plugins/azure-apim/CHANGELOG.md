# Changelog — Aforo Metering Azure APIM Policy

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file. This artifact ships on the shared `aforo-gateway-plugins` monorepo tag — see the repo-root `CHANGELOG.md` for the cross-plugin release record.

## [Unreleased]

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
