# Changelog

All notable changes to `com.aforo:mqtt-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoMqttBilling` (`AutoCloseable`) with a fluent builder and a client-mode API: `recordPublish`, `recordDeliver`, `recordSubscribe`, `recordUnsubscribe`, `recordConnect`, `recordDisconnect`. Framework-agnostic over the raw MQTT primitives, so it works with Eclipse Paho or any Java MQTT client.
- Per-event fields `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttEventType`, `mqttClientId`, `dataBytes`; metric name derived as `mqtt_broker.<eventType>`.
- `DELIVER` opt-in via `emitDeliverEvents(true)` to keep high-volume inbound traffic off by default.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 200-event / 2s flush, and 3× exponential retry.
