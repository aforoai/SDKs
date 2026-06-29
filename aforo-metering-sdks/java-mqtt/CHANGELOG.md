# Changelog

All notable changes to `com.aforo:mqtt-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoMqttBilling` (`AutoCloseable`) with a fluent builder and a client-mode API: `recordPublish`, `recordDeliver`, `recordSubscribe`, `recordUnsubscribe`, `recordConnect`, `recordDisconnect`. Framework-agnostic over the raw MQTT primitives, so it works with Eclipse Paho or any Java MQTT client.
- Per-event fields `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttEventType`, `mqttClientId`, `dataBytes`; metric name derived as `mqtt_broker.<eventType>`.
- `DELIVER` opt-in via `emitDeliverEvents(true)` to keep high-volume inbound traffic off by default.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 200-event / 2s flush, and 3× exponential retry.
