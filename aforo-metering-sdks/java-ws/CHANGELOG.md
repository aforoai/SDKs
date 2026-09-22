# Changelog

All notable changes to `com.aforo:ws-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** events are sent to `POST <ingestorUrl>/v1/ingest/batch` as `{"events": [...]}`. `/v1/ingest/events` is a single-event Apigee-format endpoint and did not accept these batches. Flushes larger than 1000 events are split into requests of at most 1000; each slice is serialized once so retries resend the same `idempotencyKey`s.
- Connection duration is sent as `executionDurationMs` (the ingestor has no `durationMs` field, so it was being dropped). `recordFrame` upper-cases `direction` / `frameType`; values outside `CLIENT_TO_SERVER|SERVER_TO_CLIENT` and `TEXT|BINARY|PING|PONG|CLOSE` go to `metadata` instead of the typed fields. `customerId` over 64 characters is rejected by `openConnection` (returns `null`).
- 4xx responses other than 408/429 are no longer retried (the same request cannot succeed); a 429 waits for `Retry-After` (seconds) before retrying. Rejections are logged with the ingestor's `errors[].message`, including partial rejections in a 2xx response.

### Added
- `Builder.productType(String)` (default `WEBSOCKET_API`) and `getProductType()`: the top-level `productType` the ingestor requires, previously hard-coded. Trimmed and uppercased; unknown values are passed through.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoWsBilling` (`AutoCloseable`) with a fluent builder and a framework-agnostic `openConnection` / `recordFrame` / `closeConnection` API drivable from Jakarta WebSocket, Spring WebSocket, Netty, or Undertow.
- In-memory per-connection aggregation of frame count, bytes, and duration; default OPEN + CLOSE events, or per-frame events via `perFrameEvents(true)`.
- Close-code → reason mapping (`NORMAL_CLOSURE` … `IDLE_TIMEOUT`); per-event fields `wsConnectionId`, `wsDirection`, `wsFrameType`, `messageCount`, `dataBytes`, `durationMs`, `wsCloseReason`.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 100-event / 3s flush, and 3× exponential retry.
