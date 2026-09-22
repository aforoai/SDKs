# Changelog — kong-plugin-aforo-metering

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

This plugin ships on the Aforo gateway-plugins line; the whole repo is versioned and tagged together. Entries below are the Kong-specific slice of each repo release (see the parent `aforo-gateway-plugins/CHANGELOG.md` for the cross-plugin picture).

## [Unreleased]

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
