# Changelog

All notable changes to `aforo-mqtt-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoMqttBilling` and the client wrappers `wrap_paho_client` (paho-mqtt, sync) and `wrap_aiomqtt_client` (aiomqtt, async).
- Documented the metered event types (`mqtt_broker.publish` / `.subscribe` / `.unsubscribe` / `.connect` / `.disconnect`), the opt-in `emit_deliver_events` for inbound messages, and QoS/retained attributes for rate-plan tiering.
- Full configuration reference; events deliver to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[Unreleased]: https://github.com/aforoai/aforo-metering-sdks/compare/python-mqtt-v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-sdks/releases/tag/python-mqtt-v1.0.0
