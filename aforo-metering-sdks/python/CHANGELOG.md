# Changelog

All notable changes to `aforo-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [1.1.2] - 2026-10-01

### Changed
- **Middlewares (Flask, Django, FastAPI/ASGI): request-derived labels are truncated, not dropped.** `endpointPath` and `httpMethod` are read from the incoming request. A value over the ingestor's limit (`endpointPath` 512, `httpMethod` 16) is cut to the limit and the event is still sent. The length is counted in UTF-16 code units, as the ingestor counts it, and a surrogate pair is never split. Before, the path was cut at 512 code points, which a path containing characters outside the Basic Multilingual Plane could still exceed, and the event was then rejected. One WARNING is logged per field name per process.
- New helpers in `aforo.limits`: `truncate_label`, `truncate_utf16`, `utf16_length`.

### Unchanged
- Fields the caller sets (`customer_id`, `metric_name`, `idempotency_key`, `product_type`, and anything passed in `extra_fields` to `track()`) are never truncated. An over-long one still drops the event with reason `invalid`.
- The idempotency key is the caller's key or a random UUID per event; it does not depend on the request path.

## [1.1.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` and `killedSessionIds` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent and the heartbeat response returned to the caller did not carry `killedSessionIds`. A bare (unwrapped) body is still accepted.

## [1.1.0] - 2026-10-01

Merge of the public repository's fixes with the working repository's 1.0.1.

### Changed
- **Auth:** the API key is sent as `X-API-Key`; no `Authorization` header is sent. The ingestor accepts `X-API-Key` for every key.
- **Default host** is `https://api.aforo.ai` (was `ingest.aforo.ai`, which is not the ingestor).
- **Session heartbeats** have quantity 1, top-level `sessionId` / `productType` / `sessionBoundary`, and are each POSTed alone as `{"events": [hb]}` — never through the usage buffer. One attempt, best-effort; a failed heartbeat is not counted in `dropped_count`. `start_session(customer_id=...)` and the `heartbeat_interval` option are new.
- **Transport:** 408 and 429 are retried (429 honours `Retry-After`); other 4xx are not, and their `errors[].message` is logged. A `202` with `failed` > 0 is read: the rejected events are dropped with reason `rejected` (only the ones the response names by index are passed to `on_drop`). `FlushResult` gains `failed_indices`.
- `flush_count` is clamped to 1..1000, the ingestor's batch limit.
- `occurredAt` defaults to a millisecond ISO-8601 instant with a `Z` suffix.
- **Middleware (FastAPI / Flask / Django):** default metric is `api_calls` (was `"METHOD /path"`); `metric_name`, `customer_id` and `product_type` options; the caller's `X-Api-Key` is never used as the customer id; `OPTIONS` requests are not metered; events carry top-level `endpointPath`, `httpMethod`, `statusCode`, `responseTimeMs`.

### Added
- `product_type` client option (default `API`) and per-event `track(product_type=...)`; every event carries top-level `productType`. `extra_fields` adds optional top-level ingest fields by wire name.
- Field-limit checks mirroring the ingestor (`aforo/limits.py`): `customerId` 64, `metricName` 255, `idempotencyKey` 255, `productType` 20, `quantity` 14 integer / 6 decimal digits, ISO-8601 `occurred_at`, and the `extra_fields` limits.
- Drop reason **`invalid`**: an event with a blank `customer_id` / `metric_name`, `quantity <= 0` or a field over a limit is not buffered or sent. `track()` does **not** raise for it (in 1.0.x a blank `customer_id` / `metric_name` raised `ValueError`); the event is counted in `dropped_count`, WARN-logged (first occurrence, then every 1000th) and passed to `on_drop(events, "invalid")`.

### Unchanged from 1.0.1
- `execution_status`, `on_drop` / `dropped_count`, random per-event idempotency keys minted once at `track()`, the `atexit` flush.

## [1.0.1] - 2026-09-30

- An `execution_status` outside the 11 canonical values (or over 20 characters) is WARN-logged and left off the event; it used to be sent as-is and the ingestor rejected that event.

## 1.0.0 (working repository, 2026-07 – 2026-09)

- `execution_status` on `track()` / `TrackEvent`: optional, trimmed, upper-cased.
- Drop observability: `dropped_count`, WARN log, opt-in `on_drop(events, reason)` with reasons `overflow`, `retry_exhausted`, `rejected`. A hook that calls `flush()` no longer deadlocks.
- An event without a caller `idempotency_key` gets a random UUID (was a content hash that collided for same-instant events). The key is minted once at `track()` and reused by every retry.
- Events are POSTed to `/v1/ingest/batch` as `{"events": [...]}`; a contract test loads `contract/ingest-contract.json`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoClient` (buffered, batched, retrying), the `track()` event API, `flush()`, session heartbeats, and graceful `shutdown()`.
- Documented FastAPI/Starlette (`AforoMeteringMiddleware`), Flask (`AforoMetering`), and Django (`AforoMeteringMiddleware`) adapters, including customer-ID resolution and path/status exclusions.
- Full configuration reference for `AforoOptions`, `track()` arguments, and `MiddlewareOptions`.
- Events deliver to `POST https://ingest.aforo.ai/v1/ingest/batch` with Bearer auth.

[1.0.0]: https://github.com/aforoai/SDKs/releases/tag/v1.0.0
