# Changelog

All notable changes to `com.aforo:graphql-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** events are sent to `POST <ingestorUrl>/v1/ingest/batch` as `{"events": [...]}`. `/v1/ingest/events` is a single-event Apigee-format endpoint and did not accept these batches. Flushes larger than 1000 events are split into requests of at most 1000; each slice is serialized once so retries resend the same `idempotencyKey`s.
- Events whose `customerId` is longer than 64 characters are dropped client-side (the ingestor rejects them); `executionDurationMs` is sent as an integer and long operation names / idempotency keys are trimmed to the ingestor's limits.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoGraphQlBilling` (`AutoCloseable`) with a fluent builder and a `graphql-java` `Instrumentation` that meters every operation.
- AST complexity scoring (`field_count + 5 × max_depth`) computed by walking the parsed document; per-event fields `gqlOperationType`, `gqlOperationName`, `gqlComplexity`, `gqlFieldCount`, `gqlHasErrors`, `executionDurationMs`.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 50-event / 5s flush, and 3× exponential retry.
- Pluggable `customerIdExtractor`; public `record(...)` for non-instrumentation integrations.
