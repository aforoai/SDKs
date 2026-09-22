# Changelog

All notable changes to `com.aforo:metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- **Breaking (fix):** default ingestor base URL is now `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor. `ingest.aforo.ai` / `ingestor.aforo.ai` resolve to a static CloudFront/S3 site that answers POSTs with a 301, not the ingestor. Set the base URL explicitly if you relied on the old default.
- **Breaking (fix):** servlet filter default metric is `api_calls` instead of `"METHOD /path"`; configure `aforo.metric-name` or a `MetricNameResolver` bean. The customer id comes from a `CustomerIdResolver` bean or `aforo.customer-id-header` (default `X-Customer-Id`); the caller's `X-Api-Key` is no longer used, and the principal name only with `aforo.use-principal-as-customer-id: true`. `OPTIONS` (CORS preflight) requests are no longer metered.
- `track(...)` drops (with a warning) events with a blank `customerId`/`metricName` or `quantity <= 0` (including NaN), which would otherwise fail the whole batch server-side.
- `flushCount` is clamped to 1–1000 so a batch never exceeds the ingestor's limit.
- `AforoServletFilter` sends top-level `endpointPath` (route pattern or normalized path, no query, at most 512 chars), `httpMethod`, `statusCode`, and `responseTimeMs`.

### Added
- Every event carries top-level `productType`, which the production ingestor requires. Client default via `AforoOptions.productType(...)` / `aforo.product-type` (default `API`); per-event override via `TrackEvent.Builder.productType(...)`; filter-level override via `AforoServletFilter.productType(...)`. Values are trimmed and uppercased; unknown values are passed through.
- `TrackEvent.Builder`: `occurredAt(Instant)`, `endpointPath`, `httpMethod`, `statusCode`, `responseTimeMs`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoClient` (`AutoCloseable`): buffered, batched event delivery to `POST https://ingest.aforo.ai/v1/ingest/batch` with size/time-threshold flush, 3× retry on 5xx/408/429 (honoring `Retry-After`), and a JVM shutdown hook.
- `AforoOptions` fluent configuration; `TrackEvent` builder; `FlushResult` record.
- Spring Boot auto-configuration (`aforo.enabled=true`) wiring an `AforoClient` bean and `AforoServletFilter` (request-end, non-blocking, default path excludes).
- `PathNormalizer` for route-template / id-segment normalization; deterministic idempotency-key derivation.
