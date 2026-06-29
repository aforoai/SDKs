# Changelog

All notable changes to `metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field).

Documents the existing package as-is: the `metering` package at module path `github.com/aforo/metering-go` — `NewClient`/`Options`, `Track`/`TrackEvent`, `Flush`/`FlushResult`, `Close`, the zero-dependency `HTTPMiddleware` + `ChiMiddleware` (and `MiddlewareOptions`), in-memory ring buffer with oldest-drop overflow, deterministic auto idempotency keys, and batched delivery with retry to `POST /v1/ingest/batch`. No source logic changed.
