# Changelog

All notable changes to `metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [1.1.2] - 2026-10-01

### Changed
- **HTTP middleware: over-long `endpointPath` / `httpMethod` are truncated, the event is sent.** `HTTPMiddleware` and `ChiMiddleware` read both from the incoming request. They are cut to the ingestor's limits (`endpointPath` 512, `httpMethod` 16) so a caller of your API cannot avoid metering with an over-long URL or method. Previously `endpointPath` was cut at 512 bytes and an over-long `httpMethod` dropped the event as `invalid`.
- Length is counted in UTF-16 code units, as the server counts it. The cut never splits a character: if it would fall inside a surrogate pair the value is one unit shorter.
- One WARN is logged per label name per middleware instance, not per event.
- Unchanged: fields you pass to `Track` (`CustomerID`, `MetricName`, `IdempotencyKey`, `ProductType`, and `EndpointPath` / `HTTPMethod` when you set them yourself) are never truncated. Over the limit they are dropped as `invalid`. The customer id the middleware reads is also still dropped when over 64 characters.
- Unchanged: idempotency keys (a random UUID per event unless you set one) and the default metric name (`api_calls`).
- `VERSION`: 1.1.2.

## [1.1.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.1.0] - 2026-10-01

### Changed
- Merge of the working repository and the public `aforoai/SDKs` repository. Both sets of behaviour are kept.
- An event `Track` refuses is now reported two ways: `Track` returns an error wrapping `ErrInvalidEvent`, and the event is counted in `DroppedCount()`, WARN-logged (first occurrence, then every 1000th) and passed to `Options.OnDrop` with the new reason `DropInvalid` (`invalid`). The idempotency key is minted before validation, so the event handed to `OnDrop` carries it.
- A `2xx` partial-failure response drops only the events named by `errors[].index`, with reason `DropRejected`; failures the ingestor does not identify are counted without naming an event. A non-retryable `4xx` logs the server's message.
- Length limits count characters (UTF-16 code units, as the server does), not bytes. `EndpointPath` (512) and `HTTPMethod` (16) are checked too.
- `OnDrop` events carry `ProductType` and the HTTP context fields, so replaying them through `Track` keeps those values.
- Module version recorded in `VERSION`: 1.1.0. Releases are git tags `aforo-metering-sdks/go/vX.Y.Z` on github.com/aforoai/SDKs.

### From the public repository
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

## [1.0.1] - 2026-09-30

- Optional `TrackEvent.ExecutionStatus`, trimmed and upper-cased; a value outside the 11 canonical values (or longer than 20 characters) is WARN-logged and left off the event.

## Earlier working-repo changes (reported as 1.0.0)

- 2026-09-30: module path is `github.com/aforoai/SDKs/aforo-metering-sdks/go`.
- 2026-07-05: keyless events get a random UUID key, minted once in `Track`; drop observability — `DroppedCount()`, WARN log and the opt-in `Options.OnDrop(events, reason)` hook (`overflow`, `retry_exhausted`, `rejected`); ingest-contract test driven by `contract/ingest-contract.json`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field).

Documents the existing package as-is: the `metering` package at module path `github.com/aforo/metering-go` — `NewClient`/`Options`, `Track`/`TrackEvent`, `Flush`/`FlushResult`, `Close`, the zero-dependency `HTTPMiddleware` + `ChiMiddleware` (and `MiddlewareOptions`), in-memory ring buffer with oldest-drop overflow, deterministic auto idempotency keys, and batched delivery with retry to `POST /v1/ingest/batch`. No source logic changed.
