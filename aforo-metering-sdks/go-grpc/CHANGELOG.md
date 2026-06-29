# Changelog

All notable changes to `grpc-metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field) and in the package's `sdkVersion` constant.

Documents the existing package as-is: the `grpcmetering` package at module path `github.com/aforo/grpc-metering-go` — `New`/`Config`, `UnaryInterceptor`, `StreamInterceptor`, `Record` (manual, for exact streaming message counts), and `Shutdown(ctx)`. Per-RPC `grpc_api.rpc_calls` events with service/method/status/call-type/duration, `x-customer-id` metadata extraction, `X-Tenant-Id` header, batched delivery with 3× retry to `POST /v1/ingest/events`. Depends on `google.golang.org/grpc v1.60.0`. No source logic changed.
