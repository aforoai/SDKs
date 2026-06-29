# Changelog

All notable changes to `@aforo/ws-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoWsBilling` class with `wrapServer` (for `ws`) and `trackConnection` (for any standard WebSocket surface — Fastify-WebSocket, Socket.io, Deno, Bun).
- Two events per connection by default: `CONNECTION_OPENED` and the `CONNECTION_CLOSED` billing anchor (aggregated frames, bytes, duration). `perFrameEvents: true` adds one event per inbound/outbound frame.
- Close codes mapped to labels via the exported `WS_CLOSE_REASONS`; socket errors emit a synthetic close with `wsCloseReason: INTERNAL_ERROR`.
- Events posted to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer` + `X-Tenant-Id`; 3× exponential-backoff retry (1s/2s/4s) then `onError`.
- Defaults: `flushCount` 100, `flushIntervalMs` 3000 (tuned higher than the base SDK for high-volume WebSocket traffic).
