# Changelog

All notable changes to `@aforoai/mcp-proxy` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [1.2.2] - 2026-10-01

### Changed
- **A tool name longer than 64 characters is truncated, and the call is metered.** The name comes from the proxied `tools/call` message, so dropping the event let a client avoid metering with a long name. `toolName` on the event is cut to 64 UTF-16 code units (never splitting a surrogate pair). One WARN is logged per label name for the life of the proxy. The message forwarded to the MCP server is not changed.
- The idempotency key is derived from the full, untruncated tool name. It is a 32-character digest, so its length does not depend on the name.

### Unchanged
- `agentId` over 36 characters, `customerId` over 64 or `sessionId` over 64 still drop the event with reason `invalid`. The call is still forwarded.

## [1.2.1] - 2026-10-01

### Fixed
- **`--quota-enforcement` now denies.** `POST /api/v1/quota/check` answers 200 with `{success, data: {decision, ...}}`; the proxy read `decision` at the top level, never saw `DENY`, and forwarded every call. It now reads the envelope (a bare `{decision}` body is still accepted).
- A denied call gets JSON-RPC error `-32000` whose message is the server's `reason`; `error.data` carries `reason`, `currentUsage`, `limit`, `retryAfterMs` and `resetsAt`.
- The quota check asks about the customer the call is billed to (`_meta.customer_id`, then `aforo.customerId`, then the agent id). It asked about the agent id only.
- `WARN` is allowed and logged once per minute per customer and metric.
- Batch and heartbeat responses are read from the same envelope, so per-event rejections (`failed`, `errors[]`) and `killedSessionIds` are seen. They were silently ignored.

### Unchanged
- 50 ms timeout, fail-open on timeout / network error / non-200 / a body with no recognisable decision, and the 5 s deny cache.

## [1.2.0] - 2026-10-01

Merge of the public-repo fixes (verified against the production ingestor) with the working repo's execution-status work.

### Changed
- **Auth header.** The API key is sent as `X-API-Key`; `Authorization` is no longer sent. Docs and examples use `https://api.aforo.ai`.
- **Session heartbeats.** Quantity 1, a non-blank `customerId` (`aforo.customerId`, else the first tool call's customer, else `"system"`), top-level `sessionId` / `productType` / `sessionBoundary` (`HEARTBEAT` on session start and every `heartbeatIntervalMs`, `SESSION_END` on shutdown). Each heartbeat is POSTed alone as `{"events":[heartbeat]}`, once, and never enters the usage buffer. A failed heartbeat is logged; it is not a usage drop.
- **Idempotency keys.** A random UUID is mixed into each tool call's key, so two calls that re-use a JSON-RPC id in the same millisecond no longer share a key. The key is still minted once, when the call's event is created, and reused by every flush retry.
- A flush holding more than 1000 events is sent in requests of at most 1000.

### Added
- `aforo.productType` / `AFORO_PRODUCT_TYPE` (default `MCP_SERVER`), stamped top-level on every event.
- `aforo.customerId` / `AFORO_CUSTOMER_ID` and `_meta.customer_id` on `tools/call`, to bill a customer other than the agent.
- **Drop accounting.** Usage events the proxy loses are counted, WARN-logged and passed to the new library hook `aforo.onDrop(events, reason)`: `retry_exhausted` (batch failed every attempt), `rejected` (non-retryable 4xx, or events the ingestor rejected individually in a 2xx response — by index when the response gives them) and `invalid`.
- **Client-side validation, reported as a drop.** A tool call whose `toolName` (> 64 characters), `agentId` (> 36), `customerId` (> 64) or `sessionId` (> 64) the ingestor would reject is still forwarded to the MCP server; its event is not sent and is dropped with reason `invalid`, carrying the call's real status and duration.
- The server's error message is logged for a rejected batch. `DropReason` is exported.

### Unchanged
- Status decision (`isError: true` → `ERROR`, `-32001` / no response → `TIMEOUT`, shutdown → `CANCELLED`, `statusResolver`), session + JSON-RPC id call matching, the configurable response timeout, and the `/v1/ingest/batch` wire shape.

## [1.1.1] - 2026-09-30

### Fixed
- Calls are matched by session and JSON-RPC id, so two Streamable HTTP clients both using id `1` no longer overwrite each other.
- Calls still waiting at shutdown are metered once as `CANCELLED`; they were lost.
- A `statusResolver` that returns a Promise or a value outside the 11 statuses is logged and the default is used.

### Added
- Configurable response timeout: `AFORO_RESPONSE_TIMEOUT_MS`, `--response-timeout-ms`, `aforo.responseTimeoutMs`.
- Exports: `defaultToolStatus`, `EXECUTION_STATUSES`, `JsonRpcError`, `ToolStatusResolver`.

## [1.1.0] - 2026-09-30

### Changed
- A tool result with `isError: true` is `ERROR` (was `SUCCESS`). JSON-RPC `-32001` is `TIMEOUT`.
- A call with no response after 5 minutes is metered once as `TIMEOUT`; it used to be dropped unmetered.

### Added
- `aforo.statusResolver` (library use).

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

The proxy surface as documented at this version:

- `aforo-mcp-proxy` CLI with `stdio`, `sse`, and `streamable-http` transports.
- Config resolution with precedence env var > CLI flag > config file > default.
- Meters `tools/call` (tracks `tools/list` / `resources/read` / `prompts/get`; ignores protocol chatter), batched to `<ingestorUrl>/v1/ingest/batch` with `Authorization: Bearer <apiKey>` and `X-Tenant-Id`. 3-attempt backoff, then drop.
- Optional `--quota-enforcement`: pre-flight `POST /api/v1/quota/check`, 50ms budget, fail-open, 5s in-process deny cache; `DENY` returns JSON-RPC error `-32000`.
- Session heartbeats and graceful child-process shutdown (SIGTERM then SIGKILL after 2s) in stdio mode.
