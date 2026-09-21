# Changelog

All notable changes to `aforo-grpc-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** batches are POSTed to `/v1/ingest/batch` instead of `/v1/ingest/events`. `/v1/ingest/events` is the Apigee-format single-event endpoint and does not accept `{"events": [...]}`, so no usage was being recorded. Each flush is split into requests of at most 1000 events (the ingestor's batch limit).
- `record()` normalises `status` (an int code or a label) to a valid `grpcStatusCode` (`UNKNOWN` when unrecognised) and `call_type` to `UNARY` / `CLIENT_STREAM` / `SERVER_STREAM` / `BIDI_STREAM`, so out-of-range values no longer get the event rejected. Blank or over-64-character `customerId`s are dropped client-side; over-long `idempotencyKey`s are capped at 255 characters.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoGrpcBilling`, the `AforoGrpcInterceptor` (auto-meters unary RPCs), and the manual `record()` path for streaming RPCs.
- Documented gRPC status mapping via `GRPC_STATUS_LABELS` and customer-ID resolution from `x-customer-id` invocation metadata (override via `customer_id_extractor`).
- Full configuration reference; one `grpc_api.rpc_calls` event per RPC, delivered to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[Unreleased]: https://github.com/aforoai/aforo-metering-sdks/compare/python-grpc-v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-sdks/releases/tag/python-grpc-v1.0.0
