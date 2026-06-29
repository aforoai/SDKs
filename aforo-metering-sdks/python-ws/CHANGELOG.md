# Changelog

All notable changes to `aforo-ws-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoWsBilling` and the connection trackers `track_websockets_connection` (for the `websockets` library) and `track_starlette_websocket` (FastAPI/Starlette).
- Documented the default open + close billing model (aggregated `messageCount` / `dataBytes` / `durationMs`), the `per_frame_events` mode, and close-code mapping via `WS_CLOSE_REASONS`.
- Full configuration reference; events deliver to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[Unreleased]: https://github.com/aforoai/aforo-metering-sdks/compare/python-ws-v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-sdks/releases/tag/python-ws-v1.0.0
