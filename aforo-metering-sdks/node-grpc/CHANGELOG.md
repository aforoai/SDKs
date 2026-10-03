# Changelog

All notable changes to `@aforoai/grpc-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

## [1.2.2] - 2026-10-01

### Changed
- **A method name longer than 128 characters is truncated, and the event is sent.** The method names the RPC the consumer called, so an over-long one no longer loses the call. `grpcMethod` is cut to 128 UTF-16 code units (never splitting a surrogate pair). One WARN is logged per label name per `AforoGrpcBilling` instance.
- **Idempotency key.** Still `grpc:{tenantId}:{service}:{method}:{millis}:{random}`, minted once per event from the untruncated method. When that is longer than 255 characters the method is replaced by its SHA-256 hex digest; the key is no longer cut from the front. Keys of 255 characters or fewer are built exactly as before.

### Unchanged
- `grpcService` comes from the `serviceName` configuration and is never altered: over 255 characters, or blank, still drops the event with reason `'invalid'`. So does an over-long `customerId` (64) or `productType` (20), and a blank method.

### Added
- Export: `truncateToLimit(value, max)`.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

Merge of the public-repo fixes (verified against the production ingestor) with the working-repo line (execution status, drop observability, contract tests).

### Changed
- **Breaking (fix):** the API key is sent as `X-API-Key`. `Authorization` is no longer sent — the ingestor accepts `X-API-Key` for every key, while Bearer only works for `sk_live_` / `sk_test_` keys.
- Docs, examples and tests use `https://api.aforo.ai`.
- Events get a top-level `productType` (default `GRPC_API`; client option `productType`, per-handler `wrapUnary(name, handler, { productType })`), trimmed and upper-cased.
- An event the ingestor would refuse is dropped before it is buffered, with drop reason `invalid`: `customerId` over 64 characters, blank `grpcService` or `grpcMethod`, `grpcService` over 255, `grpcMethod` over 128, `productType` over 20. Nothing is truncated and nothing is thrown into the RPC path.
- The SDK-generated `idempotencyKey` stays within 255 characters (tail kept). It is still minted once, when the event is recorded.
- A flush is split into requests of at most 1000 events, the ingestor's batch limit.
- Only network errors, 408, 429 (honouring `Retry-After`, capped at 30 s) and 5xx are retried. Any other 4xx is not retried: the batch is dropped with reason `rejected` and `onError` carries the ingestor's `errors[].message`.
- A 2xx response with `failed > 0` is reported through `onError`; the events its `errors[]` names by index are dropped with reason `rejected` (counted only, when no usable index is given).
- New drop reason `invalid` on `onDrop` / `droppedCount` for events that fail a client-side check. The warning is logged for the first occurrence per field and every 1000th after.
- A throwing `onError` hook can no longer make a delivered batch look like a network failure and be re-sent.
- `package.json` license is `Apache-2.0`.

## [1.1.1] - 2026-09-30

- A caller `executionStatus` outside the 11 accepted values (or a Promise from an async resolver) is reported through `onError` and ignored; the status derived from the gRPC code is sent instead. It used to be sent as-is and the ingestor rejected the event.

## [1.1.0] - 2026-09-30

- `executionStatus` on every event, derived from the gRPC status code (`outcomeFromGrpcStatus`); override per handler with `wrap*(name, handler, { executionStatus })`.
- Shipped earlier in 2026-07 without a version bump: `droppedCount` and the opt-in `onDrop(events, reason)` hook (reasons `retry_exhausted`, `rejected`); batches POSTed to `/v1/ingest/batch` (they went to `/v1/ingest/events`, a single-event endpoint, and every flush was refused); a contract test that checks the wire request against `contract/ingest-contract.json`; `onError` fires once, not twice, when retries are exhausted on a network error.

## [1.0.0] - 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoGrpcBilling` class with `wrapUnary`, `wrapServerStream`, `wrapClientStream`, and `wrapBidiStream` handler wrappers for `@grpc/grpc-js`.
- One event per RPC (`grpc_api.rpc_calls`); streams emit a single event on close with aggregated `messageCount`.
- gRPC status codes mapped to labels (`OK`, `NOT_FOUND`, `UNAVAILABLE`, …); the numeric `GRPC_STATUS` map is exported.
- Events posted to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer` + `X-Tenant-Id`; 3× exponential-backoff retry (1s/2s/4s) then `onError`.
- Defaults: `flushCount` 50, `flushIntervalMs` 5000.
