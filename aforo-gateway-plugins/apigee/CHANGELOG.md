# Changelog — aforo-metering (Apigee shared flow)

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

This bundle ships on the Aforo gateway-plugins line; the whole repo is versioned and tagged together. The version for this artifact lives in the top-level `VERSION` file (Apigee bundles have no manifest version field). Entries below are the Apigee-specific slice of each repo release (see the parent `aforo-gateway-plugins/CHANGELOG.md` for the cross-plugin picture).

## [Unreleased]

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
