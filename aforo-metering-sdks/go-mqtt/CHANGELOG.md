# Changelog

All notable changes to `mqtt-metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field) and in the package's `sdkVersion` constant.

Documents the existing package as-is: the `mqttmetering` package at module path `github.com/aforo/mqtt-metering-go` — `New`/`Config`, `RecordPublish`, `RecordDeliver` (opt-in via `EmitDeliverEvents`), `RecordSubscribe`, `RecordUnsubscribe`, `RecordConnect`, `RecordDisconnect`, and `Shutdown`. Per-event `mqtt_broker.<type>` records carrying topic/QoS/retained/payload-size, `X-Tenant-Id` header, batched delivery (200 events / 2s defaults) with 3× retry to `POST /v1/ingest/events`. Client-side metering; broker-side metering lives in the companion EMQ X plugin. No source logic changed.
