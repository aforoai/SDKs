# Changelog

All notable changes to `graphql-metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [1.2.2] - 2026-10-01

### Changed
- **An over-long operation name is truncated, the event is sent.** The operation name comes from the client's request, so a name over the ingestor's 255 characters used to drop the event as `invalid` and a client could avoid metering. It is now cut to 255 characters. This applies to `Middleware`, to the `operationName` argument of `Record`, and to a name parsed from the query text.
- Length is counted in UTF-16 code units, as the server counts it. The cut never splits a character: if it would fall inside a surrogate pair the value is one unit shorter.
- One WARN is logged per label name per `Billing`, not per event.
- Unchanged: `customerId` and `productType` are never truncated. Over the limit (64 / 20) the event is dropped as `invalid`.
- **Idempotency key.** The key is built from the full operation name, before truncation. A key up to 255 characters is byte-for-byte what it was. A longer one is no longer cut to its last 255 bytes: the operation name in it is replaced by the SHA-256 hex digest of the full name.
- `sdkVersion` and `VERSION`: 1.2.2.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

### Changed
- Merge of the working repository and the public `aforoai/SDKs` repository. Both sets of behaviour are kept.
- `EventOptions` carries both `ExecutionStatus` and `ProductType`. The recording methods accept optional trailing `EventOptions`; the `*WithOptions` forms remain.
- Transport: a non-retryable `4xx` drops the batch with `DropRejected` after one attempt; exhausted retries drop it with `DropRetryExhausted`; a `2xx` partial-failure response drops only the events named by `errors[].index` (`DropRejected`), and failures the ingestor does not identify are counted without naming an event. All of these count in `DroppedCount()` and reach `Config.OnDrop`.
- New drop reason `DropInvalid` (`invalid`): an event that fails client-side validation is not buffered; it is counted, WARN-logged (first occurrence, then every 1000th), reported via `OnError` and passed to `OnDrop`. Covers `customerId` > 64, `productType` > 20 and `gqlOperationName` > 255 (no longer truncated).
- Length limits count characters (UTF-16 code units, as the server does), not bytes.
- `sdkVersion` and `VERSION`: 1.2.0. Releases are git tags `aforo-metering-sdks/go-graphql/vX.Y.Z` on github.com/aforoai/SDKs.

### From the public repository
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** batches are POSTed to `/v1/ingest/batch` instead of `/v1/ingest/events`. `/v1/ingest/events` is a single-event Apigee-format endpoint and does not accept `{"events":[...]}`, so batches were not being ingested.
- Each flush is split into requests of at most 1000 events (the ingestor's batch limit). Retries resend the same body, so `idempotencyKey`s are stable across attempts.
- Events whose `customerId` exceeds 64 characters are dropped (reason `invalid`) and reported via `OnError` instead of being rejected by the ingestor.
- `gqlOperationName` is truncated to 255 characters and `idempotencyKey` is capped at 255 characters (ingestor limits).
- `productType` is now configurable: new `Config.ProductType` (default `"GRAPHQL_API"`, previously hard-coded) and a per-event `EventOptions{ProductType}` override (`Record`). Values are trimmed and upper-cased; unknown values are passed through.
- Delivery follows the ingestor contract: a non-retryable `4xx` (anything but `408`/`429`) is reported via `OnError`, dropped with reason `rejected` and no longer retried; `429` honours `Retry-After` (capped at 60s); the ingestor's `errors[].message` is included in `OnError` messages, and a `2xx` with `failed > 0` is reported too. Blank (whitespace-only) customer ids are skipped like empty ones.

## [1.1.1] - 2026-09-30

- An `executionStatus` outside the 11 canonical values (or longer than 20 characters) is WARN-logged and left off the event instead of being sent; the ingestor rejected such events.

## [1.1.0] - 2026-09-30

- Optional `executionStatus` on every event, trimmed and upper-cased. The middleware derives it from the response body (`OutcomeFromGraphQLResponse`), falling back to the HTTP status; `SetExecutionStatus` and `RecordWithOptions` override it.

## Earlier working-repo changes (reported as 1.0.0)

- 2026-09-30: module path is `github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql`.
- 2026-07-05: drop observability — `DroppedCount()`, WARN log and the opt-in `Config.OnDrop(events, reason)` hook (`retry_exhausted`, `rejected`); batches are POSTed to `/v1/ingest/batch`; ingest-contract test driven by `contract/ingest-contract.json`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field) and in the package's `sdkVersion` constant.

Documents the existing package as-is: the `graphqlmetering` package at module path `github.com/aforo/graphql-metering-go` — `New`/`Config`, `Middleware` (wraps a GraphQL-over-HTTP POST handler), `Record` (manual per-operation), and `Shutdown`. Operation type/name detection, an approximate complexity score (`field_count + 5 × max_depth`), per-operation `graphql_api.operations` events with `X-Tenant-Id`, batched delivery with 3× retry to `POST /v1/ingest/events`. No source logic changed.
