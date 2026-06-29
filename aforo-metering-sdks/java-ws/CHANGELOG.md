# Changelog

All notable changes to `com.aforo:ws-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoWsBilling` (`AutoCloseable`) with a fluent builder and a framework-agnostic `openConnection` / `recordFrame` / `closeConnection` API drivable from Jakarta WebSocket, Spring WebSocket, Netty, or Undertow.
- In-memory per-connection aggregation of frame count, bytes, and duration; default OPEN + CLOSE events, or per-frame events via `perFrameEvents(true)`.
- Close-code → reason mapping (`NORMAL_CLOSURE` … `IDLE_TIMEOUT`); per-event fields `wsConnectionId`, `wsDirection`, `wsFrameType`, `messageCount`, `dataBytes`, `durationMs`, `wsCloseReason`.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 100-event / 3s flush, and 3× exponential retry.
