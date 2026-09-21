# Changelog

All notable changes to `@aforo/mqtt-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoMqttBilling` class with `wrapAedesBroker` (broker-side, every client's events) and `wrapMqttClient` (client-side, against a third-party broker).
- Meters PUBLISH / SUBSCRIBE / UNSUBSCRIBE / CONNECT / DISCONNECT as `mqtt_broker.<event>`; each event carries `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttClientId`, and `dataBytes`.
- `DELIVER` (fan-out) events are dropped unless `emitDeliverEvents: true` — applies in both modes.
- Events posted to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer` + `X-Tenant-Id`; 3× exponential-backoff retry (1s/2s/4s) then `onError`.
- Defaults: `flushCount` 200, `flushIntervalMs` 2000 (the most aggressive batching of the SDKs, for high-volume MQTT telemetry).
