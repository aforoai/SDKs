# Changelog

All notable changes to `com.aforo:graphql-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoGraphQlBilling` (`AutoCloseable`) with a fluent builder and a `graphql-java` `Instrumentation` that meters every operation.
- AST complexity scoring (`field_count + 5 × max_depth`) computed by walking the parsed document; per-event fields `gqlOperationType`, `gqlOperationName`, `gqlComplexity`, `gqlFieldCount`, `gqlHasErrors`, `executionDurationMs`.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 50-event / 5s flush, and 3× exponential retry.
- Pluggable `customerIdExtractor`; public `record(...)` for non-instrumentation integrations.
