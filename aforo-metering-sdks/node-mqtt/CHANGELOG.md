# Changelog

All notable changes to `@aforo/mqtt-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- Batches are POSTed to `<ingestorUrl>/v1/ingest/batch`. `/v1/ingest/events` is the ingestor's Apigee single-event endpoint and never accepted an `{events:[...]}` batch, so no usage was being delivered. Flushes are split into requests of at most 1000 events (the ingestor's batch limit), and each event's `idempotencyKey` is minted once and re-sent unchanged on retries.
- CONNECT / DISCONNECT events carry a `$SYS/clients/<clientId>/connected|disconnected` topic instead of an empty `mqttTopic`, which the ingestor requires. Events with no topic, such as an empty UNSUBSCRIBE, are skipped.
- `mqttQos` values other than 0, 1 or 2 are sent as 0. `mqttTopic` is trimmed to 500 characters and `mqttClientId` to 128. The topic is no longer part of `idempotencyKey`, which stays within 255 characters.
- Events with a blank `customerId` are skipped, and ones longer than 64 characters are dropped with `onError`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoMqttBilling` class with `wrapAedesBroker` (broker-side, every client's events) and `wrapMqttClient` (client-side, against a third-party broker).
- Meters PUBLISH / SUBSCRIBE / UNSUBSCRIBE / CONNECT / DISCONNECT as `mqtt_broker.<event>`; each event carries `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttClientId`, and `dataBytes`.
- `DELIVER` (fan-out) events are dropped unless `emitDeliverEvents: true` — applies in both modes.
- Events posted to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer` + `X-Tenant-Id`; 3× exponential-backoff retry (1s/2s/4s) then `onError`.
- Defaults: `flushCount` 200, `flushIntervalMs` 2000 (the most aggressive batching of the SDKs, for high-volume MQTT telemetry).
