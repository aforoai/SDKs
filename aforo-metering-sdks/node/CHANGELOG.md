# Changelog — @aforo/metering

All notable changes to this package are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- **Breaking (fix):** default ingestor base URL is now `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor. `ingest.aforo.ai` / `ingestor.aforo.ai` resolve to a static CloudFront/S3 site that answers POSTs with a 301, not the ingestor. Set the base URL explicitly if you relied on the old default.
- **Breaking (fix):** middleware (express/koa/fastify) default metric is `api_calls` instead of `"METHOD /path"`, which no catalog contains; configure `metricName` (fixed or resolver) to a metric in your Aforo catalog. The caller's `X-Api-Key` header is no longer used as the customer id (it leaked a secret into billing data). `OPTIONS` (CORS preflight) requests are no longer metered.
- **Fix:** session heartbeats (`system.session.heartbeat`, quantity 0) are no longer sent in the usage batch; the ingestor rejects quantity 0 and failed the whole batch with 400. Session start/end methods are kept as no-ops/flush, heartbeat options are ignored.

## [1.0.0] — 2026-06-29

Initial public distribution packaging.

### Added
- `AforoClient` — buffered, batched, retrying usage client (`track`, `flush`, `shutdown`, session/heartbeat helpers) that posts to `POST /v1/ingest/batch`.
- Framework middleware: `expressMiddleware` (alias `middleware`), `fastifyPlugin`, `koaMiddleware`, exposed as subpath exports under `@aforo/metering/middleware/*`.
- `normalizePath` route-template helper for stable metric names.
- README, user guide, and this changelog.
