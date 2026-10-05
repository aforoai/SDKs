# Changelog — Aforo Metering MuleSoft Policy

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file. This artifact ships on the shared `aforo-gateway-plugins` monorepo tag — see the repo-root `CHANGELOG.md` for the cross-plugin release record.

## [Unreleased]

## [2.2.0] - 2026-10-02

Merge of the two lines of work on this policy: the installable Mule 4 package from the working repository and the 2.1.0 ingestor-contract fixes from the public mirror (mirror work by Gowtham and Eswar).

### From the working repository
- The policy is an installable Mule 4 package, `aforo-metering/` (`pom.xml` with packaging `mule-policy`, `aforo-metering.yaml`, `src/main/mule/template.xml`, `mule-artifact.json`). It replaces the root `mule-policy.yaml` and `template.xml`, which 2.1.0 marked as not deployable. Both files are gone.
- Customer id from `authentication.properties.claims` (MuleSoft's JWT Validation policy), with `customer-id-claim` and `tenant-id-claim`.
- `executionStatus` on every event from the shared outcome table, with `status-outcomes` overrides (last entry for a code wins).
- `exclude-status-codes` (default `401,403,429`) and `exclude-paths` (default `/health,/ready,/metrics`); a value replaces the default, `none` meters everything.
- Idempotency key minted once per request, before the flow; up to three delivery attempts send the same bytes. The MCP key has no clock in it.
- AGENTIC_API classification from `traceparent` / `x-trace-id`.
- `tests/policy.test.cjs` (178 structural checks) and the `mulesoft-policy` CI workflow that builds the jar.

### From the mirror (2.1.0), ported into the package
- `product-type`: `productType` on every event, trimmed and upper-cased, default `API`. An MCP `tools/call` is `MCP_SERVER` only when the body names an agent; otherwise it keeps the configured type.
- `occurredAt` is shifted to UTC before it is formatted with a literal `Z`.
- No event for `OPTIONS`, for a customer id over 64 characters, or for quantity 0.
- `metricName` defaults to `api_calls` instead of `{method} {path}` (`default-metric`).
- `X-API-Key` is the only credential header. The package no longer sends `X-Tenant-Id` to the ingestor.

### Added in this release
- `metric-mappings`: `KIND|value|metricName` rules separated by `;` (`EXACT`, `PREFIX`, `CONTAINS`), first match wins, then `default-metric`. Same rule format as the Azure APIM Named Value.
- `default-metric` accepts `{method}` and `{path}`.
- `quantity-source` (`request_count` / `response_size`) and `include-metadata` are policy properties. `response_size` reads the response `Content-Length`; the body is not read.
- A 408 from the ingestor is retried, like a 429 and a 5xx. Any other 4xx is logged at WARN with the response body and not retried.
- A metric name that is empty or longer than 255 characters is not sent (WARN). Other skipped requests log `not metered: <reason>` at DEBUG.
- `vars.aforo.customerId` / `vars.aforo.tenantId` (the 2.1.0 identity source) are read when the verified claims name no customer.

### Deprecated aliases
Read only when the canonical property is empty.

| Canonical | Alias (2.1.0 `template.xml` placeholder) |
|---|---|
| `product-type` | `product_type` |
| `default-metric` | `default_metric` |
| `quantity-source` | `quantity_source` |
| `include-metadata` | `include_metadata` |

`${api_key}` and `${aforo_endpoint}` have no alias: `aforo-api-key` and `aforo-endpoint` are required, so an alias could never be read.

### What a 2.1.0 or package-1.0.0 user will notice
- Package 1.0.0 sent `metricName: "GET /v1/accounts/123"`. 2.2.0 sends `api_calls`. Set `default-metric` to `{method} {path}` to keep the old name.
- Package 1.0.0 sent no `productType` on standard events. 2.2.0 sends `API` (or `product-type`).
- An MCP `tools/call` without `params._meta.agent_id` is no longer sent as `MCP_SERVER`.
- `OPTIONS` requests are no longer metered.
- The Maven version is 2.2.0 (was 1.0.0), so the jar is `aforo-metering-2.2.0-mule-policy.jar`. An Exchange that holds 1.0.0 accepts 2.2.0 as a new version.
- `Retry-After` is not read: the wait between attempts stays at one second.

### Not run
- Nothing here has been applied on a Mule runtime. `mvn clean package` assembles the jar and `tests/policy.test.cjs` checks structure; neither evaluates DataWeave. Run `tests/policy-contract.md` on a test API first.

## [2.1.0] — 2026-10-01

### Added
- `product-type` property (default `API`, trimmed + upper-cased) in `mule-policy.yaml` / `mcp-mule-policy.yaml`, and `${product_type}` in `template.xml`: every event carries the `productType` the ingestor requires in production. A `tools/call` is `MCP_SERVER` only when both `toolName` and `agentId` are present (an MCP_SERVER event without `agentId` is rejected); otherwise the configured type.

### Fixed (occurredAt)
- `occurredAt` is shifted to UTC before formatting with a literal `Z` (`template.xml` and both descriptors; the descriptors mislabelled local time as `Z`).

### Status
- Marked **NOT PRODUCTION-READY** in the README and user guide: the YAML files are not a deployable Anypoint policy format and `template.xml` uses elements that do not exist in Mule 4 policies. A rebuild as a Mule 4 custom policy (mule-policy Maven project) or Flex Gateway PDK policy is required; the README lists what it needs. No full rewrite was attempted.

### Fixed (`template.xml` only, as a correct reference for the event contract)
- Docs: the example ingestor URL is now `https://api.aforo.ai/v1/ingest/batch`. `ingest.aforo.ai` is CloudFront in front of S3: a POST gets a 301 from AmazonS3 and never reaches the ingestor.
- Authenticates with `X-API-Key` (was `Authorization: Bearer`, which the ingestor rejects 401); `X-Tenant-Id` removed — the tenant comes from the key.
- Removed the spoofable `customer_id_source = header` path (`x-customer-id` request header) and the `authentication.clientId` fallback (an Anypoint client-app id, not an Aforo customer id). `customerId` comes only from `vars.aforo.customerId` (JWT-verified).
- No event for `OPTIONS`, an empty / > 64-char customer, or quantity ≤ 0.
- `aforo_endpoint` (a full URL) was used as `host=` with port 443; it is now the request `url`.
- `metricName` is `default_metric` (default `api_calls`) instead of `{method} {path}`; `occurredAt` uses a real offset instead of a literal `'Z'` on local time; only 2xx counts as success (4xx was treated as success and silently swallowed).

### Not fixed
- The YAML descriptors define no transport (no `X-API-Key` header) and still use route-shaped metric names; they are superseded by the required rebuild.

## [2.0.0] — 2026-06-29

Initial public distribution packaging for the MuleSoft policy — README, user guide, and a `VERSION` file pinned to the monorepo's 2.0.0 line.

The policy itself shipped under the monorepo's **v2.0.0 — 2026-04-23 security release** (2 CRITICAL + 2 HIGH tenant-ID IDOR findings — the highest-severity set across the five plugins). For MuleSoft specifically that release:

- `jwt-validation-config.yaml` declares `providedCharacteristics: [aforo-jwt-validated]`; `mule-policy.yaml`, `mcp-mule-policy.yaml`, `margin-guard-policy.yaml`, and `preflight-quota-policy.yaml` declare `requiredCharacteristics: [aforo-jwt-validated]`. Anypoint API Manager now enforces policy ordering — metering cannot be applied without JWT validation first.
- The metering DataWeave transformations source `customerId` from `vars.aforo.customerId` (set by JWT validation), and **emit an empty `events` array** if the authenticated identity is missing (fail-closed on billing; the upstream request still proceeds).
- `margin-guard-policy.yaml`: scope-ID + cache key from `vars.aforo.customerId`; tenant prefers the JWT-validated var, falls back to admin-pinned configuration.
- Added `tests/policy-contract.md`: 6 black-box HTTP contract tests for fork maintainers.

This documentation pass adds the version file and rewrites README + user guide to the standard structure; it did not change any policy logic.
