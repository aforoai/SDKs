# Changelog

All notable changes to `com.aforo:mqtt-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** events are sent to `POST <ingestorUrl>/v1/ingest/batch` as `{"events": [...]}`. `/v1/ingest/events` is a single-event Apigee-format endpoint and did not accept these batches. Flushes larger than 1000 events are split into requests of at most 1000; each slice is serialized once so retries resend the same `idempotencyKey`s.
- CONNECT / DISCONNECT events carry `mqttTopic` `$SYS/clients/<clientId>/connected|disconnected` instead of an empty topic, which the ingestor rejects (`mqttTopic` is required for `MQTT_BROKER`). Events with a blank/null or >64-char `customerId` or a blank topic are dropped client-side; `mqttQos` is omitted when outside 0–2, and `mqttClientId` is omitted when blank.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoMqttBilling` (`AutoCloseable`) with a fluent builder and a client-mode API: `recordPublish`, `recordDeliver`, `recordSubscribe`, `recordUnsubscribe`, `recordConnect`, `recordDisconnect`. Framework-agnostic over the raw MQTT primitives, so it works with Eclipse Paho or any Java MQTT client.
- Per-event fields `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttEventType`, `mqttClientId`, `dataBytes`; metric name derived as `mqtt_broker.<eventType>`.
- `DELIVER` opt-in via `emitDeliverEvents(true)` to keep high-volume inbound traffic off by default.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 200-event / 2s flush, and 3× exponential retry.
