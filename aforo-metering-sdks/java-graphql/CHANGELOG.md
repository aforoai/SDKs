# Changelog

All notable changes to `ai.aforo:graphql-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [1.2.2] - 2026-10-01

### Changed
- **An operation name over 255 characters is truncated, and the event is sent.** The name is read from the query document, so a client could avoid being metered by sending a longer one (1.2.0 dropped such events as `INVALID`). `gqlOperationName` is cut to 255 characters (UTF-16 code units, never inside a surrogate pair). One `WARNING` is logged per instance.
- Fields set by the caller are unchanged: `customerId` over 64 characters or `productType` over 20 still drops the event as `INVALID`.
- The automatic `idempotencyKey` no longer cuts its text part when it is too long for the 255-character limit. The part is kept as-is when it fits (keys for such events are unchanged); otherwise its tail is replaced by the SHA-256 hex digest of the whole untruncated value, so two events whose long operation names share a prefix get different text parts. The key is still minted once per event and resent unchanged on retry.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

Merge of the 1.1.x line (execution status, drop observability) with the public-repo ingest fixes.

### Changed
- **Maven groupId is `ai.aforo`** (was `com.aforo`): `ai.aforo:graphql-metering:1.2.0`. Java package names are unchanged.
- **Breaking (fix):** the API key is sent as `X-API-Key`; `Authorization: Bearer` is no longer sent.
- Docs and examples use `https://api.aforo.ai`.
- A 4xx other than 408/429 is sent once and the batch is dropped as `REJECTED` (it used to be retried 3 times). A 429 waits for `Retry-After` (seconds). Exhausted retries are `RETRY_EXHAUSTED`.
- Flushes larger than 1000 events are split into requests of at most 1000; each slice is serialized once, so retries resend the same `idempotencyKey`s.
- `executionDurationMs` is sent as an integer; enum-validated fields carry only values the ingestor accepts (others go to `metadata`).

### Added
- `Builder.productType(String)` (default `GRAPHQL_API`) and `getProductType()`: top-level `productType` on every event. Trimmed and upper-cased. Per-call override: `record(customerId, query, operationName, durationMs, hasErrors, executionStatus, productType)`. The six-argument `record(...)` keeps `executionStatus` as its last argument.
- `DropReason.INVALID`: an event that breaks an ingestor field limit (`customerId` over 64 characters, `productType` over 20, …) is not sent; it is counted in `droppedCount()`, logged, and passed to `onDrop`. Nothing is thrown and nothing is truncated.
- Partial results: when a 2xx response lists refused events in `errors[]`, those events are counted and passed to `onDrop` as `REJECTED`; the log line carries the ingestor's `errors[].message`.
- An operation name over 255 characters is no longer truncated; the event is dropped as `INVALID`.

## [1.1.1] - 2026-09-30

- An `executionStatus` outside the 11 canonical values (or longer than 20 characters) is logged and left off the event; it used to be sent as-is and the ingestor rejected the event.
- A size-triggered flush and `close()` could drain the buffer at the same time and split one batch into two requests; draining is now serialized.

## [1.1.0] - 2026-09-30

- `executionStatus` on events (trimmed, upper-cased), derived from the GraphQL result by the instrumentation.
- Drop observability: `droppedCount()`, a `WARNING` log, and the opt-in `Builder.onDrop(events, reason)` hook (`RETRY_EXHAUSTED`, `REJECTED`); an interrupted retry backoff is accounted for. Events post to `/v1/ingest/batch` as `{"events": [...]}`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoGraphQlBilling` (`AutoCloseable`) with a fluent builder and a `graphql-java` `Instrumentation` that meters every operation.
- AST complexity scoring (`field_count + 5 × max_depth`) computed by walking the parsed document; per-event fields `gqlOperationType`, `gqlOperationName`, `gqlComplexity`, `gqlFieldCount`, `gqlHasErrors`, `executionDurationMs`.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 50-event / 5s flush, and 3× exponential retry.
- Pluggable `customerIdExtractor`; public `record(...)` for non-instrumentation integrations.
