# Changelog

All notable changes to `com.aforo:graphql-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoGraphQlBilling` (`AutoCloseable`) with a fluent builder and a `graphql-java` `Instrumentation` that meters every operation.
- AST complexity scoring (`field_count + 5 × max_depth`) computed by walking the parsed document; per-event fields `gqlOperationType`, `gqlOperationName`, `gqlComplexity`, `gqlFieldCount`, `gqlHasErrors`, `executionDurationMs`.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 50-event / 5s flush, and 3× exponential retry.
- Pluggable `customerIdExtractor`; public `record(...)` for non-instrumentation integrations.
