# Changelog

All notable changes to `grpc-metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [1.2.2] - 2026-10-01

### Changed
- **An over-long method name is truncated, the event is sent.** The method name comes from the incoming RPC, so one over the ingestor's 128 characters used to drop the event as `invalid`. It is now cut to 128 characters. This applies to `UnaryInterceptor`, `StreamInterceptor` and the `method` argument of `Record`.
- Length is counted in UTF-16 code units, as the server counts it. The cut never splits a character: if it would fall inside a surrogate pair the value is one unit shorter.
- One WARN is logged per label name per `Billing`, not per event.
- Unchanged: `Config.ServiceName` (`grpcService`), `customerId` and `productType` are never truncated. Over the limit (255 / 64 / 20) the event is dropped as `invalid`. A blank method is still dropped.
- **Idempotency key.** The key is built from the full method name, before truncation. A key up to 255 characters is byte-for-byte what it was. A longer one is no longer cut to its last 255 bytes: the method name in it is replaced by the SHA-256 hex digest of the full name.
- `sdkVersion` and `VERSION`: 1.2.2.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

### Changed
- Merge of the working repository and the public `aforoai/SDKs` repository. Both sets of behaviour are kept.
- `EventOptions` carries both `ExecutionStatus` and `ProductType`. The recording methods accept optional trailing `EventOptions`; the `*WithOptions` forms remain.
- Transport: a non-retryable `4xx` drops the batch with `DropRejected` after one attempt; exhausted retries drop it with `DropRetryExhausted`; a `2xx` partial-failure response drops only the events named by `errors[].index` (`DropRejected`), and failures the ingestor does not identify are counted without naming an event. All of these count in `DroppedCount()` and reach `Config.OnDrop`.
- New drop reason `DropInvalid` (`invalid`): an event that fails client-side validation is not buffered; it is counted, WARN-logged (first occurrence, then every 1000th), reported via `OnError` and passed to `OnDrop`. Covers a blank method, `customerId` > 64, `grpcMethod` > 128, `grpcService` > 255, `productType` > 20.
- Length limits count characters (UTF-16 code units, as the server does), not bytes.
- `sdkVersion` and `VERSION`: 1.2.0. Releases are git tags `aforo-metering-sdks/go-grpc/vX.Y.Z` on github.com/aforoai/SDKs.

### From the public repository
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** batches are POSTed to `/v1/ingest/batch` instead of `/v1/ingest/events`. `/v1/ingest/events` is a single-event Apigee-format endpoint and does not accept `{"events":[...]}`, so batches were not being ingested.
- Each flush is split into requests of at most 1000 events (the ingestor's batch limit). Retries resend the same body, so `idempotencyKey`s are stable across attempts.
- Events whose `customerId` exceeds 64 characters are dropped (reason `invalid`) and reported via `OnError` instead of being rejected by the ingestor.
- `grpcStatusCode` now uses the ingestor's enum names (`CANCELLED`, `INVALID_ARGUMENT`, `NOT_FOUND`, …) instead of Go's `codes.Code.String()` (`Canceled`, `InvalidArgument`, `NotFound`), which the ingestor rejected. `grpcCallType` passed to `Record` is upper-cased and omitted if it is not `UNARY`/`CLIENT_STREAM`/`SERVER_STREAM`/`BIDI_STREAM`. `Record` with an empty method is dropped with reason `invalid` (`grpcMethod` is required).
- `productType` is now configurable: new `Config.ProductType` (default `"GRPC_API"`, previously hard-coded) and a per-event `EventOptions{ProductType}` override (`Record`). Values are trimmed and upper-cased; unknown values are passed through.
- Delivery follows the ingestor contract: a non-retryable `4xx` (anything but `408`/`429`) is reported via `OnError`, dropped with reason `rejected` and no longer retried; `429` honours `Retry-After` (capped at 60s); the ingestor's `errors[].message` is included in `OnError` messages, and a `2xx` with `failed > 0` is reported too. Blank (whitespace-only) customer ids are skipped like empty ones.

## [1.1.1] - 2026-09-30

- An `executionStatus` outside the 11 canonical values (or longer than 20 characters) is WARN-logged and left off the event instead of being sent; the ingestor rejected such events. A handler returning a plain context error (`ctx.Err()`) is recorded as `CANCELLED` / `TIMEOUT` instead of `ERROR`.

## [1.1.0] - 2026-09-30

- Optional `executionStatus` on every event, trimmed and upper-cased. Derived from the gRPC status code (`OutcomeFromGrpcCode`); `SetExecutionStatus` and `RecordWithOptions` override it.

## Earlier working-repo changes (reported as 1.0.0)

- 2026-09-30: module path is `github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc`.
- 2026-07-05: drop observability — `DroppedCount()`, WARN log and the opt-in `Config.OnDrop(events, reason)` hook (`retry_exhausted`, `rejected`); batches are POSTed to `/v1/ingest/batch`; ingest-contract test driven by `contract/ingest-contract.json`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field) and in the package's `sdkVersion` constant.

Documents the existing package as-is: the `grpcmetering` package at module path `github.com/aforo/grpc-metering-go` — `New`/`Config`, `UnaryInterceptor`, `StreamInterceptor`, `Record` (manual, for exact streaming message counts), and `Shutdown(ctx)`. Per-RPC `grpc_api.rpc_calls` events with service/method/status/call-type/duration, `x-customer-id` metadata extraction, `X-Tenant-Id` header, batched delivery with 3× retry to `POST /v1/ingest/events`. Depends on `google.golang.org/grpc v1.60.0`. No source logic changed.
