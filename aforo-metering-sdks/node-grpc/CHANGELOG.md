# Changelog

All notable changes to `@aforo/grpc-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoGrpcBilling` class with `wrapUnary`, `wrapServerStream`, `wrapClientStream`, and `wrapBidiStream` handler wrappers for `@grpc/grpc-js`.
- One event per RPC (`grpc_api.rpc_calls`); streams emit a single event on close with aggregated `messageCount`.
- gRPC status codes mapped to labels (`OK`, `NOT_FOUND`, `UNAVAILABLE`, …); the numeric `GRPC_STATUS` map is exported.
- Events posted to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer` + `X-Tenant-Id`; 3× exponential-backoff retry (1s/2s/4s) then `onError`.
- Defaults: `flushCount` 50, `flushIntervalMs` 5000.
