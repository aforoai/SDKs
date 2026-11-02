# Changelog

All notable changes to `@aforoai/mqtt-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

## [2.0.0] - 2026-10-26

Breaking. Migration: give `wrapAedesBroker` a `customerResolver` (or `trustCustomerHeader: true` when your broker authenticates usernames), use an `https://` `ingestorUrl` (or `allowInsecureHttp: true`), and call `await billing.shutdown()` from your SIGTERM handler.

### Fixed (transport core, review of 2026-10-26)
These come from the shared Node core (`src/transport-core/core.ts`) and follow contract/TRANSPORT-SPEC.md "Edge cases every core handles the same way".
- **The request deadline covers reading the response body.** A server that sent headers and then stalled, or dripped the body a byte at a time, held `flush()` and `shutdown()` forever; the read is now inside `timeoutMs` and the batch is retried.
- **Redirects are never followed.** Every request is sent with `redirect: 'manual'`, so the API key cannot reach the host a 3xx names. A 3xx keeps the batch queued, opens the breaker and is logged once at ERROR with the target host (never the key); fix the base URL and the queue drains without loss. `onError` gets `kind: 'outage'` with the 3xx `status`.
- **Events are serialized when tracked.** An event JSON cannot represent (a `BigInt`, a cycle, `NaN` or `Infinity` in metadata) is dropped as `invalid` and counted at track time; before, it made the whole batch fail to serialize and every event in it was lost unreported. Later changes to a tracked object are no longer sent.
- **Exit flush waits for the batch in flight.** On `beforeExit` the process stays alive (up to the shutdown deadline) until the queue and the batch being sent or retried are done. It used to exit during a retry and lose that batch.
- **Per-event `retryable` failures back off and are capped.** They are re-sent after the normal jittered backoff, at most `maxRetries` times, then treated as an outage; a 2xx that hits the cap no longer resets the breaker, so its cooldown keeps growing instead of flapping.
- **Breaker cooldown is `max(250 ms, random(0, ceiling))`** even when a small `breakerInitialMs` is configured.

### Changed (breaking)
- **Customer identity (G265).** `wrapAedesBroker` throws unless you pass `customerResolver` (`resolveCustomerId` still works as a deprecated alias) or `trustCustomerHeader: true` (bills the MQTT username). An event with no customer — a resolver that returns nothing, or a blank `customerId` to `wrapMqttClient` — is counted as an `invalid` drop instead of being skipped silently.
- **Broker listeners can no longer crash the broker (G297).** Every Aedes listener catches its own errors; a rejecting resolver is reported through `onError` and the event is dropped as `invalid`, never an unhandled rejection.
- **Delivery (G266, G267, G268, G296).** Bounded queue (`maxQueueSize`, default 10 000; overflow drops the oldest) with one background sender — recording an event never starts a request. Every request has a total deadline (`AbortSignal.timeout`, `timeoutMs`). Full-jitter retries; `Retry-After` in both forms, capped at 60 s. After the retries, or on 401/403, the batch is requeued with its keys behind a breaker; `retry_exhausted` is no longer produced. New drop reasons `overflow`, `shutdown`, `closed`.
- **Defaults (G269).** `flushCount` 500 (was 200), `flushIntervalMs` 5000 (was 2000).
- **https required (G270).** `ingestorUrl` must be `https://` except for localhost; the API key is held only by the transport and never shown by `inspect()` / `JSON.stringify`.
- `shutdown()` is bounded by `shutdownTimeoutMs`; events still queued then are dropped with reason `shutdown` and reported through `onError`.
- **PUBLISH is billed after success (G288).** `wrapMqttClient` used to meter a publish before mqtt.js sent it, so failed publishes were billed. It now meters from the publish callback: the broker's PUBACK/PUBCOMP for QoS 1/2, the socket write for QoS 0. A publish that throws or reports an error is not billed. Your callback, and `publishAsync()`, behave as before.
- **Reconnect flaps are one session (G288).** Every `close` used to bill a DISCONNECT, including each failed reconnect attempt, and every reconnect a CONNECT. A connection that comes back within `reconnectDebounceMs` (new option, default 30 000; `0` turns it off) now bills nothing new; one that does not come back is billed as DISCONNECT at the time it dropped. A clean `client.end()` (or a broker DISCONNECT packet) is billed at once. `wrapAedesBroker` applies the same rule per client id, including session takeovers. `shutdown()` bills any DISCONNECT still waiting. Migration: none, unless you bill per connection attempt — then set `reconnectDebounceMs: 0`.
- `onError` receives a `CoreTransportError` for delivery reports: branch on `err.kind` (`outage`, `auth`, `rejected`, `shutdown`, `closed`) instead of the message. It is still an `Error`.

### Added
- Shared Node transport core in `src/transport-core/` (copied from `node/`, G271).
- `reconnectDebounceMs` (client-level and per wrap call), `DEFAULT_RECONNECT_DEBOUNCE_MS`, and the `CoreTransportError` / `CoreErrorKind` exports.
- `flush()`, `queuedCount`, and the options `allowInsecureHttp`, `maxQueueSize`, `maxRetries`, `timeoutMs`, `shutdownTimeoutMs`, `flushOnExit`. `User-Agent: aforo-mqtt-metering/<version>`.

## [1.2.2] - 2026-10-01

### Changed
- **Topics and broker client ids longer than the ingestor's limits are truncated, and the event is sent.** They originate from MQTT packets, so dropping the event let a client avoid metering with a long topic or client id. `mqttTopic` is cut to 500 UTF-16 code units and `mqttClientId` to 128 (never splitting a surrogate pair), in both `wrapAedesBroker` and `wrapMqttClient` (including its `clientId` option). Applies to PUBLISH / SUBSCRIBE / UNSUBSCRIBE topics in `wrapAedesBroker` and to publish / incoming-message topics in `wrapMqttClient`. One WARN is logged per label name per `AforoMqttBilling` instance.
- `resolveCustomerId`, `resolveMetadata` and the `executionStatus` function still receive the full client id. The CONNECT / DISCONNECT stand-in topics are built from the truncated client id, so they keep their `/connected` and `/disconnected` suffix.
- **Idempotency key.** Still `mqtt:{tenantId}:{clientId}:{eventType}:{millis}:{random}`, minted once per event from the untruncated client id. When that is longer than 255 characters the client id is replaced by its SHA-256 hex digest; the key is no longer cut from the front. Keys of 255 characters or fewer are built exactly as before.

### Unchanged
- Identity fields are never altered: an over-long `customerId` (64) or `productType` (20) still drops the event with reason `'invalid'`. A blank topic still drops.

### Added
- Export: `truncateToLimit(value, max)`.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

Merge of the public-repo fixes (verified against the production ingestor) with the working-repo line (execution status, drop observability, contract tests).

### Changed
- **Breaking (fix):** the API key is sent as `X-API-Key`. `Authorization` is no longer sent — the ingestor accepts `X-API-Key` for every key, while Bearer only works for `sk_live_` / `sk_test_` keys.
- Docs, examples and tests use `https://api.aforo.ai`.
- Events get a top-level `productType` (default `MQTT_BROKER`; client option `productType`, per integration `wrapAedesBroker(broker, { productType })` / `wrapMqttClient(client, { productType })`), trimmed and upper-cased.
- CONNECT / DISCONNECT events carry `$SYS/clients/<clientId>/connected` / `…/disconnected` as `mqttTopic` (exported as `mqttConnectTopic` / `mqttDisconnectTopic`). They used to carry an empty topic, which the ingestor rejects.
- `mqttQos` values other than 0, 1 or 2 are sent as 0.
- An event the ingestor would refuse is dropped before it is buffered, with drop reason `invalid`: `customerId` over 64 characters, missing or whitespace-only `mqttTopic` (for example an empty UNSUBSCRIBE), `mqttTopic` over 500, `mqttClientId` over 128, `productType` over 20. Nothing is truncated and nothing is thrown into the broker or client handlers.
- The SDK-generated `idempotencyKey` no longer contains the topic and stays within 255 characters. It is still minted once, when the event is created.
- A flush is split into requests of at most 1000 events, the ingestor's batch limit.
- Only network errors, 408, 429 (honouring `Retry-After`, capped at 30 s) and 5xx are retried. Any other 4xx is not retried: the batch is dropped with reason `rejected` and `onError` carries the ingestor's `errors[].message`.
- A 2xx response with `failed > 0` is reported through `onError`; the events its `errors[]` names by index are dropped with reason `rejected` (counted only, when no usable index is given).
- New drop reason `invalid` on `onDrop` / `droppedCount` for events that fail a client-side check. The warning is logged for the first occurrence per field and every 1000th after.
- A throwing `onError` hook can no longer make a delivered batch look like a network failure and be re-sent.
- `package.json` license is `Apache-2.0`.

## [1.1.1] - 2026-09-30

- A caller `executionStatus` outside the 11 accepted values (or a Promise from an async resolver) is reported through `onError` and left off the event; the event is still sent.

## [1.1.0] - 2026-09-30

- Optional `executionStatus` (`wrapAedesBroker` / `wrapMqttClient` option: a string or a function called per event). Never derived by the SDK.
- Shipped earlier in 2026-07 without a version bump: `droppedCount` and the opt-in `onDrop(events, reason)` hook (reasons `retry_exhausted`, `rejected`); batches POSTed to `/v1/ingest/batch` (they went to `/v1/ingest/events`, a single-event endpoint, and every flush was refused); a contract test that checks the wire request against `contract/ingest-contract.json`; `onError` fires once, not twice, when retries are exhausted on a network error.

## [1.0.0] - 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoMqttBilling` class with `wrapAedesBroker` (broker-side, every client's events) and `wrapMqttClient` (client-side, against a third-party broker).
- Meters PUBLISH / SUBSCRIBE / UNSUBSCRIBE / CONNECT / DISCONNECT as `mqtt_broker.<event>`; each event carries `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttClientId`, and `dataBytes`.
- `DELIVER` (fan-out) events are dropped unless `emitDeliverEvents: true` — applies in both modes.
- Events posted to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer` + `X-Tenant-Id`; 3× exponential-backoff retry (1s/2s/4s) then `onError`.
- Defaults: `flushCount` 200, `flushIntervalMs` 2000 (the most aggressive batching of the SDKs, for high-volume MQTT telemetry).
