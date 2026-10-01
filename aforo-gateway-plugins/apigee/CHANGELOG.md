# Changelog — aforo-metering (Apigee shared flow)

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

This bundle ships on the Aforo gateway-plugins line; the whole repo is versioned and tagged together. The version for this artifact lives in the top-level `VERSION` file (Apigee bundles have no manifest version field). Entries below are the Apigee-specific slice of each repo release (see the parent `aforo-gateway-plugins/CHANGELOG.md` for the cross-plugin picture).

## [Unreleased]

## [2.2.0] - 2026-10-02

Merges the 2.1.0 public release with the working line that the Aforo one-click install deploys. Every KVM entry either side read is still read. Mirror work by Gowtham and Eswar.

### From the working line
- **Bounded redelivery.** One retry (`AforoMeteringRetryGate`, `AforoMeteringSendEventRetry1`) when the first send could not connect or got a 5xx, and failed within 1.2 s. Timeouts are 1 s connect / 2 s response; the most a broken ingestor adds to an API call is about 4 s. KVM `max_retries` (`0` or `1`).
- **Delivery-failure record.** `AforoMeteringLogDeliveryFailure` prints `USAGE EVENT DROPPED` and sets `aforo.meteringDelivery*` variables.
- **`executionStatus`** on every event from the response status, with KVM `status_outcomes` overrides.
- **Default exclusions.** With no entry, 401/403/429 and `/health`, `/ready`, `/metrics` are not metered. A configured list replaces the default; `none` meters everything.
- **Apigee X.** Every KVM value is read into a `private.aforo.*` variable (Apigee X rejects anything else), the KVM reads have `continueOnError="true"`, and the flow is documented for `PostProxyFlowHook` (it cannot run in `PostClientFlow`).
- **Idempotency key** is the Apigee `messageid`, then the `x-request-id` header, then a one-time random value. No clock component. Compound `correlationId` is a UUID derived from the same identity.
- **AGENTIC_API** detection from `traceparent` / `x-trace-id`.

### From 2.1.0
- Customer identity never falls back to a credential; no identity means no event. `customer_id_source = flow_variable:<name>`.
- `metric_mappings` and `default_metric`.
- `product_type` on every event; per-type required fields.
- `OPTIONS` and quantity ≤ 0 are not metered; `quantity_source = response_size`; `include_metadata = false`.
- `X-API-Key` is the only credential header. `X-Tenant-Id` is no longer sent to the ingestor (the working line still sent it).
- JWT validation and margin guard are opt-in; the RaiseFault fix; `mcp_enabled` / `mcp_product_id` / `margin_guard_*` read from the KVM.

### Added
- A 408 from the ingestor is retried like a 5xx (inside the same 1.2 s window). A 429 is not re-sent; its `Retry-After` is recorded in `aforo.meteringDeliveryRetryAfter`.
- A 4xx drop logs the first 500 characters of the ingestor's response.
- `customer_id_source = jwt`: only the verified JWT claim.
- `metric_name_pattern` placeholders `{basepath}` and `{pathsuffix}`.
- `flow_variable:` names that hold a secret or a client IP are refused (`client_id`, `consumerkey`, `client_secret`, `apikey`, `access_token`, `client.ip`).
- A metric name that is empty or longer than 255 characters, or an MCP tool name longer than 64, is not sent.

### Behaviour changes for a 2.1.0 install
- **Customer.** With no `customer_id_source`, a call without a verified JWT claim now falls back to `developer.app.name`, then `developer.email` (the working line's source). 2.1.0 sent nothing. Set `customer_id_source` to `jwt` to keep the 2.1.0 behaviour. A configured `flow_variable:` source behaves as in 2.1.0.
- **Exclusions.** 2.1.0 excluded nothing unless configured. Now 401/403/429 and `/health`, `/ready`, `/metrics` are excluded by default. Set `exclude_status_codes` / `exclude_paths` to `none` for the 2.1.0 behaviour.
- **JWT.** `jwt_validation_enabled = true` still turns validation on. It now also turns on when `aforo_jwks_uri` is set and the flag is absent. Set `jwt_validation_enabled` to `false` to keep it off.
- **Send gate.** The send step is conditioned on `aforo.meteringSend` and `aforo.skip`. `aforo.sendEvent` and `aforo.skipReason` are still set. `aforo.eventPayload` is left unset (not `""`) when there is no event.
- **Flow variables.** KVM values are in `private.aforo.<name>`, not `aforo.<name>`. A proxy that sets `aforo.<name>` itself is still honoured when the KVM has no value.
- **Trace header.** A call with a valid `traceparent` is sent as `AGENTIC_API` when `product_type` is `API`.
- **Fallback key.** With no `messageid`, the key is the `x-request-id` header before a random value.

### Behaviour changes for a working-line install
- **Metric.** With no `metric_name_pattern` in the KVM the metric is `default_metric` / `api_calls`, not `{method} {path}`. The one-click install writes the pattern, so those installs are unchanged.
- **Path.** `endpointPath`, `{path}` and `metadata.path` are the proxy base path plus the path suffix, not the suffix alone. Use `{pathsuffix}` in the pattern for the old value.
- **No identity, no event.** An event with an empty `customerId` is no longer sent. `apiproxy.consumerkey` is no longer a customer source in the unwired compound and preflight scripts.
- **`productType`** is on every event (default `API`).
- **MCP** `tools/call` without `params._meta.agent_id` keeps the configured `productType` instead of `MCP_SERVER`.
- **`include_metadata = false`** and **`quantity_source = response_size`** now take effect.
- **Margin guard** runs only when `margin_guard_enabled` is `true`.

### Deprecated aliases
- Flow variable `aforo.sendEvent` — use `aforo.meteringSend` / `aforo.skip`.
- Non-private `aforo.<setting>` variables as the KVM target — the KVM now fills `private.aforo.<setting>`; the non-private name is read only as a per-proxy override.
- `jwt_validation_enabled` absent with `aforo_jwks_uri` set — set the flag explicitly.

No KVM key was renamed or removed.

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
