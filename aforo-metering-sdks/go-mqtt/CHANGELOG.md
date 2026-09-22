# Changelog

All notable changes to `mqtt-metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** batches are POSTed to `/v1/ingest/batch` instead of `/v1/ingest/events`. `/v1/ingest/events` is a single-event Apigee-format endpoint and does not accept `{"events":[...]}`, so batches were not being ingested.
- Each flush is split into requests of at most 1000 events (the ingestor's batch limit). Retries resend the same body, so `idempotencyKey`s are stable across attempts.
- Events whose `customerId` exceeds 64 characters are dropped and reported via `OnError` instead of being rejected by the ingestor.
- `mqttTopic` is required by the ingestor: `CONNECT` / `DISCONNECT` events now carry `$SYS/clients/<clientID>/connected|disconnected`, and other events with an empty topic are dropped and reported via `OnError`. `mqttQos` outside 0–2 is omitted, and `idempotencyKey` is capped at 255 characters (topics can be 500).
- `productType` is now configurable: new `Config.ProductType` (default `"MQTT_BROKER"`, previously hard-coded) and a per-event `EventOptions{ProductType}` override (every `Record*` method). Values are trimmed and upper-cased; unknown values are passed through.
- Delivery follows the ingestor contract: a non-retryable `4xx` (anything but `408`/`429`) is reported via `OnError` and no longer retried; `429` honours `Retry-After` (capped at 60s); the ingestor's `errors[].message` is included in `OnError` messages, and a `2xx` with `failed > 0` is reported too. Blank (whitespace-only) customer ids are skipped like empty ones.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field) and in the package's `sdkVersion` constant.

Documents the existing package as-is: the `mqttmetering` package at module path `github.com/aforo/mqtt-metering-go` — `New`/`Config`, `RecordPublish`, `RecordDeliver` (opt-in via `EmitDeliverEvents`), `RecordSubscribe`, `RecordUnsubscribe`, `RecordConnect`, `RecordDisconnect`, and `Shutdown`. Per-event `mqtt_broker.<type>` records carrying topic/QoS/retained/payload-size, `X-Tenant-Id` header, batched delivery (200 events / 2s defaults) with 3× retry to `POST /v1/ingest/events`. Client-side metering; broker-side metering lives in the companion EMQ X plugin. No source logic changed.
