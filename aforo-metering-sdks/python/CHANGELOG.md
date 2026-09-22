# Changelog

All notable changes to `aforo-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- **Breaking (fix):** default ingestor base URL is now `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor. `ingest.aforo.ai` / `ingestor.aforo.ai` resolve to a static CloudFront/S3 site that answers POSTs with a 301, not the ingestor. Set the base URL explicitly if you relied on the old default.
- **Breaking (fix):** Flask/Django/FastAPI middleware default metric is `api_calls` instead of `"METHOD /path"`; new `metric_name` / `customer_id` options for Flask (kwargs or `AFORO_METRIC_NAME` / `AFORO_CUSTOMER_ID` config) and Django (`AFORO_METRIC_NAME` / `AFORO_CUSTOMER_ID` settings). The caller's `X-Api-Key` header is no longer used as the customer id. `OPTIONS` (CORS preflight) requests are no longer metered.
- **Fix:** session heartbeats (`system.session.heartbeat`, quantity 0) are no longer sent in the usage batch; the ingestor rejects quantity 0 and failed the whole batch with 400. Session start/end methods are kept as no-ops/flush, heartbeat options are ignored.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoClient` (buffered, batched, retrying), the `track()` event API, `flush()`, session heartbeats, and graceful `shutdown()`.
- Documented FastAPI/Starlette (`AforoMeteringMiddleware`), Flask (`AforoMetering`), and Django (`AforoMeteringMiddleware`) adapters, including customer-ID resolution and path/status exclusions.
- Full configuration reference for `AforoOptions`, `track()` arguments, and `MiddlewareOptions`.
- Events deliver to `POST https://ingest.aforo.ai/v1/ingest/batch` with Bearer auth.

[Unreleased]: https://github.com/aforoai/aforo-metering-python/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-python/releases/tag/v1.0.0
