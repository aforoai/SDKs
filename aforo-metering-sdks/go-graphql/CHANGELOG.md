# Changelog

All notable changes to `graphql-metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field) and in the package's `sdkVersion` constant.

Documents the existing package as-is: the `graphqlmetering` package at module path `github.com/aforo/graphql-metering-go` — `New`/`Config`, `Middleware` (wraps a GraphQL-over-HTTP POST handler), `Record` (manual per-operation), and `Shutdown`. Operation type/name detection, an approximate complexity score (`field_count + 5 × max_depth`), per-operation `graphql_api.operations` events with `X-Tenant-Id`, batched delivery with 3× retry to `POST /v1/ingest/events`. No source logic changed.
