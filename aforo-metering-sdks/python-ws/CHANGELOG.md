# Changelog

All notable changes to `aforo-ws-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** batches are POSTed to `/v1/ingest/batch` instead of `/v1/ingest/events`. `/v1/ingest/events` is the Apigee-format single-event endpoint and does not accept `{"events": [...]}`, so no usage was being recorded. Each flush is split into requests of at most 1000 events (the ingestor's batch limit).
- **Breaking (fix):** connection/frame duration is sent as `executionDurationMs`; the old `durationMs` field does not exist on the ingestor and was silently dropped. `push()` still accepts `durationMs` in its input for compatibility.
- `wsDirection` / `wsFrameType` are normalised to the ingestor's allowed values, `wsCloseReason` is capped at 32 characters, and events with a blank or over-64-character `customerId` (or no `wsConnectionId`) are dropped client-side instead of being rejected by the ingestor.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoWsBilling` and the connection trackers `track_websockets_connection` (for the `websockets` library) and `track_starlette_websocket` (FastAPI/Starlette).
- Documented the default open + close billing model (aggregated `messageCount` / `dataBytes` / `durationMs`), the `per_frame_events` mode, and close-code mapping via `WS_CLOSE_REASONS`.
- Full configuration reference; events deliver to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[Unreleased]: https://github.com/aforoai/aforo-metering-sdks/compare/python-ws-v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-sdks/releases/tag/python-ws-v1.0.0
