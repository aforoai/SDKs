# Changelog

All notable changes to `graphql-metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** batches are POSTed to `/v1/ingest/batch` instead of `/v1/ingest/events`. `/v1/ingest/events` is a single-event Apigee-format endpoint and does not accept `{"events":[...]}`, so batches were not being ingested.
- Each flush is split into requests of at most 1000 events (the ingestor's batch limit). Retries resend the same body, so `idempotencyKey`s are stable across attempts.
- Events whose `customerId` exceeds 64 characters are dropped and reported via `OnError` instead of being rejected by the ingestor.
- `gqlOperationName` is truncated to 255 characters and `idempotencyKey` is capped at 255 characters (ingestor limits).

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field) and in the package's `sdkVersion` constant.

Documents the existing package as-is: the `graphqlmetering` package at module path `github.com/aforo/graphql-metering-go` — `New`/`Config`, `Middleware` (wraps a GraphQL-over-HTTP POST handler), `Record` (manual per-operation), and `Shutdown`. Operation type/name detection, an approximate complexity score (`field_count + 5 × max_depth`), per-operation `graphql_api.operations` events with `X-Tenant-Id`, batched delivery with 3× retry to `POST /v1/ingest/events`. No source logic changed.
