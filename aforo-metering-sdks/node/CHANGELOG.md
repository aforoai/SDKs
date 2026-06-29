# Changelog — @aforo/metering

All notable changes to this package are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging.

### Added
- `AforoClient` — buffered, batched, retrying usage client (`track`, `flush`, `shutdown`, session/heartbeat helpers) that posts to `POST /v1/ingest/batch`.
- Framework middleware: `expressMiddleware` (alias `middleware`), `fastifyPlugin`, `koaMiddleware`, exposed as subpath exports under `@aforo/metering/middleware/*`.
- `normalizePath` route-template helper for stable metric names.
- README, user guide, and this changelog.
