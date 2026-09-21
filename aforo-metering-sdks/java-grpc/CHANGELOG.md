# Changelog

All notable changes to `com.aforo:grpc-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** events are sent to `POST <ingestorUrl>/v1/ingest/batch` as `{"events": [...]}`. `/v1/ingest/events` is a single-event Apigee-format endpoint and did not accept these batches. Flushes larger than 1000 events are split into requests of at most 1000; each slice is serialized once so retries resend the same `idempotencyKey`s.
- `record(...)` normalises `callType` (`CLIENT_STREAMING` → `CLIENT_STREAM`, etc.) and only sends `grpcStatusCode` when it is a real gRPC status code; other values go to `metadata.grpcStatus` so the event is not rejected. `customerId` over 64 characters is dropped client-side; `executionDurationMs` is sent as an integer.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoGrpcBilling` (`AutoCloseable`) with a fluent builder and a `grpc-java` `ServerInterceptor` that meters every RPC on call close.
- Automatic call-type mapping (`UNARY` / `CLIENT_STREAM` / `SERVER_STREAM` / `BIDI_STREAM`); per-event fields `grpcService`, `grpcMethod`, `grpcStatusCode`, `grpcCallType`, `messageCount`, `executionDurationMs`.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 50-event / 5s flush, and 3× exponential retry.
- Pluggable `customerIdExtractor` over call `Metadata`; public `record(...)` for exact streaming message counts.
