# Changelog — Aforo Metering MuleSoft Policy

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file and in `aforo-metering/pom.xml`. This artifact ships on the shared `aforo-gateway-plugins` monorepo tag — see the repo-root `CHANGELOG.md` for the cross-plugin release record.

## [Unreleased]

## [3.1.0] — 2026-10-28

Wave 6 (W6.5: G359, G361, G362). Configuration properties unchanged; see "Upgrading from 3.0.0" in the user guide. Includes the 3.0.2 fixes below. Not yet verified on a live Anypoint org.

### Changed
- **Delivery retries follow the transport spec** (`aforo-metering-sdks/contract/TRANSPORT-SPEC.md`): full-jitter backoff between attempts (base 500 ms, cap 30 s: a random 0–1 s before attempt 2, 0–2 s before attempt 3) instead of a fixed 2 s; the ingestor's `Retry-After` (delta-seconds, fractional allowed, or an HTTP date; unreadable values ignored) is used when longer, at most 60 s. The wait is an `until-successful` whose `millisBetweenRetries` the delivery script sets, so it runs on the runtime's scheduler and holds no thread. Attempts run in a `foreach` of 3.
- Per-event `retryable` from the ingestor decides what is re-sent; the "The event could not be stored" message prefix is only the fallback when the flag is absent.
- Whole-batch retry on no answer, 408, 429 and every 5xx, as the transport spec says; any other status is logged and dropped.
- A connection error or timeout on the ingest call is caught on that call (`HTTP:CONNECTIVITY`, `HTTP:TIMEOUT`) and retried like a 5xx, with the cause in the log; any other error ends the delivery at once.
- Log line `USAGE NOT DELIVERED after 3 attempts` is now `USAGE NOT DELIVERED (<reason>)`.

### Documentation
- README "Not part of this policy": JWT validation is not an Aforo MuleSoft feature (use MuleSoft's JWT Validation policy); compound metering and margin guard are not supported on MuleSoft. The installed policy calls no margin-guard or token-revocation endpoint.
- README "Delivery": one delivery per API call (a custom policy has no timer to batch calls); the per-call object store entry is in-memory retry state and the backlog count, not a durable queue; 401/403 from the ingestor lose usage; no 413 split.

## [3.0.2] — 2026-10-27

Released from the SDKs repo (aforoai/SDKs#68, commit `62165dd`) after the first live Anypoint run (CloudHub 2.0, Mule 4.13.1); organization-service bundles it. 3.1.0 includes these fixes.

### Fixed
- **Every call to Aforo failed inside the runtime.** The four `http:request`s (introspection, quota check, the two ingest flushes) stored the answer with `targetValue="#[{...}]"` next to `outputMimeType="text/plain"`; Mule could not pick an output type, the error handler recorded status 0, and the policy answered 503 on identity, failed open on quota and dropped events. Each `targetValue` now starts `output application/java ---`, and `policy.test.cjs` checks it.
- **MCP calls were never metered.** Reading the `tools/call` request body failed the same way and was swallowed. The expression names its output type, and a failed read is logged at WARN.

## [3.0.0] — 2026-10-22

The MuleSoft path rebuilt to match the Kong plugin (proven in prod) and the Apigee 3.0.0 shared flows. **Breaking**: see "Upgrading from 2.x" in the user guide. Not yet verified on a live Anypoint org.

### Source of truth
- The installable Mule 4 policy project (`aforo-metering/`: `pom.xml` with packaging `mule-policy`, `aforo-metering.yaml`, `src/main/mule/template.xml`, `mule-artifact.json`) now lives here. It existed only on the unmerged `sync/gateway-plugins-2026-10-02` branch, which organization-service's bundled 2.2.0 jar was built from.
- The 2.1.0 descriptors (`mule-policy.yaml`, `mcp-mule-policy.yaml`, `compound-metering-policy.yaml`, `margin-guard-policy.yaml`, `preflight-quota-policy.yaml`, `jwt-validation-config.yaml`) and the root `template.xml` are removed: they were never a deployable Anypoint format. They remain in git history.
- `mvn package` builds `aforo-metering-3.0.0-mule-policy.jar` from MuleSoft's public repository only (no Anypoint Exchange or EE credentials), with a fixed jar timestamp.

### Added
- **Identity by introspection** (the key is the Aforo key; Aforo pushes nothing into Anypoint):
  - the key from `key-header` (default `x-api-key`), checked with `POST {introspect-url}` `{"key"}` and the policy's own `X-API-Key`; `{"success","data"}` envelopes tolerated;
  - allowed only when `active` and `productIds` contains `aforo-product-id`; missing or inactive key 401, other product 403, JSON bodies;
  - cache by SHA-256 of the key: active 60 s (never past `expiresAt`), inactive 10 s; on introspection failure an active answer up to 900 s old, else 503 (`identity-fail-open` lets the call through unchecked and unmetered);
  - the key header is removed before the API (`propagateMessageTransformations` plus a rebuilt `HttpRequestAttributes`, as MuleSoft's `http-transform:remove-headers` does).
- **Pre-flight quota check** before `execute-next` (`quota-enabled`): `POST {quota-check-url}` `{customerId, metricName}` with `X-API-Key` and `X-Tenant-Id`, for the metric the call bills only. DENY: 429 with `Retry-After` = max(1, ceil(retryAfterMs/1000)) and `{message, retryAfter}`, upstream not called, not metered, never cached. ALLOW / WARN cached 1 s. No answer within `quota-timeout-ms` (1500): fail open, or 503 with `quota-fail-open=false`.
- **All four product types, as Kong / Apigee**: AGENTIC_API `traceId` from upstream `X-Aforo-Trace-Id`, else the gateway request id; AI_AGENT `agentId` / `sessionId` from upstream `X-Aforo-Agent-Id` / `X-Aforo-Session-Id`, `agent-id`, the product id and the request id; MCP_SERVER one event per `tools/call` (batches too), protocol messages never billed or refused, agent = upstream header else the customer, session = upstream `X-Aforo-Session-Id` else the upstream `Mcp-Session-Id` response header.
- Upstream `X-Aforo-Quantity` (`quantity-header`) and `X-Aforo-Metric`.
- `metric-mappings` as Kong's JSON `[{pathPattern, method, metricName}]` with Lua patterns; `status-outcomes` as JSON (CSV still read).
- **Delivery** reads the 202 body: events reported "The event could not be stored…" are re-sent, any other per-event error is logged and dropped; no answer, 5xx, 408, 429 re-send the batch; 3 attempts. At most 16 deliveries at once and 1000 calls waiting per policy instance.
- An API error (APIkit 404, 5xx) is metered too, and its response reaches the client unchanged.
- Repeating warnings are logged once a minute.
- Tests: `tests/dataweave.test.cjs` runs the template's DataWeave scripts under the open-source DataWeave CLI against `tests/fixtures/` (166 cases); `tests/policy.test.cjs` checks the package, the definition ↔ template contract, the flow order and the outbound calls. `tests/policy-contract.md` is the live checklist.

### Fixed
- **No events with Aforo keys**: 2.2.0 read the customer only from `authentication.properties.claims[customer_id]` / `sub` (a JWT), so with Aforo keys it emitted nothing.
- **AI_AGENT**: events had no `agentId` / `sessionId` and were all rejected.
- **AGENTIC_API**: the trace came from the client's `traceparent`, and a trace header turned API calls into AGENTIC_API.
- **MCP**: the agent came from the client's body and the session from the request; batches were not parsed; `initialize` / `tools/list` were billed; the metric was hard-coded.
- **Pre-flight**: there was none in the template (`preflight-quota-policy.yaml` was an unwired spec).
- **Delivery**: the 202's `data.errors` was ignored and nothing bounded concurrent deliveries.
- Product type, metric and quota are per API instance (the product it sells), from the policy configuration.
- Policy properties reach DataWeave as data, never as source text: a JSON value with quotes broke the 2.x scripts.

### Removed
- `customer-id-claim`, `tenant-id-claim`, `mcp-enabled`, `mcp-product-id`, `quantity-source`, `include-metadata` and the deprecated 2.1.0 aliases.

### Known differences from Kong / Apigee
- No `X-RateLimit-Warning` header on a quota WARN; no JSON-RPC error detection in MCP answers (status only); no `response_size` quantity.

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
