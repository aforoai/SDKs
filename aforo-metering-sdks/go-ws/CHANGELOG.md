# Changelog

All notable changes to `ws-metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field) and in the package's `sdkVersion` constant.

Documents the existing package as-is: the `wsmetering` package at module path `github.com/aforo/ws-metering-go` — `New`/`Config`, `Open`, `RecordFrame`, `Close`, and `Shutdown`. Per-connection aggregation (frames + bytes + duration) emitting a `websocket_api.message` open event and a `websocket_api.connection_closed` close event with WebSocket close-code → reason mapping, optional `PerFrameEvents`, `X-Tenant-Id` header, batched delivery with 3× retry to `POST /v1/ingest/events`. Framework-agnostic (no WebSocket-library dependency). No source logic changed.
