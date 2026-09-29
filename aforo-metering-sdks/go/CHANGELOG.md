# Changelog

All notable changes to `metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Fix:** `Track` now returns `ErrInvalidEvent` for events the ingestor's compiled-in field constraints would refuse — `CustomerID` over 64 chars, `MetricName` over 255, `IdempotencyKey` over 255, `ProductType` over 20, and a `Quantity` with more than 14 integer digits or 6 decimal places. Such an event is rejected server-side and never billed, and because flushing happens in the background nobody ever saw that rejection; now it is reported to the caller, before the event is buffered. Nothing is truncated or rounded. Limits the server makes configurable (`max-age-days`, `future-tolerance-minutes`, `max-metadata-bytes`) are left to the server.
- **Breaking (fix):** an event with an empty `TrackEvent.IdempotencyKey` now gets a fresh random UUID v4 instead of `SHA-256(customerID:metricName:quantity:occurredAt)`. Two genuinely distinct `Track` calls for the same customer, metric and quantity that shared an `OccurredAt` produced the SAME key; the ingestor answered DUPLICATE and silently dropped the second one, under-billing high-throughput callers (bulk SMS, per-request middleware). The key is still minted once, when `Track` enqueues the event, so retries re-send the same keys and a replayed batch is still deduplicated. **Callers who relied on the deterministic key for dedup must now set `IdempotencyKey` themselves** — an explicit key is still sent verbatim.
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- **Breaking (fix):** default ingestor base URL is now `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor. `ingest.aforo.ai` / `ingestor.aforo.ai` resolve to a static CloudFront/S3 site that answers POSTs with a 301, not the ingestor. Set the base URL explicitly if you relied on the old default.
- **Breaking (fix):** middleware default metric is `api_calls` (`DefaultMetricName`) instead of `"METHOD /path"`; new `MetricName`, `MetricNameFunc` and `CustomerIDFunc` options, and exported `NormalizePath`. The caller's `X-Api-Key` header is no longer used as the customer id. `OPTIONS` (CORS preflight) requests are no longer metered.
- Every event now carries the top-level `productType` the ingestor requires in production: new `Options.ProductType` (default `"API"`) and per-event `TrackEvent.ProductType` override (trimmed, upper-cased, unknown values passed through). `MiddlewareOptions.ProductType` sets it for the middleware.
- `Track` rejects events the ingestor would refuse — blank `CustomerID`/`MetricName`, negative/NaN/Inf `Quantity`, non-RFC 3339 `OccurredAt` — with an error wrapping the new `ErrInvalidEvent`, instead of letting one bad event fail a whole batch. `OccurredAt` is normalized to UTC.
- `FlushCount` is clamped to 1000, the ingestor's per-request batch limit.
- A `2xx` batch response with `failed > 0` is now reflected in `FlushResult.Failed`.
- Middleware events send top-level `endpointPath` (normalized, no query string, ≤ 512 chars), `httpMethod`, `statusCode` and `responseTimeMs`; `TrackEvent` gained matching optional fields.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field).

Documents the existing package as-is: the `metering` package at module path `github.com/aforo/metering-go` — `NewClient`/`Options`, `Track`/`TrackEvent`, `Flush`/`FlushResult`, `Close`, the zero-dependency `HTTPMiddleware` + `ChiMiddleware` (and `MiddlewareOptions`), in-memory ring buffer with oldest-drop overflow, deterministic auto idempotency keys, and batched delivery with retry to `POST /v1/ingest/batch`. No source logic changed.
