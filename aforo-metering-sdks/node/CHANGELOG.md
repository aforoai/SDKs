# Changelog — @aforoai/metering

All notable changes to this package are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org).

## [2.0.0] - 2026-10-26

Breaking. Migration: give every middleware a `customerResolver` (or `trustCustomerHeader: true` behind a proxy you control), call `await client.shutdown()` from your own SIGTERM handler, and use an `https://` `baseUrl` (or `allowInsecureHttp: true`).

### Fixed (transport core, review of 2026-10-26)
These come from the shared Node core (`src/transport-core/core.ts`) and follow contract/TRANSPORT-SPEC.md "Edge cases every core handles the same way".
- **The request deadline covers reading the response body.** A server that sent headers and then stalled, or dripped the body a byte at a time, held `flush()` and `shutdown()` forever; the read is now inside `timeoutMs` and the batch is retried.
- **Redirects are never followed.** Every request is sent with `redirect: 'manual'`, so the API key cannot reach the host a 3xx names. A 3xx keeps the batch queued, opens the breaker and is logged once at ERROR with the target host (never the key); fix the base URL and the queue drains without loss. `onError` gets `kind: 'outage'` with the 3xx `status`.
- **Events are serialized when tracked.** An event JSON cannot represent (a `BigInt`, a cycle, `NaN` or `Infinity` in metadata) is dropped as `invalid` and counted at track time; before, it made the whole batch fail to serialize and every event in it was lost unreported. Later changes to a tracked object are no longer sent.
- **Exit flush waits for the batch in flight.** On `beforeExit` the process stays alive (up to the shutdown deadline) until the queue and the batch being sent or retried are done. It used to exit during a retry and lose that batch.
- **Per-event `retryable` failures back off and are capped.** They are re-sent after the normal jittered backoff, at most `maxRetries` times, then treated as an outage; a 2xx that hits the cap no longer resets the breaker, so its cooldown keeps growing instead of flapping.
- **Breaker cooldown is `max(250 ms, random(0, ceiling))`** even when a small `breakerInitialMs` is configured.
- The session heartbeat request is sent with `redirect: 'manual'` too; a 3xx is logged at debug and the heartbeat counts as not delivered.

### Changed (breaking)
- **Customer identity (G265).** Express, Koa and Fastify middleware throw at setup unless you pass `customerResolver` or `trustCustomerHeader: true`. The `X-Customer-Id` header and `req.user.id` are no longer read by default. A resolver that returns nothing drops that event with reason `invalid` (counted); the request is not blocked. `customerId` still works as a deprecated alias.
- **No signal handlers (G293).** The client no longer adds `SIGTERM`/`SIGINT` listeners (they kept the process from exiting). It flushes on `beforeExit` within `shutdownTimeoutMs`; call `shutdown()` from your own handler.
- **`track()` never throws.** After `shutdown()` the event is counted and reported with reason `closed`.
- **https required (G270).** `baseUrl` must be `https://`; plain http only for localhost, 127.0.0.1, ::1 or with `allowInsecureHttp: true`.
- **Defaults (G269).** `flushCount` 500 (was 50); `retryBaseMs` 500 (was 1000).
- **Outages do not drop usage (G267).** After the retries — or on 401/403 — a batch goes back to the front of the queue with its keys and a breaker pauses sending (5 s doubling to 5 min). `retry_exhausted` is no longer produced. New drop reasons `shutdown` and `closed`.
- **`flush()` result** is `{ sent, failed, requeued, queued }`.
- **Middleware paths are normalized by default (G295)**: route template when the framework has one, else `/users/123` → `/users/:id`. `normalizePath: false` keeps the raw path.

### Added
- One transport core (`src/transport-core/core.ts`, copied into every Node variant — G271): bounded queue, a single background sender (one request in flight), full-jitter retries, `Retry-After` in seconds or HTTP-date (capped at 60 s), `AbortSignal.timeout` per request, 413 split, per-event `retryable` requeue, shutdown deadline (G266, G268).
- The core has an `onAccepted(body, events)` hook (the parsed 2xx body, `{success, data}` unwrapped, after each accepted batch) and reports `onError` as a `CoreTransportError` with a `kind` (`outage`, `auth`, `rejected`, `shutdown`, `closed`) and the events concerned. Variants use them; the `@aforoai/metering` client API is unchanged.
- Middleware `client` option: meter through an `AforoClient` your app owns; a middleware that creates its own exposes it as `.client` (G294).
- Events still queued at the shutdown deadline are counted in `droppedCount` and reported with reason `shutdown` (G294).
- `allowInsecureHttp`, `flushOnExit` options; `User-Agent: aforo-node/<version>`.
- The API key is never shown by `inspect()` / `JSON.stringify` of the client.

### Removed
- Internal `RingBuffer` and `Transport` classes (replaced by the core; neither was exported).

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
