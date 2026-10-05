# Changelog

All notable changes to `@aforoai/mcp-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [1.3.2] - 2026-10-01

### Changed
- **A tool name longer than 64 characters is truncated, and the event is sent** — in `wrapToolHandler` and in `recordToolInvocation()`. The name is the one the client asked for in its `tools/call` request, so dropping the event let a client avoid metering with a long name. `toolName` is cut to 64 UTF-16 code units (never splitting a surrogate pair). One WARN is logged per label name per `AforoMcpBilling` instance.
- **Idempotency key.** Still `mcp:sdk:{agentId}:{sessionId}:{toolName}:{millis}:{random}`, minted once per event from the untruncated tool name. When that is longer than 255 characters the tool name is replaced by its SHA-256 hex digest. The key was previously cut to its first 255 characters, which would have removed the suffix that keeps two calls apart; it is no longer cut. Keys of 255 characters or fewer are built exactly as before.

### Unchanged
- A blank tool name still drops the event with reason `'invalid'`.
- `agentId` (36), `customerId` (64), `sessionId` (64) — including values read from `_meta` — and `productType` (20) still drop the event when over-long.

### Added
- Export: `truncateToLimit(value, max)`.

## [1.3.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` and `killedSessionIds` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent and a server-side session kill was ignored. A bare (unwrapped) body is still accepted.

## [1.3.0] - 2026-10-01

Merge of the public-repo fixes (verified against the production ingestor) with the working repo's execution-status and drop-observability work.

### Changed
- **Auth header.** The API key is sent as `X-API-Key`; `Authorization` is no longer sent. Docs and examples use `https://api.aforo.ai`.
- **Session heartbeats.** Quantity 1, a non-blank `customerId` (the session's customer, else `"system"`), top-level `sessionId` / `productType` / `sessionBoundary` (`HEARTBEAT` / `SESSION_END`). Each heartbeat is POSTed alone as `{"events":[heartbeat]}`, once, outside the usage buffer. A failed heartbeat goes to `onError`; it is not counted in `droppedCount` and not passed to `onDrop`. `onSessionKilled` also fires from heartbeat responses.
- **Transport.** 408 and 429 are retried (`Retry-After` honoured on 429); other 4xx are not. A batch that exhausts its retries is dropped with reason `retry_exhausted`, a non-retryable 4xx with `rejected`; the server's error message is included in the report.
- A flush holding more than 1000 events is sent in requests of at most 1000; `flushCount` is capped at 1000.

### Added
- `productType` option (default `MCP_SERVER`) with a per-call override `recordToolInvocation(..., { productType })`; trimmed and upper-cased.
- `customerId` option and `_meta.customer_id`, to bill a customer other than the agent; `agentId` option for calls without `_meta.agent_id`.
- `startSession(sessionId, { customerId, productType })`.
- **Client-side validation, reported as a drop.** A tool invocation the ingestor would reject — blank `toolName`, `toolName` over 64 characters, `agentId` over 36, `customerId` over 64, `sessionId` over 64, `productType` over 20 — is not buffered and not sent. `recordToolInvocation` does not throw. The event is counted in `droppedCount`, WARN-logged (first occurrence, then every 1000th) and passed to `onDrop` with the new reason `'invalid'`.
- **Partial batch failures.** Events the ingestor rejects individually in a 2xx response (`errors[]`) are reported to `onError` and dropped with reason `'rejected'` — only those events when the response gives their indexes; otherwise the count is added to `droppedCount` and `onDrop` is not called.

### Unchanged
- Status decision (`isError: true` → `ERROR`, timeouts → `TIMEOUT`, `statusResolver`), idempotency keys (built once when the event is created, reused by every retry), and the `/v1/ingest/batch` wire shape.

## [1.2.1] - 2026-09-30

### Fixed
- An async `statusResolver` is reported to `onError`, its rejection is swallowed, and the default status is used. Before, it was ignored and a rejecting one could crash the host with an unhandled rejection. A resolver returning a value outside the 11 statuses falls back to the default.

## [1.2.0] - 2026-09-30

### Changed
- A tool result with `isError: true` is `ERROR` (was `SUCCESS`). A `TimeoutError` or JSON-RPC `-32001` is `TIMEOUT`.

### Added
- `wrapToolHandler(handler, { statusResolver })`; exports `defaultToolStatus`, `EXECUTION_STATUSES`, `ToolStatusResolver`.
- Drop observability: `droppedCount`, WARN log, opt-in `onDrop(events, reason)` with reasons `retry_exhausted` / `rejected`.

### Fixed
- Every event reports one `sdkVersion`.
- Tool-invocation idempotency keys carry a random suffix, so two calls of the same tool in the same millisecond no longer share a key.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

The SDK surface as documented at this version:

- `AforoMcpBilling` client with `wrapToolHandler`, `recordToolInvocation`, `startSession`, `endSession`, `flush`, and `shutdown`.
- Buffered/batched emit of `mcp_server.tool_invocations` events to `<ingestorUrl>/v1/ingest/batch` with `Authorization: Bearer <apiKey>` and `X-Tenant-Id`. 3-attempt exponential backoff; 4xx (except 408/429) is not retried.
- Session heartbeats (`system.session.heartbeat`, 30s default) with server-driven kill signals surfaced via `onSessionKilled`.
