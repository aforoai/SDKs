# Changelog

All notable changes to `aforo-mcp-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Fix:** session heartbeats are no longer mixed into the usage batch (they were `system.session.heartbeat` events with quantity 0, which the ingestor rejects, failing the whole batch with 400). See "Changed" for how they are sent now.
- **Fix:** a flush holding more than 1000 events is sent as several `/v1/ingest/batch` requests of at most 1000. The ingestor rejects larger batches with 400, which lost every event in them.
- **Fix:** tool-invocation `idempotencyKey`s carry a random suffix. A millisecond timestamp alone collided for two calls of the same tool in the same millisecond, and the ingestor dropped the second as a duplicate.

### Added
- `product_type` option (default `"MCP_SERVER"`) and per-call override (`product_type` handler kwarg, `record_tool_invocation(..., product_type=...)`); values are trimmed and upper-cased, unknown values passed through. Previously `productType` was hard-coded.

### Changed
- Session heartbeats are restored: `start_session(session_id, product_type=None, customer_id=None)` (or the first wrapped call carrying `session_id`) sends a heartbeat now and every `heartbeat_interval_sec`; `end_session()` stops them, flushes, and sends `SESSION_END`; `shutdown()` stops them. Each heartbeat has quantity 1, top-level `sessionId` / `productType` / `sessionBoundary`, a unique idempotency key, `customerId` = the session's customer (default `"system"`), and is POSTed alone as `{"events": [hb]}` so the ingestor always intercepts it on the synchronous path. Best-effort: one attempt, failures logged and swallowed. `killedSessionIds` in a heartbeat or batch response stops the session and fires `on_session_killed`.
- 408 and 429 are retried (429 honours `Retry-After`); other 4xx still drop the batch, and `on_error` now includes the ingestor's `errors[].message`. Per-event rejections in a 2xx response are logged.
- Invocations with a blank tool name or a `customerId` (agent id) over 64 chars are dropped via `on_error` instead of failing the batch; `toolName` is capped at 64 and `agentId` at 36 chars. `occurredAt` is a millisecond ISO-8601 instant with `Z`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoMcpBilling` and the `@billing.wrap_tool_handler` decorator: per-call timing, `SUCCESS`/`ERROR` status, and one `mcp_server.tool_invocations` event per invocation.
- Documented session heartbeats (`start_session` / `end_session`, periodic `system.session.heartbeat`) and the server-driven `killedSessionIds` / `on_session_killed` signal.
- Full configuration reference; events deliver to `POST https://ingest.aforo.ai/v1/ingest/batch` with Bearer auth and an `X-Tenant-Id` header.

[Unreleased]: https://github.com/aforoai/aforo-metering-sdks/compare/python-mcp-v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-sdks/releases/tag/python-mcp-v1.0.0
