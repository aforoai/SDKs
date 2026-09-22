# Changelog — @aforo/metering

All notable changes to this package are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- **Breaking (fix):** default ingestor base URL is now `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor. `ingest.aforo.ai` / `ingestor.aforo.ai` resolve to a static CloudFront/S3 site that answers POSTs with a 301, not the ingestor. Set the base URL explicitly if you relied on the old default.
- **Breaking (fix):** middleware (express/koa/fastify) default metric is `api_calls` instead of `"METHOD /path"`, which no catalog contains; configure `metricName` (fixed or resolver) to a metric in your Aforo catalog. The caller's `X-Api-Key` header is no longer used as the customer id (it leaked a secret into billing data). `OPTIONS` (CORS preflight) requests are no longer metered.
- **Fix:** session heartbeats (`system.session.heartbeat`) are no longer sent in the usage batch; with quantity 0 the ingestor rejected them and failed the whole batch with 400.
- **Fix:** `startSession()` / `endSession()` send heartbeats again, now in a shape the ingestor accepts: quantity 1, top-level `sessionId`, `productType` and `sessionBoundary` (`HEARTBEAT` on start and every 30s, `SESSION_END` on `endSession()`), unique idempotency key. Each heartbeat is POSTed in its own `{"events":[heartbeat]}` request so it always takes the ingestor's synchronous path (where it is intercepted before billing), never mixed into a usage batch. Heartbeats are best-effort: sent once, failures ignored, never affecting usage delivery; the timer is unref'd and stops on `endSession()`/`shutdown()`.

### Added
- `productType` is sent as a top-level field on every event (required by the ingestor in production). Set a client default with `new AforoClient({ productType })` (default `"API"`) and override per event with `track({ productType })`; values are trimmed and uppercased, unknown values pass through. The express/koa/fastify middlewares take a `productType` option too.
- Middlewares send top-level `endpointPath` (path without query string, max 512 chars), `httpMethod`, `statusCode` and `responseTimeMs`, and skip requests whose quantity is `<= 0`.
- `track()` rejects a blank `customerId`/`metricName` or a quantity `<= 0` with an error instead of queueing an event that would fail its whole batch.
- `flushCount` is capped at 1000, the ingestor's per-request batch limit.
- `BatchResponse.errors[]` is typed `{ index, message }` (the ingestor's shape) and includes optional `killedSessionIds`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging.

### Added
- `AforoClient` — buffered, batched, retrying usage client (`track`, `flush`, `shutdown`, session/heartbeat helpers) that posts to `POST /v1/ingest/batch`.
- Framework middleware: `expressMiddleware` (alias `middleware`), `fastifyPlugin`, `koaMiddleware`, exposed as subpath exports under `@aforo/metering/middleware/*`.
- `normalizePath` route-template helper for stable metric names.
- README, user guide, and this changelog.
