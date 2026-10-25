# Changelog — kong-plugin-aforo-metering

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

The Kong plugin has one version: the rockspec's. `handler.lua`'s `VERSION` constant carries the same number. Releases are tagged `kong-vX.Y.Z`.

## [Unreleased]

## [2.5.0] — 2026-10-25

### Added
- `jwt_jwks_uri` is implemented. The RS256 key comes from the issuer's JWKS (https only, TLS verified, 3 s timeout, 256 KiB cap) and is chosen by the token's `kid`, so organization-service can rotate its OAuth signing key without a Kong config change. The set is cached per worker for the new `jwt_jwks_cache_ttl` (default 600 s, 30–86400). A token whose `kid` is not cached refreshes the set at most once every 30 s per worker. When a refresh fails the last good set is used for up to 24 h; after that, and before the first successful fetch, tokens are rejected (401) unless `jwt_public_key` verifies them. Keys that are private, not RSA, not for signing or not RS256 are ignored. A token without a `kid` is verified only when the JWKS has exactly one key.
- `jwt_public_key` and `jwt_jwks_uri` can be set together: the static key verifies tokens the JWKS has no key for.
- Cold start: requests that arrive while a worker's first JWKS fetch is in flight wait for it (up to the 8 s fetch budget) instead of being rejected, and a worker whose first fetch failed tries again after 5 s instead of 30 s.
- The JWKS body is read in 8 KiB chunks: a `Content-Length` over 256 KiB is refused before reading, and a body without one is dropped as soon as it passes 256 KiB. The whole fetch (connect, request, body) must finish within 8 s. A fetch left marked in flight for longer (its request was aborted) no longer blocks later refreshes.
- Only RS256 keys and tokens are supported; EC (ES256) keys in the JWKS are ignored.

### Security
- A JWKS that cannot be fetched or parsed never lets a token through, `jwt_allow_unverified_signature` included. Missing-key log lines are throttled when JWKS is in use (the caller controls `kid`).

## [2.4.0] — 2026-10-24

### Security
- Revocation checks fail closed. When Redis cannot answer the jti-blocklist or client-revocation lookup (connect fails, or the GET errors or times out), the request is refused with **503** `{"error":"temporarily_unavailable","error_description":"REVOCATION_CHECK_UNAVAILABLE"}` and `Retry-After: 1`. Before, it was let through, so a revoked token or API key kept working for as long as Redis was down. organization-service already refuses (503) for the same check.

### Added
- Config `jti_redis_fail_mode` (`closed` default, `open`). `open` restores the old behaviour; each fail-open logs a warning (once per 60s) and is counted.
- Counter `aforo_metering_revocation_check_unavailable_total{check,outcome}` (when Kong's prometheus plugin is loaded) and shared-dict keys `aforo_revocation_unavailable:<check>:<outcome>` in `aforo_buffer`.

### Changed
- A GET error after a successful connect is now treated as "Redis could not answer". It used to read as "not revoked".
- **Upgrade note:** with `jwt_validation_enabled = true` and no reachable Redis (the default host is `127.0.0.1:6379`), every token carrying a `jti` or `key_id` claim now gets 503. Point `jwt_redis_host`/`jwt_redis_port` at Redis, or set `jti_redis_fail_mode = open`.

### Fixed
- Billing: idempotency keys (standard, MCP, gRPC, GraphQL, WebSocket) are built from `ngx.var.request_id` instead of the client's `X-Request-Id` / `X-Kong-Request-Id` / `Sec-WebSocket-Key`. A caller repeating one header value was billed once for many calls. The client's `X-Request-Id` is still sent as `trace.xRequestId`. New drop reason `no_request_identity` (not expected to fire). `compound-metering.lua` seeds `correlationId` from `ngx.var.request_id` only.
- Flush comment: Bearer `sk_` keys are accepted by the ingestor (aforo-common 1.3.84+); the plugin still sends `X-API-Key`.

## [2.3.0] — 2026-10-15

### Added
- `AI_AGENT` metering. A route with `product_type = AI_AGENT` now sends events: `agentId` comes from the upstream **response** header `agent_id_header` (default `X-Aforo-Agent-Id`) or, failing that, the new per-route `agent_id`; `sessionId` from the response header `session_id_header` (default `X-Aforo-Session-Id`). Before, every AI_AGENT event was skipped, because nothing could supply those fields.
- Config: `agent_id`, `agent_id_header`, `session_id_header`.
- MCP events take `sessionId` from `session_id_header` when the request has no `Mcp-Session-Id`.

### Changed
- MCP `agentId` precedence: `agent_id_header` response header, then `agent_id`, then the payload's `params._meta.agent_id`.
- An MCP `tools/call` with no agent id is metered as a plain request (configured `product_type` and metric). It was sent as `mcp_server.tool_invocations` under the configured type, a metric/type mismatch.
- A traced request on an `AI_AGENT` route stays `AI_AGENT` (with `traceId`); only other routes become `AGENTIC_API`.

### Security
- MCP `agentId` is no longer read from the `X-Agent-Id` request header. The header is client-settable, so a caller could attribute tool calls (and agent budgets, limits and analytics) to any agent. Apigee closed the same fallback in 2026-04 (IDOR finding #11). Agent and session ids are never read from request headers.

## [2.2.0] — 2026-10-02

Merges two lines that had diverged since 2026-06-29: the public 2.1.0 release (Gowtham and Eswar) and the internal handler line 1.4.0–1.4.4. Every config key of either line is still accepted.

### Version
- One version from here on. The internal `handler.lua` `VERSION` 1.4.4 is retired; the constant is now `2.2.0`, equal to the rockspec.
- One rockspec, `kong-plugin-aforo-metering-2.2.0-1.rockspec`, listing all six modules. `2.0.4-1` and `2.1.0-1` are removed.

### From the internal line (new to 2.1.0 users)
- `customer_id_jwt_claim` + `customer_id_jwt_exclude_claims`: customer from a claim of the JWT Kong's `jwt` plugin verified.
- `executionStatus` on every event from the shared status table, `status_outcomes` overrides, gRPC `grpc-status` mapping.
- `grpc_enabled`, `graphql_enabled`, `websocket_enabled` detection (off by default).
- AGENTIC_API classification when a trace id is present.
- Drop counters (`aforo_dropped:<reason>`, optional Prometheus counter).
- Idempotency keys never contain a clock. The 2.1.0 MCP key ended in `ngx.now()`.

### From 2.1.0 (new to internal-line users)
- In-plugin RS256 verification through `resty.openssl`, fail-closed. The internal line returned "valid" when `lua-resty-jwt` or `jwt_public_key` was missing.
- `metric_mappings`, `mappings_url`, `default_metric`, `metric_header`, `quantity_header`.
- Atomic shared-dict list buffer; batches of at most 1000; transient failures re-buffered; permanent 4xx dropped; `Retry-After` honoured on 429 (30 s cap, in the flush timer).
- CORS preflights not metered; quantity ≤ 0 skipped; per-product-type required fields.
- `preflight_quota_*` wired into the access phase; sibling modules resolve under `kong.plugins.aforo-metering.*`.

### Changed
- **Identity selection.** `customer_id_jwt_claim`, when set, is the only source. Otherwise the claim of the token this plugin verified, then the Kong consumer. 2.1.0 behaviour is unchanged for configs without `customer_id_jwt_claim`.
- **`jwt_allow_unverified_signature` no longer supplies identity.** A token let through without verification grants access only; its claims are not used for `customerId` or `keyId` unless Kong's `jwt` plugin verified the same token. A throttled warning is logged. Move to `customer_id_jwt_claim`.
- **Default metric.** Internal-line configs that left `metric_name_pattern` at `{method} {path}` now send `default_metric` (`api_calls`). Set `metric_name_pattern` to any other value to keep a pattern.
- Buffer key is `aforo:events` (a list). Events buffered under the old key at upgrade time are not sent.
- Flush timers are single-flight per kind, and a flush that leaves events behind schedules the next one.

### Security
- JWT verifier: `alg` must be `RS256` (rejects `none` and HS256 by name); `exp` must be numeric; `nbf` checked; signature checked before any claim; 8 KB token cap; a private key in `jwt_public_key` is refused; an unparseable key never falls back to the opt-out.
- Central mappings: cached per tenant, response capped at 1 MB / 5000 rules, failed fetches not repeated per request.
- Customer id longer than 64 characters is not used, from any source.

### Fixed
- A metric name that is blank or longer than 255 characters is dropped and counted (`invalid_metric`) instead of failing at the ingestor.
- Events the ingestor refuses inside an accepted batch are counted (`ingestor_rejected`) and logged with its message.
- `{path}` in `metric_name_pattern` containing `%` no longer raises.

### Deprecated
- `metric_name_pattern` default `{method} {path}` (ignored). `jwt_jwks_uri` (accepted, unused). `jwt_allow_unverified_signature` for identity.

## [2.1.0] — 2026-10-01

### Added
- `product_type` config (default `API`, trimmed + upper-cased, unknown values passed through): every event now carries the `productType` the ingestor requires in production. `compound-metering.lua` `build_compound_event` takes an optional `product_type` (default `API`).

### Fixed
- MCP `tools/call` is sent as `MCP_SERVER` only when both `toolName` and `agentId` are known; otherwise the configured `product_type` is kept, instead of an event the ingestor must reject (failing its whole batch).
- Events missing the fields their `productType` requires (`MCP_SERVER`: toolName + agentId; `AI_AGENT` agentId + sessionId and gRPC/GraphQL/WebSocket/MQTT fields, which the gateway cannot observe) and events with quantity <= 0 are skipped at the log phase rather than buffered.
- Flush honours `Retry-After` on 429 (up to 30 s; longer waits re-buffer the batch for a later flush instead of sleeping in the timer).
- USER_GUIDE no longer says the key is sent as `Authorization: Bearer`; it is sent as `X-API-Key` only.

## [2.0.0] — 2026-06-29

Initial public distribution packaging for the Kong plugin: README, user guide, and versioning, documented against the 2.0.0 security-hardened source.

This packaging documents the Kong slice of the **v2.0.0 security release (2026-04-23)** — tenant/customer-ID IDOR fixes:

- `schema.lua`: removed `"header"` and `"query_param"` from the `customer_id_source` enum. Only `"consumer"` remains; both removed sources read client-settable values and enabled billing-attribution spoofing.
- `handler.lua` `resolve_customer_id()`: rewritten to prefer the JWT-validated `customer_id` claim, then the Kong consumer identity (bound to the verified credential). Request headers and query params are never read — the `headers` argument is kept for call-site compatibility but ignored.
- `rate-limit-enforce.lua`: `PER_CUSTOMER` scope sources the customer ID from the validated JWT claims, not an `X-Customer-Id` request header; falls back to per-key scope, never to an unauthenticated source.
- `margin-guard.lua` + `preflight-quota.lua`: cache keys hardened because callers now pass JWT-validated customer IDs.
- `spec/handler_spec.lua`: added security regression tests covering the IDOR scenarios (requires busted to run).

Closes the Kong findings (1 HIGH + 3 MEDIUM) from the 2026-04-20 gateway-plugins IDOR advisory.

## [1.1.0] — 2026-04-16

- Plugin runtime line aligned with the repo-wide v1.1.0 release.

## [1.0.0] — 2026-04-01

- Initial release: log-phase metering with shared-memory batching + 3x exponential-backoff retry on flush.
- Access-phase JWT/JWKS validation and Redis-backed rate-limit enforcement (sliding window).
