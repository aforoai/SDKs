# Changelog

All notable changes to `@aforoai/mcp-proxy` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [2.0.0] - 2026-10-26

### Fixed (transport core, review of 2026-10-26)
These come from the shared Node core (`src/transport-core/core.ts`) and follow contract/TRANSPORT-SPEC.md "Edge cases every core handles the same way".
- **The request deadline covers reading the response body.** A server that sent headers and then stalled, or dripped the body a byte at a time, held `flush()` and `shutdown()` forever; the read is now inside `timeoutMs` and the batch is retried.
- **Redirects are never followed.** Every request is sent with `redirect: 'manual'`, so the API key cannot reach the host a 3xx names. A 3xx keeps the batch queued, opens the breaker and is logged once at ERROR with the target host (never the key); fix the base URL and the queue drains without loss. `onError` gets `kind: 'outage'` with the 3xx `status`.
- **Events are serialized when tracked.** An event JSON cannot represent (a `BigInt`, a cycle, `NaN` or `Infinity` in metadata) is dropped as `invalid` and counted at track time; before, it made the whole batch fail to serialize and every event in it was lost unreported. Later changes to a tracked object are no longer sent.
- **Exit flush waits for the batch in flight.** On `beforeExit` the process stays alive (up to the shutdown deadline) until the queue and the batch being sent or retried are done. It used to exit during a retry and lose that batch.
- **Per-event `retryable` failures back off and are capped.** They are re-sent after the normal jittered backoff, at most `maxRetries` times, then treated as an outage; a 2xx that hits the cap no longer resets the breaker, so its cooldown keeps growing instead of flapping.
- **Breaker cooldown is `max(250 ms, random(0, ceiling))`** even when a small `breakerInitialMs` is configured.
- The proxy's own requests to Aforo — the heartbeat send (`IngestorClient`) and the quota check (`QuotaGuard`) — are sent with `redirect: 'manual'`, so a 3xx can never carry the API key to another host. A redirected quota check is treated as unavailable (`--quota-fail-mode` decides); a redirected heartbeat is logged at WARN.
- **Upstream POST deadline and size cap.** The SSE transport's forward of a client POST, the Streamable HTTP JSON answer and its session DELETE, wait at most `responseTimeoutMs` (default 5 minutes) — then the client gets 504 — and read at most 16 MiB of the upstream's answer — then 502. Both used to wait and buffer without a limit. A streamed (SSE) Streamable HTTP answer is bounded only up to its headers.
- **stdio with only a tokens file fails at startup** with a message saying the tokens file maps HTTP bearer tokens and stdio has none, instead of the generic "no customer source" text that pointed back at the tokens file.

### Changed (breaking)
- **A customer source is required.** The proxy refuses to start without `--customer-id` (one customer), `--auth-tokens-file` (HTTP: each bearer token billed to its customer), `aforo.customerResolver` (library) or `--trust-client-customer-id` (bill `params._meta.customer_id`). `_meta.customer_id` is ignored unless trusted; a call is never billed to its agent id. A call with no customer is forwarded and its event dropped as `invalid`. Migrate: add `--customer-id` (or `AFORO_CUSTOMER_ID`).
- **HTTP listeners require authentication** (`--auth-token`, `--auth-tokens-file`, or `--allow-unauthenticated` on a loopback host), check the Host header (421) and Origin (403), send no wildcard CORS, and cap request bodies at 4 MiB. Migrate: give clients a bearer token.
- **The stdio child no longer inherits the proxy's environment.** It gets an allowlist (`PATH`, `HOME`, locale, temp dirs, proxy and npm-cache settings) plus `--pass-env` names and the config file's `env`; `AFORO_*` is never passed. Migrate: list what your MCP server needs in `--pass-env`.
- Usage delivery moves to the shared Node transport core (`src/transport-core/`): bounded queue (`maxQueueSize`), one sender, full-jitter retries with `Retry-After` in both forms, re-queue plus breaker on outage (401/403 included) instead of dropping, shutdown deadline (`shutdownTimeoutMs`, default 3 s) with leftovers dropped as `shutdown`. `DropReason` adds `overflow`, `shutdown`, `closed`. `flushCount` defaults to 500. `IngestorClient` keeps only `sendSingle` (heartbeats); `EventBuffer` takes `baseUrl`/`apiKey`/`tenantId` instead of a client.
- The ingestor URL must be `https://` unless loopback or `--allow-insecure-http`.
- Quota pre-check: 1 s deadline (`--quota-timeout-ms`, was 50 ms), ALLOW answers reused for 1 s, `--quota-fail-mode closed` refuses calls the check cannot answer.
- The SSE transport gives each connection its own session; a POST to an endpoint no open connection owns gets 404.
- `--port`/`--host` no longer override a config file's `listen` block when not given; CLI fields left unset no longer blank config-file values.

### Added
- `--arg <value>`, repeatable: one child argument per flag, passed unchanged, so an argument can contain a comma. `--args a,b,c` still works. Precedence: `--arg` > `--args` > the config file's `args`; both CLI forms together use `--arg` and log a warning.
- JSON-RPC batches: every `tools/call` in a batch is metered and quota-checked; refused calls are removed and answered by the proxy (merged into the HTTP answer).
- Caps: at most 10 000 calls waiting for a response (oldest metered as `TIMEOUT`), 10 000 sessions (idle ones expire after an hour), 10 000 entries per quota cache.
- `--health-file` / `AFORO_HEALTH_FILE`: rewritten every 10 s while serving, removed on shutdown. The Docker image runs as `node` and its health check tests that file is fresh.
- `BaseProxy.stop()` (shut down without exiting) and `handleSignals: false` for embedding.
- Tests for SseProxy and StreamableHttpProxy, and integration tests against the repo's mock ingestor.

### Fixed
- Client messages on stdio are handled in order; a quota check no longer lets a later message overtake an earlier `tools/call`.
- SSE/Streamable HTTP responses split across network chunks are reassembled before metering; the upstream SSE request is closed when the client disconnects.
- A throwing `onDrop` is logged instead of silently swallowed.

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
