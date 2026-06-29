# Changelog

All notable changes to `aforo-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoClient` (buffered, batched, retrying), the `track()` event API, `flush()`, session heartbeats, and graceful `shutdown()`.
- Documented FastAPI/Starlette (`AforoMeteringMiddleware`), Flask (`AforoMetering`), and Django (`AforoMeteringMiddleware`) adapters, including customer-ID resolution and path/status exclusions.
- Full configuration reference for `AforoOptions`, `track()` arguments, and `MiddlewareOptions`.
- Events deliver to `POST https://ingest.aforo.ai/v1/ingest/batch` with Bearer auth.

[Unreleased]: https://github.com/aforoai/aforo-metering-python/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-python/releases/tag/v1.0.0
