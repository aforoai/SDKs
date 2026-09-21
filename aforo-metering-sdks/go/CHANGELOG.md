# Changelog

All notable changes to `metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- **Breaking (fix):** default ingestor base URL is now `https://usage-ingestor.aforo.ai`. `ingest.aforo.ai` / `ingestor.aforo.ai` resolve to a static CloudFront/S3 site that answers POSTs with a 301, not the ingestor. Set the base URL explicitly if you relied on the old default.
- **Breaking (fix):** middleware default metric is `api_calls` (`DefaultMetricName`) instead of `"METHOD /path"`; new `MetricName`, `MetricNameFunc` and `CustomerIDFunc` options, and exported `NormalizePath`. The caller's `X-Api-Key` header is no longer used as the customer id. `OPTIONS` (CORS preflight) requests are no longer metered.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field).

Documents the existing package as-is: the `metering` package at module path `github.com/aforo/metering-go` — `NewClient`/`Options`, `Track`/`TrackEvent`, `Flush`/`FlushResult`, `Close`, the zero-dependency `HTTPMiddleware` + `ChiMiddleware` (and `MiddlewareOptions`), in-memory ring buffer with oldest-drop overflow, deterministic auto idempotency keys, and batched delivery with retry to `POST /v1/ingest/batch`. No source logic changed.
