# Changelog

All notable changes to `aforo-grpc-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoGrpcBilling`, the `AforoGrpcInterceptor` (auto-meters unary RPCs), and the manual `record()` path for streaming RPCs.
- Documented gRPC status mapping via `GRPC_STATUS_LABELS` and customer-ID resolution from `x-customer-id` invocation metadata (override via `customer_id_extractor`).
- Full configuration reference; one `grpc_api.rpc_calls` event per RPC, delivered to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[Unreleased]: https://github.com/aforoai/aforo-metering-sdks/compare/python-grpc-v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-sdks/releases/tag/python-grpc-v1.0.0
