# Changelog

All notable changes to `aforo-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- **Breaking (fix):** default ingestor base URL is now `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor. `ingest.aforo.ai` / `ingestor.aforo.ai` resolve to a static CloudFront/S3 site that answers POSTs with a 301, not the ingestor. Set the base URL explicitly if you relied on the old default.
- **Breaking (fix):** Flask/Django/FastAPI middleware default metric is `api_calls` instead of `"METHOD /path"`; new `metric_name` / `customer_id` options for Flask (kwargs or `AFORO_METRIC_NAME` / `AFORO_CUSTOMER_ID` config) and Django (`AFORO_METRIC_NAME` / `AFORO_CUSTOMER_ID` settings). The caller's `X-Api-Key` header is no longer used as the customer id. `OPTIONS` (CORS preflight) requests are no longer metered.
- **Fix:** session heartbeats are no longer mixed into the usage batch (they were `system.session.heartbeat` events with quantity 0, which the ingestor rejects, failing the whole batch with 400). See "Changed" for how they are sent now.

### Added
- `product_type` client option (default `"API"`) and per-event `track(product_type=...)` override: every event now carries the top-level `productType` the production ingestor requires. Values are trimmed and upper-cased; unknown values are passed through. `TrackEvent` gains `product_type` and `extra_fields` (optional top-level ingest fields by camelCase wire name).
- Middleware `product_type` option (FastAPI kwarg / `MiddlewareOptions`, Flask kwarg or `AFORO_PRODUCT_TYPE` config, Django `AFORO_PRODUCT_TYPE` setting). Request events now carry top-level `endpointPath` (path without query, max 512), `httpMethod`, `statusCode` and `responseTimeMs`; a FastAPI `quantity` resolving to `<= 0` is not metered.
- `heartbeat_interval` option (default 30 s).

### Changed
- Session heartbeats are restored: `start_session()` sends a heartbeat immediately and every `heartbeat_interval` seconds from a daemon thread; `end_session()` stops it, flushes, and sends `SESSION_END`; `shutdown()` stops it. Each heartbeat has quantity 1, metric `system.session.heartbeat`, top-level `sessionId` / `productType` / `sessionBoundary`, a unique idempotency key, `customerId` from the new `start_session(customer_id=...)` (default `"system"`), and is POSTed alone as `{"events": [hb]}` so the ingestor always intercepts it on the synchronous path. Best-effort: one attempt, failures logged and swallowed.
- `track()` raises `ValueError` for a blank `customer_id` / `metric_name` and for `quantity <= 0` (the ingestor would fail the whole batch).
- `flush_count` is clamped to 1..1000 (the ingestor's per-request limit).
- `occurredAt` defaults to a millisecond ISO-8601 instant with a `Z` suffix.
- A 2xx batch response's `failed` / `errors[].message` are now read: `FlushResult.failed` counts per-event rejections and each message is logged. Non-retried 4xx responses log their `errors[].message`. A non-numeric `Retry-After` falls back to exponential backoff instead of raising.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoClient` (buffered, batched, retrying), the `track()` event API, `flush()`, session heartbeats, and graceful `shutdown()`.
- Documented FastAPI/Starlette (`AforoMeteringMiddleware`), Flask (`AforoMetering`), and Django (`AforoMeteringMiddleware`) adapters, including customer-ID resolution and path/status exclusions.
- Full configuration reference for `AforoOptions`, `track()` arguments, and `MiddlewareOptions`.
- Events deliver to `POST https://ingest.aforo.ai/v1/ingest/batch` with Bearer auth.

[Unreleased]: https://github.com/aforoai/aforo-metering-python/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-python/releases/tag/v1.0.0
