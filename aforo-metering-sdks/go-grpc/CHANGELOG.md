# Changelog

All notable changes to `grpc-metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** batches are POSTed to `/v1/ingest/batch` instead of `/v1/ingest/events`. `/v1/ingest/events` is a single-event Apigee-format endpoint and does not accept `{"events":[...]}`, so batches were not being ingested.
- Each flush is split into requests of at most 1000 events (the ingestor's batch limit). Retries resend the same body, so `idempotencyKey`s are stable across attempts.
- Events whose `customerId` exceeds 64 characters are dropped and reported via `OnError` instead of being rejected by the ingestor.
- `grpcStatusCode` now uses the ingestor's enum names (`CANCELLED`, `INVALID_ARGUMENT`, `NOT_FOUND`, …) instead of Go's `codes.Code.String()` (`Canceled`, `InvalidArgument`, `NotFound`), which the ingestor rejected. `grpcCallType` passed to `Record` is upper-cased and omitted if it is not `UNARY`/`CLIENT_STREAM`/`SERVER_STREAM`/`BIDI_STREAM`. `Record` with an empty method is ignored (`grpcMethod` is required).

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field) and in the package's `sdkVersion` constant.

Documents the existing package as-is: the `grpcmetering` package at module path `github.com/aforo/grpc-metering-go` — `New`/`Config`, `UnaryInterceptor`, `StreamInterceptor`, `Record` (manual, for exact streaming message counts), and `Shutdown(ctx)`. Per-RPC `grpc_api.rpc_calls` events with service/method/status/call-type/duration, `x-customer-id` metadata extraction, `X-Tenant-Id` header, batched delivery with 3× retry to `POST /v1/ingest/events`. Depends on `google.golang.org/grpc v1.60.0`. No source logic changed.
