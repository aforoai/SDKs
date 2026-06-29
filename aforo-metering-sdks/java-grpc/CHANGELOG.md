# Changelog

All notable changes to `com.aforo:grpc-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoGrpcBilling` (`AutoCloseable`) with a fluent builder and a `grpc-java` `ServerInterceptor` that meters every RPC on call close.
- Automatic call-type mapping (`UNARY` / `CLIENT_STREAM` / `SERVER_STREAM` / `BIDI_STREAM`); per-event fields `grpcService`, `grpcMethod`, `grpcStatusCode`, `grpcCallType`, `messageCount`, `executionDurationMs`.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 50-event / 5s flush, and 3× exponential retry.
- Pluggable `customerIdExtractor` over call `Metadata`; public `record(...)` for exact streaming message counts.
