# Changelog

All notable changes to `aforo-mqtt-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- `product_type` constructor option (default `"MQTT_BROKER"`) for the top-level `productType` the ingestor requires on every event, with a per-event override via `push(product_type=...)` or `product_type=` on `wrap_paho_client` / `wrap_aiomqtt_client`. Values are trimmed and upper-cased; unknown values are passed through rather than rejected.

### Fixed
- Batch delivery no longer retries 4xx responses other than 408 and 429 (a bad key or invalid batch cannot succeed on retry), honours `Retry-After` on 429 (capped at 60 s), no longer sleeps after the final attempt, and passes the ingestor's `errors[].message` to `on_error`, including per-event failures reported in a 202 response.
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** batches are POSTed to `/v1/ingest/batch` instead of `/v1/ingest/events`. `/v1/ingest/events` is the Apigee-format single-event endpoint and does not accept `{"events": [...]}`, so no usage was being recorded. Each flush is split into requests of at most 1000 events (the ingestor's batch limit).
- CONNECT / DISCONNECT events carry `mqttTopic` `$SYS/clients/<clientId>/<connected|disconnected>` instead of an empty string, since `mqttTopic` is required on every `MQTT_BROKER` event. Other events without a topic are dropped.
- `mqttEventType` must be one of PUBLISH / DELIVER / SUBSCRIBE / UNSUBSCRIBE / CONNECT / DISCONNECT (others are dropped with a warning), `mqttQos` outside 0–2 is sent as 0, and events with a blank or over-64-character `customerId` are dropped client-side.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoMqttBilling` and the client wrappers `wrap_paho_client` (paho-mqtt, sync) and `wrap_aiomqtt_client` (aiomqtt, async).
- Documented the metered event types (`mqtt_broker.publish` / `.subscribe` / `.unsubscribe` / `.connect` / `.disconnect`), the opt-in `emit_deliver_events` for inbound messages, and QoS/retained attributes for rate-plan tiering.
- Full configuration reference; events deliver to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[Unreleased]: https://github.com/aforoai/aforo-metering-sdks/compare/python-mqtt-v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-sdks/releases/tag/python-mqtt-v1.0.0
