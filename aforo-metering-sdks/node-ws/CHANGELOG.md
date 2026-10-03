# Changelog

All notable changes to `@aforoai/ws-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

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
