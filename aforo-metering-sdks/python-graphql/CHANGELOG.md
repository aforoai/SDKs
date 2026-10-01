# Changelog

All notable changes to `aforo-graphql-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [1.2.2] - 2026-10-01

### Changed
- **An over-long operation name is truncated, not rejected.** `gqlOperationName` is read from the client's query. A name longer than the ingestor's 255-character limit is cut to 255 and the event is still sent; before, the event went out with the full name and the ingestor rejected it, so the operation was not billed. One WARNING is logged per client.
- **Idempotency key.** The key is built from the full, untruncated value. A key that fits in 255 characters is unchanged. When it would not fit, the over-long request-derived part is replaced in the key by its SHA-256 hex digest (it used to be cut and given a random suffix), so the key is the same for the same input and differs for different inputs.

### Unchanged
- `customer_id` is never truncated: a blank one, or one over 64 characters, still drops the event with reason `invalid`.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

Merge of the public-repo fixes into the working line. Wire behaviour changes; read before upgrading.

### Added
- `product_type` constructor option (default `"GRAPHQL_API"`) for the top-level `productType` the ingestor requires on every event, with a per-event override. Values are trimmed and upper-cased; values the SDK does not know are passed through.
- Drop reason `invalid`: an event that fails a client-side check is not buffered or sent. It is counted in `dropped_count`, logged at WARNING (once per distinct message) and passed to `on_drop(events, "invalid")`. `record()` does not raise for event content.
- Events the ingestor refuses inside a 202 response are counted in `dropped_count` and passed to `on_drop` with reason `rejected` (only the events the response identifies by index).

### Changed
- The API key is sent as `X-API-Key`; `Authorization: Bearer` is no longer sent. The ingestor accepts `X-API-Key` for every key type.
- Docs and examples use `https://api.aforo.ai`.
- A flush is split into requests of at most 1000 events (the ingestor's batch limit).
- Retry: 4xx responses other than 408 and 429 are not retried and drop the batch with reason `rejected`; 429 waits for `Retry-After` (capped at 60 s); 5xx, 408, 429 and network errors that fail 3 attempts drop with reason `retry_exhausted`. The ingestor's `errors[].message` is passed to `on_error`.
- Events with a blank or over-64-character `customerId` are no longer sent (the ingestor rejects them); they are reported as `invalid` drops. Over-long `idempotencyKey`s are capped at 255 characters when the event is created.

### Unchanged
- `executionStatus` rules, `on_drop` / `dropped_count`, the `atexit` flush, the `/v1/ingest/batch` endpoint, and idempotency keys (one per event, created when the event is recorded and reused by every retry).

## [1.1.1] - 2026-09-30

- An `executionStatus` outside the 11 accepted values (or longer than 20 characters) is logged and left off the event; it used to be sent and the ingestor rejected that event.
- Parse / validation failures are `VALIDATION_FAILED` (were `ERROR`).
- The Strawberry extension uses the `on_operation` hook; the hooks it used before do not exist in current Strawberry, so it recorded nothing.
- The default customer lookup reads the `x-customer-id` header from Strawberry's object context (an operator-precedence bug skipped it).

## [1.1.0] - 2026-09-30

- `executionStatus` on every event, derived from the GraphQL result (`SUCCESS` / `PARTIAL` / `ERROR` / `VALIDATION_FAILED`) or the HTTP status; `execution_status=`, `result=`, `http_status=` on `record()`, and `execution_status_resolver` on the Strawberry extension and ASGI middleware.

## 2026-07-05 (shipped under 1.0.0, no version bump)

- Drop observability: `dropped_count`, a WARNING log, and the opt-in `on_drop(events, reason)` hook (`retry_exhausted`, `rejected`). Dropped events keep their idempotency keys.
- Batches are POSTed to `/v1/ingest/batch`; `/v1/ingest/events` is a single-event endpoint and rejected every batch.
- `shutdown()` deregisters the `atexit` handler.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoGraphQlBilling`, the Strawberry `strawberry_extension(billing)`, and the framework-agnostic `asgi_middleware(billing, path=...)`.
- Documented AST complexity scoring (`default_complexity_scorer`, override via `complexity_scorer`) and customer-ID resolution (`x-customer-id` default, override via `customer_id_extractor`).
- Full configuration reference; one `graphql_api.operations` event per operation, delivered to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[1.2.0]: https://github.com/aforoai/SDKs/compare/python-graphql-v1.0.0...python-graphql-v1.2.0
[1.0.0]: https://github.com/aforoai/SDKs/releases/tag/python-graphql-v1.0.0
