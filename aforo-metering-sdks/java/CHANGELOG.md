# Changelog

All notable changes to `com.aforo:metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Fix:** `track()` now drops (with a warning, matching its existing behaviour for blank fields) events the ingestor's compiled-in field constraints would refuse — `customerId` over 64 chars, `metricName` over 255, `idempotencyKey` over 255, `productType` over 20, and a `quantity` with more than 14 integer digits or 6 decimal places. Such an event is rejected server-side and never billed, and because flushing happens in the background nobody ever saw that rejection. Nothing is truncated or rounded. Limits the server makes configurable (`max-age-days`, `future-tolerance-minutes`, `max-metadata-bytes`) are left to the server.
- **Breaking (fix):** an event with no `idempotencyKey` now gets a fresh random UUID v4 (`IdempotencyKeyGenerator.generateRandom()`) instead of `IdempotencyKeyGenerator.generate(...)`'s `SHA-256(customerId:metricName:quantity:occurredAt)`. `occurredAt` only carries millisecond precision, so two genuinely distinct events for the same customer, metric and quantity inside one millisecond produced the SAME key; the ingestor answered DUPLICATE and silently dropped the second one, under-billing high-throughput callers (bulk SMS, servlet filter). The key is still minted once, when `track(...)` enqueues the event, so retries re-send the same keys and a replayed batch is still deduplicated. **Callers who relied on the deterministic key for dedup must now pass `TrackEvent.Builder.idempotencyKey(...)`** — an explicit key is still sent verbatim. `IdempotencyKeyGenerator.generate(...)` remains public API for that purpose but is no longer the default.
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
