# Changelog — aforo-metering (Apigee shared flow)

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

This bundle ships on the Aforo gateway-plugins line; the whole repo is versioned and tagged together. The version for this artifact lives in the top-level `VERSION` file (Apigee bundles have no manifest version field). Entries below are the Apigee-specific slice of each repo release (see the parent `aforo-gateway-plugins/CHANGELOG.md` for the cross-plugin picture).

## [Unreleased]

## [3.0.0] — 2026-10-21

The Apigee path rebuilt to match the Kong plugin. There are now two shared flows: `aforo-access` (new, PreProxyFlowHook) and `aforo-metering` (PostProxyFlowHook). This repo is again the single source of truth; it starts from org-service's newer bundled copy (aforo-gateway-plugins@04f5165) and the unmerged `sync/gateway-plugins-2026-10-02` work. **Breaking**: see "Upgrading from 2.x" in the user guide. Not yet verified on a live Apigee org.

### Added
- **`aforo-access`** (`aforo-access/sharedflowbundle/`), for the PreProxyFlowHook:
  - Runs only on proxies the KVM marks `managed_proxy__{proxy}`.
  - VerifyAPIKey on header `x-api-key`, header `apikey` or query `apikey`, with Apigee's standard 401. The key is stripped before the upstream, as Kong's `hide_credentials` does.
  - The customer comes from the verified app's (else developer's) `aforo_customer_id` attribute.
  - Per-API-product settings come from `{setting}__{apiproduct.name}` KVM keys.
  - Pre-flight quota check on the metric the call bills to:
    - 1500 ms timeout, fail-open (503 with `quota_fail_open=false`)
    - ALLOW/WARN cached 1 s, DENY never cached
    - 429 with `Retry-After` and a JSON body
    - MCP: only `tools/call` is checked
- `aforo-billing.js`: the rules both flows share (metric resolution, MCP parsing, exclusions, the status table). One copy in each bundle; the tests keep the two identical.
- Per product type, as Kong:
  - AGENTIC_API `traceId`: upstream `X-Aforo-Trace-Id`, else `messageid`.
  - AI_AGENT `agentId`: `X-Aforo-Agent-Id`, else `agent_id__{p}`, else the proxy name. `sessionId`: `X-Aforo-Session-Id`, else `messageid`.
  - MCP_SERVER: one event per `tools/call`, batches included. `agentId`: the upstream's, else the customer. Session: the upstream `Mcp-Session-Id`.
- Upstream `X-Aforo-Quantity` (`quantity_header__{p}`) and `X-Aforo-Metric`.
- `delivery_mode`: `async` (default, ServiceCallout without `<Response>`: the client never waits) or `sync` (waits for the 202, re-sends the events it reports as "could not be stored" once, logs the rest).
- Metering upstream 4xx/5xx through a FlowCallout in the proxy's DefaultFaultRule; refused calls are never billed.
- Tests:
  - static bundle checks
  - unit tests
  - end-to-end flow tests in a Node model of the Apigee runtime
  - CI job `apigee`

### Fixed
- **Customer** came from `developer.app.name` / `developer.email` (Apigee names, not Aforo ids). It now comes only from the `aforo_customer_id` attribute.
- **JWT**: `AforoJwtValidation` had an `<OutputClaims>` element (not part of VerifyJWT) and a `<URI>` child under `<JWKS>`, so no claim was ever copied. It now uses `<JWKS uriRef>`, then copies `jwt.AforoJwtValidation.decoded.claim.*`. It also moved to the request path, with a tenant binding.
- **Metric**: no `{method} {path}` names. `metric_mappings__{p}` uses Kong's Lua patterns, then the product's `default_metric__{p}`. MCP tool calls bill to the product's metric, not a hard-coded one.
- **AGENTIC_API**: a client `traceparent` named the trace and turned API calls into AGENTIC_API.
- **AI_AGENT**: every event was skipped (no agent), and the session came from a client header.
- **MCP**:
  - `agentId` came from the client's body
  - batches were not parsed
  - `initialize` / `tools/list` were billed
- **Quantity**: `response_size` billed chunked responses as 0.
- **Delivery**: the send held every response and the 202's per-event errors were ignored. Now `async` by default, or `sync` with per-event handling.
- **Pre-flight**: `aforo-preflight-quota.js` was wired to nothing, and from the PostProxyFlowHook it could not have blocked anyway.

### Removed
- Margin guard, from the Apigee flows: it ran after the upstream had served the call and called an internal pricing endpoint.
- The unwired `aforo-compound-metering.js`, `aforo-jwt-jti-check.js` and `aforo-preflight-quota.js`.
- Global `product_type`, `default_metric`, `metric_mappings`, `metric_name_pattern`, `customer_id_source`, `mcp_enabled`, `mcp_product_id`.

## [2.1.0] — 2026-10-01

### Added
- Fallback idempotency key when Apigee supplies no `messageid`: `messageid` is still the key (unique per request, stable across a retried ingest POST, so retries deduplicate), but the fallback is now unique per event instead of `'apigee-' + Date.now()` / an empty `requestId` segment. Two distinct requests sharing one key would make the ingestor answer DUPLICATE and silently drop the second, under-billing the caller.
- KVM key `product_type` (default `API`, trimmed + upper-cased, unknown values passed through): every event now carries the `productType` the ingestor requires in production. The (unwired) compound builder sets it too.

### Fixed (product type)
- An MCP `tools/call` without `params._meta.agent_id` was sent as `MCP_SERVER` with an empty `agentId`, which the ingestor rejects. It is now `MCP_SERVER` only when both `toolName` and `agentId` are present, otherwise the configured type. Events missing the fields their `productType` requires are not sent (`aforo.skipReason` names the fields).

Brings the shared flow in line with the ingestor contract. **Breaking**: `default_metric` is required, customer identity no longer falls back to the developer app, and JWT validation is now opt-in. Not verified on a live Apigee org.

### Fixed
- Docs: the example ingestor URL is now `https://api.aforo.ai/v1/ingest/batch`. `ingest.aforo.ai` is CloudFront in front of S3: a POST gets a 301 from AmazonS3 and never reaches the ingestor.
- **Auth**: the ServiceCallout sent `Authorization: Bearer {api_key}` + `X-Tenant-Id`; the ingestor reads only `X-API-Key` (and rejects Bearer with 401). Now `X-API-Key` alone, from a `private.` variable so it is masked in Debug.
- **Customer**: `customerId` was `developer.app.name` / `developer.email` / `''` — Apigee names, not Aforo customer ids, and empty ones were sent anyway. Now the verified JWT `customer_id` (`aforo.customer_id`), else the newly implemented `customer_id_source = flow_variable:<name>` (client-controlled variables refused); nothing is sent without one or when it exceeds 64 chars.
- **Metric**: `{method} {path}` default replaced by `metric_mappings` (EXACT/PREFIX/CONTAINS JSON) + `default_metric`; the pattern applies only if set.
- **Skips**: `OPTIONS`, `exclude_paths` and `exclude_status_codes` (read but previously unused), and quantity ≤ 0. The send step is conditioned on `aforo.sendEvent`.
- **quantity_source = response_size** is implemented (was read but ignored).
- **JWT**: `AforoJwtValidation` had no condition, so every request without an Aforo JWT got 401. The three JWT steps now run only when `jwt_validation_enabled = true`.
- **Margin guard**: read `aforo.marginGuardEnabled`, `aforo.marginGuardUrl` and `aforo.customerId`, none of which anything set — it could never run. The KVM now loads `margin_guard_enabled`/`margin_guard_url`, the JS uses the JWT customer/tenant, and the step is conditioned. The RaiseFault used a `? :` ternary in a message template (invalid) and a `<Condition>` element RaiseFault does not have; the header value is now set by the JS and the condition moved to the Step.
- **MCP**: `mcp_enabled` / `mcp_product_id` are now loaded from the KVM; MCP idempotency key no longer includes `Date.now()`.
- Bundle manifest lists all policies and JS resources the flow uses.
- `aforo-compound-metering.js` / `aforo-preflight-quota.js`: removed the `apiproxy.consumerkey` (the caller's API key) customer fallback. Removed the unreferenced duplicate `aforo-mcp-metering.js`.

### Docs
- KVM is organization-scoped (the docs created entries with `--env`, which the policy never reads).

## [2.0.0] — 2026-06-29

Initial public distribution packaging for the Apigee shared flow: README, user guide, and a top-level `VERSION` file, documented against the 2.0.0 security-hardened source.

This packaging documents the Apigee slice of the **v2.0.0 security release (2026-04-23)** — tenant/customer-ID IDOR fix:

- `resources/jsc/aforo-metering.js`: removed the `request.header.X-Agent-Id` fallback. `agentId` is now sourced exclusively from the JSON-RPC payload's `params._meta.agent_id`; the header is client-settable and was a billing-attribution spoof vector.
- `resources/jsc/aforo-mcp-metering.js`: same fix for the MCP-only variant.
- `tests/unit-tests.cjs`: test harness rewritten (was broken under the ESM-module workspace root) and 2 security regression tests added; all 15 tests pass.

Closes the Apigee finding (1 MEDIUM) from the 2026-04-20 gateway-plugins IDOR advisory.

## [1.1.0] — 2026-04-16

- Bundle aligned with the repo-wide v1.1.0 release.

## [1.0.0] — 2026-04-01

- Initial release: `PostClientFlow` metering via a JavaScript policy + `ServiceCallout` send, with config read from the org-scoped `aforo-metering-config` KVM.
- Optional JWT/JWKS validation steps (`AforoJwtReadConfig` → `AforoJwtValidation` → `AforoJwtAssignHeaders`) ahead of metering.
