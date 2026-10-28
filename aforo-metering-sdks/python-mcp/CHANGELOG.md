# Changelog

All notable changes to `aforo-mcp-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [2.0.0] - 2026-10-26

**Breaking.** Read "Who is billed" in the README before upgrading.

### Changed
- **The billed customer is no longer the `agent_id`.** `customerId` comes from a `customer_resolver(call)` you pass (on the client or on `wrap_tool_handler`), which receives a `ToolCall` (`name`, `arguments`, `kwargs`, `meta`). `trust_customer_header=True` bills the `customer_id` kwarg / `_meta.customer_id` the MCP client sends instead. With neither, `wrap_tool_handler` raises `ValueError`. `agentId` is still the `agent_id` kwarg; a new `agent_resolver(call)` covers calls without one.
- **No `"unknown"` fallback.** A call with no customer or no agent still runs, but its event is dropped with reason `invalid` and counted. Before, it was billed to `"unknown"`.
- `record_tool_invocation(...)` takes `customer_id=` (keyword).
- **Sending.** One background thread sends batches over one pooled `httpx` connection, one request at a time, starting at construction; `start()` does nothing now. The old per-batch `asyncio` task and the 3-attempt retry are gone. Outages (network errors, timeouts, 408, 429, 5xx, 401, 403) are retried with jittered backoff and a circuit breaker and the events stay queued; `Retry-After` is read as seconds or an HTTP date and capped at 60 s; 413 splits the batch.
- `flush_count` default 50 → 500. The queue is bounded by `max_queue_size` (10 000); the oldest events are dropped with reason `overflow` when it is full.
- `flush()` and `shutdown()` run in a worker thread so they never block the event loop. `shutdown()` stops after `shutdown_timeout_sec` (5 s) and reports what is left as `shutdown`. `flush()` returns the number of events still queued.
- `ingestor_url` must be `https://` (plain `http://` only for localhost, or with `allow_insecure_http=True`). The API key is never in `repr()` or logs.
- Field limits are counted in UTF-16 code units, as the ingestor counts them. `customer_id` over 64 is dropped as `invalid`.
- Drop reasons are `overflow`, `rejected`, `invalid`, `shutdown`, `closed`. `retry_exhausted` no longer happens.
- `httpx` is a required dependency; the `urllib` fallback is gone. The `aiohttp` / `httpx` extras are kept and empty.

### Added
- `shutdown_sync()`, `max_queue_size`, `timeout_sec`, `shutdown_timeout_sec`, `allow_insecure_http`, `http_transport`, `transport_options`.
- An exit hook sends queued events at interpreter exit, and a forked child gets its own sender.

### Changed (transport core, review 2026-10-26)
Settles the cases in `contract/TRANSPORT-SPEC.md` "Edge cases every core handles the same way". Migration: if your `on_error` hook matched on message text, branch on `error.kind` instead.
- **`on_error` gets a typed `TransportError`** with `kind` (`outage`, `auth`, `rejected`, `shutdown`, `closed`), `events`, `status` and `will_retry`. It subclasses `RuntimeError`, so existing `Exception` hooks keep working. An outage is reported once per breaker opening, and events still queued at the shutdown deadline are reported as `shutdown`.
- **The request timeout covers the whole exchange**, including reading the response body: a server that stalls or drips its answer one byte at a time is cut off at the deadline (httpx's own timeout is per read).
- **Redirects are an outage**: a 3xx is never followed (the API key must not reach another host); the batch is requeued, the breaker opens, and one ERROR names the host it pointed to.
- **Every 5xx is retried** (501, 505, ... too).
- **Per-event `retryable` errors in a 2xx** are re-sent with the same keys after the normal backoff, at most `max_retries` times, then treated as an outage. They were re-sent at once, in a tight loop. `errors[]` is authoritative even when `failed` is missing or 0.
- **Breaker pause** is `max(250 ms, random(0, min(5 min, 5 s * 2^n)))`; a per-event retry cap reached right after a 2xx does not reset `n`.
- **`flush()` while the breaker is open makes one attempt** (it returned at once).
- **Shutdown keeps retrying** with jittered backoff until `shutdown_timeout` after an outage (it stopped at the first one).
- **Nothing taken off the queue is lost unreported at shutdown**: the unsent half of a split batch, and a batch requeued just after shutdown gave up on a hung request, are reported as `shutdown`. Pending `flush()` callers always return.
- **An event that cannot be turned into JSON** (a cycle, `NaN`, an unknown object) is dropped as `invalid` when it is recorded, not when its batch is sent; it no longer goes to `on_error`.
- **A second `shutdown()`** waits for the first one and never drains again; `shutdown()` called from a hook on the sender thread no longer makes a later `shutdown()` wait 7 s.

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
