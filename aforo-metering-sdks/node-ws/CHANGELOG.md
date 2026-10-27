# Changelog

All notable changes to `@aforoai/ws-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

## [2.0.0] - 2026-10-26

Breaking. Migration: give `wrapServer` a `customerResolver` (or `trustCustomerHeader: true` behind a proxy you control), use an `https://` `ingestorUrl` (or `allowInsecureHttp: true`), and call `await billing.shutdown()` from your SIGTERM handler.

### Changed (billing)
- **An outbound frame is billed only once the socket accepts it.** The `send()` wrapper counts the frame (and emits its per-frame event) in `ws`'s send callback when it reports no error, so a frame sent to a closing or broken socket is no longer billed. Before, it was counted when `send()` was called. The caller's own callback still runs with the same error. A frame accepted after the connection was reported closed is not added to the totals already sent.

### Fixed (transport core, review of 2026-10-26)
These come from the shared Node core (`src/transport-core/core.ts`) and follow contract/TRANSPORT-SPEC.md "Edge cases every core handles the same way".
- **The request deadline covers reading the response body.** A server that sent headers and then stalled, or dripped the body a byte at a time, held `flush()` and `shutdown()` forever; the read is now inside `timeoutMs` and the batch is retried.
- **Redirects are never followed.** Every request is sent with `redirect: 'manual'`, so the API key cannot reach the host a 3xx names. A 3xx keeps the batch queued, opens the breaker and is logged once at ERROR with the target host (never the key); fix the base URL and the queue drains without loss. `onError` gets `kind: 'outage'` with the 3xx `status`.
- **Events are serialized when tracked.** An event JSON cannot represent (a `BigInt`, a cycle, `NaN` or `Infinity` in metadata) is dropped as `invalid` and counted at track time; before, it made the whole batch fail to serialize and every event in it was lost unreported. Later changes to a tracked object are no longer sent.
- **Exit flush waits for the batch in flight.** On `beforeExit` the process stays alive (up to the shutdown deadline) until the queue and the batch being sent or retried are done. It used to exit during a retry and lose that batch.
- **Per-event `retryable` failures back off and are capped.** They are re-sent after the normal jittered backoff, at most `maxRetries` times, then treated as an outage; a 2xx that hits the cap no longer resets the breaker, so its cooldown keeps growing instead of flapping.
- **Breaker cooldown is `max(250 ms, random(0, ceiling))`** even when a small `breakerInitialMs` is configured.
- **CONNECTION_OPENED has its own frame type (G279, as in go-ws 2.0.0).** It is sent with `wsFrameType: "OPEN"` and metric `websocket_api.connection_opened` (it was `PING` / `websocket_api.message`). Migrate: add `websocket_api.connection_opened` to your catalog if you bill connections opened, and update anything that matched `PING` for opens.
- **Every connection gets its CONNECTION_CLOSED.** `shutdown()` bills one (`GOING_AWAY`, close code 1001, metadata `closedBy: "sdk_shutdown"`) for each connection still open, and a connection opened during or after `shutdown()` is reported as `closed` and not tracked. A second `shutdown()` returns the first call's promise.
- **The open-connection map is bounded.** A sweep closes connections with no frame for `connectionIdleTimeoutMs` (new option, default 1 hour; `ABNORMAL_CLOSURE`, close code 1006, `closedBy: "sdk_idle_timeout"`). A negative or non-numeric value throws at construction. New `openConnections` getter and `sweepIdleConnections(now?)`.

### Changed (breaking)
- **Customer identity (G265).** `wrapServer` throws unless you pass `customerResolver` (`extractCustomerId` still works as a deprecated alias) or `trustCustomerHeader: true`. A connection with no customer — a resolver that returns nothing, or a blank `customerId` to `trackConnection` — is counted as one `invalid` drop instead of being skipped silently.
- **Delivery (G266, G267, G268, G296).** Events go to a bounded queue (`maxQueueSize`, default 10 000; overflow drops the oldest) with one background sender — recording an event never starts a request. Every request has a total deadline (`AbortSignal.timeout`, `timeoutMs`). Retries use full jitter and honour `Retry-After` in both forms (capped at 60 s). After the retries, or on 401/403, the batch is requeued with its keys behind a breaker instead of being dropped; `retry_exhausted` is no longer produced. New drop reasons `overflow`, `shutdown`, `closed`.
- **Defaults (G269).** `flushCount` 500 (was 100), `flushIntervalMs` 5000 (was 3000).
- **https required (G270).** `ingestorUrl` must be `https://` except for localhost; the API key is held only by the transport and never shown by `inspect()` / `JSON.stringify`.
- **One closing event per connection (G297).** A socket `error` followed by `close` is billed once.
- `shutdown()` is bounded by `shutdownTimeoutMs`; events still queued then are dropped with reason `shutdown` and reported through `onError`.

### Fixed
- **`ws.send(data, options, cb)` lost the callback.** The metering wrapper accepted `(data, cb)` only, so the caller's callback in the third position was never called. Every argument is now passed through to `ws`.

### Added
- `onError` receives a `CoreTransportError` (still an `Error`) for delivery reports: branch on `err.kind` — `outage`, `auth` (401/403, wrong or revoked key), `rejected`, `shutdown`, `closed` — and read `err.events` instead of matching the message. Exported from the package.
- Shared Node transport core in `src/transport-core/` (copied from `node/`, G271).
- `flush()`, `queuedCount`, and the options `allowInsecureHttp`, `maxQueueSize`, `maxRetries`, `timeoutMs`, `shutdownTimeoutMs`, `flushOnExit`. `User-Agent: aforo-ws-metering/<version>`.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

Merge of the public-repo fixes (verified against the production ingestor) with the working-repo line (execution status, drop observability, contract tests).

### Changed
- **Breaking (fix):** the API key is sent as `X-API-Key`. `Authorization` is no longer sent — the ingestor accepts `X-API-Key` for every key, while Bearer only works for `sk_live_` / `sk_test_` keys.
- Docs, examples and tests use `https://api.aforo.ai`.
- Events get a top-level `productType` (default `WEBSOCKET_API`; client option `productType`, per server `wrapServer(wss, { productType })`, per socket `trackConnection(ws, { productType })`), trimmed and upper-cased.
- The duration field is sent as `executionDurationMs`, the name the ingestor reads. It was sent as `durationMs`, which the ingestor ignored.
- An event the ingestor would refuse is dropped before it is buffered, with drop reason `invalid`: `customerId` over 64 characters or `productType` over 20. Nothing is thrown into the socket handlers.
- The SDK-generated `idempotencyKey` stays within 255 characters (tail kept). It is still minted once, when the event is created.
- A flush is split into requests of at most 1000 events, the ingestor's batch limit.
- Only network errors, 408, 429 (honouring `Retry-After`, capped at 30 s) and 5xx are retried. Any other 4xx is not retried: the batch is dropped with reason `rejected` and `onError` carries the ingestor's `errors[].message`.
- A 2xx response with `failed > 0` is reported through `onError`; the events its `errors[]` names by index are dropped with reason `rejected` (counted only, when no usable index is given).
- New drop reason `invalid` on `onDrop` / `droppedCount` for events that fail a client-side check. The warning is logged for the first occurrence per field and every 1000th after.
- A throwing `onError` hook can no longer make a delivered batch look like a network failure and be re-sent.
- `package.json` license is `Apache-2.0`.

## [1.1.1] - 2026-09-30

- A caller `executionStatus` outside the 11 accepted values (or a Promise from an async resolver) is reported through `onError` and left off the event; the event is still sent.
- The connection-level `executionStatus` is set on the closing event only (`CONNECTION_CLOSED`, or the synthetic close on a socket error). It used to be stamped on the open event and every frame.

## [1.1.0] - 2026-09-30

- Optional `executionStatus` (`wrapServer` / `trackConnection` option: a string or a synchronous function). Never derived by the SDK.
- Shipped earlier in 2026-07 without a version bump: `droppedCount` and the opt-in `onDrop(events, reason)` hook (reasons `retry_exhausted`, `rejected`); batches POSTed to `/v1/ingest/batch` (they went to `/v1/ingest/events`, a single-event endpoint, and every flush was refused); a contract test that checks the wire request against `contract/ingest-contract.json`; `onError` fires once, not twice, when retries are exhausted on a network error.

## [1.0.0] - 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoWsBilling` class with `wrapServer` (for `ws`) and `trackConnection` (for any standard WebSocket surface — Fastify-WebSocket, Socket.io, Deno, Bun).
- Two events per connection by default: `CONNECTION_OPENED` and the `CONNECTION_CLOSED` billing anchor (aggregated frames, bytes, duration). `perFrameEvents: true` adds one event per inbound/outbound frame.
- Close codes mapped to labels via the exported `WS_CLOSE_REASONS`; socket errors emit a synthetic close with `wsCloseReason: INTERNAL_ERROR`.
- Events posted to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer` + `X-Tenant-Id`; 3× exponential-backoff retry (1s/2s/4s) then `onError`.
- Defaults: `flushCount` 100, `flushIntervalMs` 3000 (tuned higher than the base SDK for high-volume WebSocket traffic).
