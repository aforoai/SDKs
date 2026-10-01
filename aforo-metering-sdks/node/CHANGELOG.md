# Changelog — @aforoai/metering

All notable changes to this package are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org).

## [1.1.2] - 2026-10-01

### Changed
- **Middlewares (express / koa / fastify): a path or method longer than the ingestor's limit is truncated, and the event is sent.** `endpointPath` is cut to 512 characters and `httpMethod` to 16, counted in UTF-16 code units as the server counts them; a cut never leaves half a surrogate pair. `endpointPath` was already cut to 512 but could split a surrogate pair; `httpMethod` over 16 dropped the event. One WARN is logged per label name per process.
- The idempotency key is unaffected: it is a random UUID minted per event, not derived from the path.

### Unchanged
- Fields the caller sets are never altered. An over-long `customerId`, `metricName` (fixed or returned by a `metricName` resolver), `idempotencyKey`, `productType`, or an `endpointPath` / `httpMethod` passed to `track()` still drops the event with reason `'invalid'`.

### Added
- Export: `truncateToLimit(value, max)`.

## [1.1.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.1.0] - 2026-10-01

Merge of the public-repo fixes (verified against the production ingestor) with the working repo's drop observability and `executionStatus` support.

### Changed
- **Auth header.** The API key is sent as `X-API-Key`; `Authorization` is no longer sent.
- **Default base URL** is `https://api.aforo.ai`.
- **Middleware (express / koa / fastify).** Default metric is `api_calls` (was `"METHOD /path"`, which no catalog contains); set `metricName` to a fixed name or a `(req, res) => string` resolver. The caller's `X-Api-Key` header is never used as the customer id. `OPTIONS` requests and requests whose quantity is `<= 0` are not metered.
- **Session heartbeats.** `startSession()` / `endSession()` send `system.session.heartbeat` with quantity 1 and top-level `sessionId` / `productType` / `sessionBoundary`. Each heartbeat is POSTed alone as `{"events":[heartbeat]}`, once, outside the usage buffer. A failed heartbeat is not a usage drop: it is not counted in `droppedCount` and not passed to `onDrop`.
- `flushCount` is capped at 1000, the ingestor's per-request batch limit.

### Added
- `productType` as a top-level field on every event: client option (default `"API"`) and per-event override, trimmed and upper-cased. The middlewares take a `productType` option.
- Top-level `endpointPath`, `httpMethod`, `statusCode`, `responseTimeMs` on `track()`; the middlewares fill them in.
- **Client-side validation, reported as a drop.** An event the ingestor would reject — blank `customerId` / `metricName`, `quantity <= 0`, a field over the server's size limit (`customerId` 64, `metricName` 255, `idempotencyKey` 255, `productType` 20, `endpointPath` 512, `httpMethod` 16), a `quantity` with more than 14 integer digits or 6 decimal places, a malformed `occurredAt` — is not buffered and not sent. `track()` does not throw for it. It is counted in `droppedCount`, WARN-logged (first occurrence, then every 1000th) with the field, the limit and the value, and passed to `onDrop` with the new reason `'invalid'`. Nothing is truncated or rounded. Server-configurable limits (event age, clock skew, metadata size) are not checked client-side.
- **Partial batch failures.** A 2xx response that reports per-event `errors[]` drops only those events (reason `'rejected'`); when the response gives a failure count without indexes, the count is added to `droppedCount` and logged, and `onDrop` is not called. The server's error message is included in the WARN for rejected batches.
- Exports: `DEFAULT_METRIC_NAME`, `MAX_LENGTHS`, `MAX_QUANTITY_INTEGER_DIGITS`, `MAX_QUANTITY_DECIMAL_PLACES`, `describeLimitViolation`. `DropReason` gains `'invalid'`.

### Unchanged
- `executionStatus` handling, idempotency keys (one random UUID per event, minted when `track()` enqueues it, reused by every retry; a caller key is sent verbatim), `onDrop` reasons `overflow` / `retry_exhausted` / `rejected`, and the `/v1/ingest/batch` wire shape.

## [1.0.1] - 2026-09-30

### Added
- Optional `executionStatus` on `track()`, trimmed and upper-cased. Accepted: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. An unknown or over-20-character value is WARN-logged and left off the event; the event is still sent.
- Drop observability: `droppedCount`, WARN log, and the opt-in `onDrop(events, reason)` hook. Dropped events keep their idempotency keys.

### Fixed
- Keyless events get a random UUID instead of a content hash, which collapsed distinct same-millisecond events.
- ESM build: `npm run build` failed at the ESM step and the ESM output could not be imported.
- `shutdown()` clears its escape timer and deregisters its `SIGTERM` / `SIGINT` handlers.

## [1.0.0] — 2026-06-29

Initial public distribution packaging.

### Added
- `AforoClient` — buffered, batched, retrying usage client (`track`, `flush`, `shutdown`, session/heartbeat helpers) that posts to `POST /v1/ingest/batch`.
- Framework middleware: `expressMiddleware` (alias `middleware`), `fastifyPlugin`, `koaMiddleware`, exposed as subpath exports under `@aforoai/metering/middleware/*`.
- `normalizePath` route-template helper for stable metric names.
- README, user guide, and this changelog.
