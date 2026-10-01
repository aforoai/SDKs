# Changelog

All notable changes to `aforo-mcp-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [1.3.2] - 2026-10-01

### Changed
- **An over-long tool name is truncated, not dropped.** `toolName` is the name from the client's `tools/call` request, whether `wrap_tool_handler` reads it or your code passes it to `record_tool_invocation`. A name longer than the ingestor's 64-character limit (counted in UTF-16 code units; a surrogate pair is never split) is cut to 64 and the call is still metered; before, the event was dropped with reason `invalid`. One WARNING is logged per client.
- **Idempotency key.** The key is built from the full, untruncated tool name. A key that fits in 255 characters is unchanged. When it would not fit, the tool name is replaced in the key by its SHA-256 hex digest, so the key is the same for the same input and differs for different inputs; before, such a key was sent over-long and the ingestor rejected the event.

### Unchanged
- `agent_id` (sent as `agentId` and `customerId`) and `session_id` are never truncated: an `agent_id` over 36 or a `session_id` over 64 characters still drops the event with reason `invalid`, as does a blank tool name.

## [1.3.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` and `killedSessionIds` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent and a server-side session kill was ignored. A bare (unwrapped) body is still accepted.

## [1.3.0] - 2026-10-01

Merge of the public repository's fixes with the working repository's 1.2.1.

### Changed
- **Auth:** the API key is sent as `X-API-Key`; no `Authorization` header is sent. Docs and examples use `https://api.aforo.ai`.
- **Session heartbeats** have quantity 1, top-level `sessionId` / `productType` / `sessionBoundary`, a unique idempotency key, and are each POSTed alone as `{"events": [hb]}` — never through the usage buffer. One attempt, best-effort; a failed heartbeat is not counted in `dropped_count`. `start_session(session_id, product_type=None, customer_id=None)`; `killedSessionIds` in a heartbeat or batch response stops the session and fires `on_session_killed`.
- **Transport:** 408 and 429 are retried (429 honours `Retry-After`); other 4xx drop the batch with reason `rejected`, and `on_error` includes the ingestor's `errors[].message`. Events rejected individually in a `202` are dropped with reason `rejected` (only those the response names by index are passed to `on_drop`).
- `flush_count` is clamped to 1..1000 and a flush holding more than 1000 events is sent in slices of 1000.
- `occurredAt` is a millisecond ISO-8601 instant with `Z`.
- `metadata.sdkVersion` is the package version on every event (tool invocations read `1.0.0` before).

### Added
- `product_type` option (default `MCP_SERVER`) and per-call override (`product_type` handler kwarg, `record_tool_invocation(..., product_type=...)`).
- Drop reason **`invalid`**: an invocation with a blank tool name, `tool_name` over 64 chars, `agent_id` over 36 chars or `session_id` over 64 chars is not buffered or sent; it is counted in `dropped_count`, WARN-logged and passed to `on_drop(events, "invalid")`. Nothing is truncated and nothing is raised.
- `record_tool_invocation` trims and upper-cases `execution_status`; a value outside the 11 canonical statuses is logged and left off (the event is still sent).

### Unchanged from 1.2.1
- Status derivation (`isError: true` → `ERROR`, timeouts → `TIMEOUT`, `CancelledError` / `KeyboardInterrupt` / `SystemExit` → `CANCELLED`), `status_resolver`, sync-handler support, `on_drop` / `dropped_count`, the contract test against `contract/ingest-contract.json`.

## [1.2.1] - 2026-09-30

- A status-resolver value outside the 11 canonical statuses is logged and the derived status is sent instead.
- An async `status_resolver` is closed, logged and ignored (it was silently ignored). Sync (`def`) handlers are supported — they used to fail every call. `KeyboardInterrupt` / `SystemExit` bill as `CANCELLED`.

## [1.2.0] - 2026-09-30

- A tool result with `isError: true` is `ERROR` (was `SUCCESS`). Timeouts (`TimeoutError`, JSON-RPC `-32001`) are `TIMEOUT`. A cancelled call is `CANCELLED` (`asyncio.CancelledError` used to bill as `SUCCESS`).
- `@wrap_tool_handler(status_resolver=...)`.
- One consistent `sdkVersion`.

## [1.1.0] (working repository, 2026-07)

- Drop observability: `dropped_count`, WARN log, opt-in `on_drop(events, reason)` with reasons `retry_exhausted` / `rejected`.
- Tool-invocation idempotency keys carry a random suffix, minted once when the event is created.
- Events are POSTed to `/v1/ingest/batch` as `{"events": [...]}`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoMcpBilling` and the `@billing.wrap_tool_handler` decorator: per-call timing, `SUCCESS`/`ERROR` status, and one `mcp_server.tool_invocations` event per invocation.
- Documented session heartbeats (`start_session` / `end_session`, periodic `system.session.heartbeat`) and the server-driven `killedSessionIds` / `on_session_killed` signal.
- Full configuration reference; events deliver to `POST https://ingest.aforo.ai/v1/ingest/batch` with Bearer auth and an `X-Tenant-Id` header.

[1.0.0]: https://github.com/aforoai/SDKs/releases/tag/python-mcp-v1.0.0
