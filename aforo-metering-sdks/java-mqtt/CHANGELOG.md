# Changelog

All notable changes to `ai.aforo:mqtt-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [2.0.0] - 2026-10-26

Breaking. Moves onto the shared wave 5 transport core (contract/TRANSPORT-SPEC.md).

### Changed (breaking)
- **An outage no longer drops events.** The queue is bounded (`maxQueueSize`, default 10 000; overflow evicts the oldest as the new `DropReason.OVERFLOW`). After the retries, the batch goes back to the queue with the same idempotency keys and the sender pauses (5 s, doubling with jitter up to 5 min); 401/403 count as an outage. `RETRY_EXHAUSTED` is kept but no longer reported for outages.
- **`close()` honours `shutdownTimeoutMs`** (default 5 s); events left at the deadline are reported as the new `DropReason.SHUTDOWN`. Recording after `close()` is reported as `DropReason.CLOSED`.
- `ingestorUrl` must be `https://` (plain `http://` only for localhost, 127.0.0.1, ::1, or with `allowInsecureHttp(true)`).
- Default `flushCount` is 500 and `flushIntervalMs` 5 s (was 200 / 2 s). The package-private `retryBackoffBaseMs` field is gone; use `retryBaseMs(...)`.
- Metric names are lower-cased with `Locale.ROOT`; under a Turkish default locale `mqtt_broker.publish` was sent as `mqtt_broker.publısh`.

### Added
- One background sender thread per instance; recording never starts a thread or a request. One `HttpClient`, shut down on close.
- Full-jitter retries; `Retry-After` in seconds or HTTP-date, capped at 60 s. A 413 splits the batch; bodies are split at 4 MiB. Events a 2xx marks `retryable: true` are resent with their keys.
- Builder: `maxQueueSize`, `maxRetries`, `retryBaseMs`, `timeoutMs`, `shutdownTimeoutMs`, `breakerCooldownMs`, `allowInsecureHttp`; `bufferedCount()`.
- Requests carry `User-Agent: aforo-java-mqtt/2.0.0`.
- Release: `autoPublish` is off; a person releases the staging deployment on Central.

### Changed (review fixes, 2026-10-27)
- Transport core (shared with `ai.aforo:metering` 2.0.0): `close()` cuts a request started before close at the shutdown deadline and reports its batch as `SHUTDOWN`; `timeoutMs` covers reading the body; a 3xx is an outage (logged with the target host, never followed); per-event `retryable` is capped at `maxRetries` with backoff; breaker cooldown is at least 250 ms; shutdown after an outage keeps retrying until the deadline; fractional `Retry-After`; an event that cannot be serialized (cyclic metadata) is dropped as `INVALID`.

### Added (review fixes, 2026-10-27)
- `Builder.onError(Consumer<MeteringError>)` typed by `MeteringError.kind()` (`OUTAGE`, `AUTH`, `REJECTED`, `SHUTDOWN`, `CLOSED`) and `Builder.onAccepted(...)` with the unwrapped 2xx body.

## [1.2.2] - 2026-10-01

### Changed
- **A topic over 500 characters or a `clientId` over 128 is truncated, and the event is sent.** Both originate from the MQTT packet, so a client could avoid being metered by using a longer one (1.2.0 dropped such events as `INVALID`). Applies to every `record*(...)` method. `mqttTopic` / `mqttClientId` are cut to the limit (UTF-16 code units, never inside a surrogate pair). One `WARNING` is logged per label per instance. The idempotency key is built from the full values.
- The automatic `idempotencyKey` no longer cuts its text part when it is too long for the 255-character limit. The part is kept as-is when it fits (keys for such events are unchanged); otherwise its tail is replaced by the SHA-256 hex digest of the whole untruncated value, so two events whose long topics share a prefix get different text parts. The key is still minted once per event and resent unchanged on retry.
- Fields set by the caller are unchanged: a `customerId` over 64 characters or a `productType` over 20 still drops the event as `INVALID`.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

Merge of the 1.1.x line (execution status, drop observability) with the public-repo ingest fixes.

### Changed
- **Maven groupId is `ai.aforo`** (was `com.aforo`): `ai.aforo:mqtt-metering:1.2.0`. Java package names are unchanged.
- **Breaking (fix):** the API key is sent as `X-API-Key`; `Authorization: Bearer` is no longer sent.
- Docs and examples use `https://api.aforo.ai`.
- A 4xx other than 408/429 is sent once and the batch is dropped as `REJECTED` (it used to be retried 3 times). A 429 waits for `Retry-After` (seconds). Exhausted retries are `RETRY_EXHAUSTED`.
- Flushes larger than 1000 events are split into requests of at most 1000; each slice is serialized once, so retries resend the same `idempotencyKey`s.
- `executionDurationMs` is sent as an integer; enum-validated fields carry only values the ingestor accepts (others go to `metadata`).

### Added
- `Builder.productType(String)` (default `MQTT_BROKER`) and `getProductType()`: top-level `productType` on every event. Trimmed and upper-cased.
- `DropReason.INVALID`: an event that breaks an ingestor field limit (`customerId` over 64 characters, `productType` over 20, …) is not sent; it is counted in `droppedCount()`, logged, and passed to `onDrop`. Nothing is thrown and nothing is truncated.
- Partial results: when a 2xx response lists refused events in `errors[]`, those events are counted and passed to `onDrop` as `REJECTED`; the log line carries the ingestor's `errors[].message`.
- `recordConnect` / `recordDisconnect` send `mqttTopic` `$SYS/clients/<clientId>/connected` (or `/disconnected`); the ingestor requires a topic on every MQTT_BROKER event. A blank `customerId`, or a blank / whitespace-only topic, is dropped as `INVALID`. A topic over 500 or `clientId` over 128 characters is no longer truncated; the event is dropped as `INVALID`.

## [1.1.1] - 2026-09-30

- An `executionStatus` outside the 11 canonical values (or longer than 20 characters) is logged and left off the event; it used to be sent as-is and the ingestor rejected the event.
- A size-triggered flush and `close()` could drain the buffer at the same time and split one batch into two requests; draining is now serialized.

## [1.1.0] - 2026-09-30

- `executionStatus` on events (trimmed, upper-cased), sent only when passed to a `record*` overload.
- Drop observability: `droppedCount()`, a `WARNING` log, and the opt-in `Builder.onDrop(events, reason)` hook (`RETRY_EXHAUSTED`, `REJECTED`); an interrupted retry backoff is accounted for. Events post to `/v1/ingest/batch` as `{"events": [...]}`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoMqttBilling` (`AutoCloseable`) with a fluent builder and a client-mode API: `recordPublish`, `recordDeliver`, `recordSubscribe`, `recordUnsubscribe`, `recordConnect`, `recordDisconnect`. Framework-agnostic over the raw MQTT primitives, so it works with Eclipse Paho or any Java MQTT client.
- Per-event fields `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttEventType`, `mqttClientId`, `dataBytes`; metric name derived as `mqtt_broker.<eventType>`.
- `DELIVER` opt-in via `emitDeliverEvents(true)` to keep high-volume inbound traffic off by default.
- Buffered delivery to `POST <ingestorUrl>/v1/ingest/events` with `X-Tenant-Id`, 200-event / 2s flush, and 3× exponential retry.
