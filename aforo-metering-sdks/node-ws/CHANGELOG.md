# Changelog

All notable changes to `@aforo/ws-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- Batches are POSTed to `<ingestorUrl>/v1/ingest/batch`. `/v1/ingest/events` is the ingestor's Apigee single-event endpoint and never accepted an `{events:[...]}` batch, so no usage was being delivered. Flushes are split into requests of at most 1000 events (the ingestor's batch limit), and each event's `idempotencyKey` is minted once and re-sent unchanged on retries.
- Duration is sent as `executionDurationMs`. The ingestor has no `durationMs` field and silently discarded it.
- Connections with a blank `customerId` are not metered, and ones longer than 64 characters are skipped with `onError`, since the ingestor rejects both.
- `idempotencyKey` is tail-trimmed to the ingestor's 255-character limit (keeping the unique suffix).
- Only network errors, 408, 429 (honouring `Retry-After`, capped at 30 s) and 5xx are retried. Any other 4xx (400/401/403/422...) is dropped immediately with `onError`, including the ingestor's `errors[].message` details, instead of being retried. A 202 whose summary has `failed > 0` reports the per-event `errors[].message` through `onError`.

### Added
- `productType` option (default `WEBSOCKET_API`), sent as top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override it via `wrapServer(wss, { productType })` or `trackConnection(ws, { customerId, productType })`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoWsBilling` class with `wrapServer` (for `ws`) and `trackConnection` (for any standard WebSocket surface — Fastify-WebSocket, Socket.io, Deno, Bun).
- Two events per connection by default: `CONNECTION_OPENED` and the `CONNECTION_CLOSED` billing anchor (aggregated frames, bytes, duration). `perFrameEvents: true` adds one event per inbound/outbound frame.
- Close codes mapped to labels via the exported `WS_CLOSE_REASONS`; socket errors emit a synthetic close with `wsCloseReason: INTERNAL_ERROR`.
- Events posted to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer` + `X-Tenant-Id`; 3× exponential-backoff retry (1s/2s/4s) then `onError`.
- Defaults: `flushCount` 100, `flushIntervalMs` 3000 (tuned higher than the base SDK for high-volume WebSocket traffic).
