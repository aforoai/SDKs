# Changelog

All notable changes to `ai.aforo:metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [1.1.2] - 2026-10-01

### Changed
- **`AforoServletFilter` truncates over-long request labels instead of letting the event be lost.** `endpointPath` is cut to 512 characters and `httpMethod` to 16 (the ingestor's limits, counted in UTF-16 code units); the event is sent. `httpMethod` was not bounded before, so a request with a longer method was sent and refused by the ingestor. The cut never splits a surrogate pair. One `WARNING` is logged per label per filter instance.
- Fields set by the caller are unchanged: an over-long `customerId` (including one read from the customer header), `metricName` (fixed or from a `MetricNameResolver`), `idempotencyKey` or `productType` still drops the event as `INVALID`. `track(...)` does not truncate anything passed to it.

### Added
- `RequestLabels.truncate(String, int)`: the surrogate-safe cut used by the filter.

## [1.1.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.1.0] - 2026-10-01

Merge of the 1.0.1 line (execution status, drop observability) with the public-repo ingest fixes.

### Changed
- **Maven groupId is `ai.aforo`** (was `com.aforo`): `ai.aforo:metering:1.1.0`. Java package names (`com.aforo.metering`) and the Spring property prefix (`aforo.*`) are unchanged.
- **Breaking (fix):** the API key is sent as `X-API-Key`; `Authorization: Bearer` is no longer sent.
- **Breaking (fix):** the default base URL is `https://api.aforo.ai` (`AforoOptions` and `aforo.base-url`).
- **Breaking (fix):** the servlet filter records the metric `api_calls` (or `aforo.metric-name` / a `MetricNameResolver` bean) instead of `"METHOD /path"`. The customer id comes from a `CustomerIdResolver` bean or `aforo.customer-id-header` (default `X-Customer-Id`); the caller's `X-Api-Key` header is never used, and the principal name only with `aforo.use-principal-as-customer-id: true`. `OPTIONS` requests are not metered.
- `flushCount` is clamped to 1–1000, the ingestor's batch limit.

### Added
- Top-level `productType` on every event: `AforoOptions.productType(...)` / `aforo.product-type` (default `API`), `TrackEvent.Builder.productType(...)` per event, `AforoServletFilter.productType(...)` per filter. Trimmed and upper-cased.
- `TrackEvent.Builder`: `occurredAt(Instant)`, `endpointPath`, `httpMethod`, `statusCode`, `responseTimeMs`; the servlet filter sets them (endpoint path capped at 512 characters).
- `DropReason.INVALID`: an event the ingestor would refuse — blank `customerId` / `metricName`, `quantity <= 0`, `customerId` over 64 characters, `metricName` or `idempotencyKey` over 255, `productType` over 20, a `quantity` with more than 14 integer digits or 6 decimal places — is not buffered. It is counted in `droppedCount()`, logged, and passed to `onDrop`. `track(...)` does not throw for it, and nothing is truncated or rounded.
- Partial results: when a 2xx response lists refused events in `errors[]`, `FlushResult.failed()` counts them and they are passed to `onDrop` as `REJECTED`. Rejection log lines carry the ingestor's `errors[].message`.

## [1.0.1] - 2026-09-30

- `TrackEvent.Builder.executionStatus(...)`: optional outcome status for OUTCOME_BASED pricing, trimmed and upper-cased. A value outside the 11 canonical statuses (or longer than 20 characters) is logged and left off the event.
- Drop observability: `droppedCount()`, a `WARNING` log, and the opt-in `AforoOptions.onDrop(events, reason)` hook (`OVERFLOW`, `RETRY_EXHAUSTED`, `REJECTED`).
- An event with no `idempotencyKey` gets a random UUID, minted once when `track(...)` enqueues it and reused by every retry. `IdempotencyKeyGenerator.generate(...)` stays public but is no longer the default: two identical events in the same millisecond hashed to one key and the second was deduplicated away.
- `close()` removes the JVM shutdown hook it registered.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoClient` (`AutoCloseable`): buffered, batched event delivery to `POST https://ingest.aforo.ai/v1/ingest/batch` with size/time-threshold flush, 3× retry on 5xx/408/429 (honoring `Retry-After`), and a JVM shutdown hook.
- `AforoOptions` fluent configuration; `TrackEvent` builder; `FlushResult` record.
- Spring Boot auto-configuration (`aforo.enabled=true`) wiring an `AforoClient` bean and `AforoServletFilter` (request-end, non-blocking, default path excludes).
- `PathNormalizer` for route-template / id-segment normalization; deterministic idempotency-key derivation.
