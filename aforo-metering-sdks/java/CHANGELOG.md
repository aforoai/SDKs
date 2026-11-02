# Changelog

All notable changes to `ai.aforo:metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [2.0.0] - 2026-10-26

Breaking. Wave 5 transport core (contract/TRANSPORT-SPEC.md) and customer identity.

### Changed (breaking)
- **The servlet filter needs a customer source.** Build it with `AforoServletFilter.builder(client)` and set `customerIdResolver(...)`, `usePrincipalAsCustomerId(true)` or `trustCustomerHeader(true)`; `build()` throws without one. The public constructors and instance setters are gone. In Spring, declare a `CustomerIdResolver` bean or set `aforo.use-principal-as-customer-id` / `aforo.trust-customer-header`, or startup fails. `X-Customer-Id` is no longer read by default: callers of your API set it. **Migration:** add a resolver bean that reads the customer from your authentication.
- **An outage no longer drops events.** After the retries, the batch goes back to the front of the queue with the same idempotency keys and the sender pauses (5 s, doubling with jitter up to 5 min). 401/403 are treated the same way and logged at `SEVERE`. `FlushResult.failed()` counts only events actually dropped.
- **`track(...)` never throws.** After `close()` the event is reported as the new `DropReason.CLOSED`.
- **`close()` honours `shutdownTimeoutMs`** (default 5 s); each request in that window uses `min(timeoutMs, time left)`, and events left at the deadline are reported as the new `DropReason.SHUTDOWN`.
- `baseUrl` must be `https://` (plain `http://` only for localhost, 127.0.0.1, ::1, or with `allowInsecureHttp(true)`).
- Defaults: `flushCount` 500 (was 50), `retryBaseMs` 500 (was 1000); `timeoutMs` is now the total request deadline.
- `RingBuffer` and the package-private `Transport` were removed; the transport lives in `com.aforo.metering.internal.transport` (internal, copied into the variant SDKs).
- Spring auto-configuration is an `@AutoConfiguration`; every bean is `@ConditionalOnMissingBean`, the filter registers only in servlet web apps, and the client is closed by `AforoClientLifecycle` in Spring's stop phase instead of a JVM shutdown hook.

### Added
- One background sender thread per client; `track()` wakes it with a compare-and-set and never submits a task (G308). One `HttpClient` per client, shut down on close.
- Full-jitter retries; `Retry-After` in seconds or HTTP-date, capped at 60 s. A 413 splits the batch; bodies are split at 4 MiB. Events a 2xx marks `retryable: true` are resent with their keys.
- `AforoOptions`: `breakerCooldownMs`, `allowInsecureHttp`, `registerShutdownHook`; properties `aforo.trust-customer-header`, `max-queue-size`, `timeout-ms`, `shutdown-timeout-ms`, `allow-insecure-http`.
- `toString()` on options, client and properties never prints the API key.
- Release: `autoPublish` is off; a person releases the staging deployment on Central.

### Changed (review fixes, 2026-10-27)
- **`close()` is bounded even with a request in flight.** A request started before `close()` used its full `timeoutMs` and was interrupted only after `shutdownTimeoutMs + 2 s`; its batch was lost uncounted and pending `flush()` calls never returned. It is now cut at the shutdown deadline, its batch is reported as `SHUTDOWN`, pending `flush()` calls complete, and `close()` returns within `shutdownTimeoutMs` plus 500 ms.
- **`timeoutMs` covers reading the response body.** A server that stalls mid-body or drips one byte at a time is cut off (it used to hold the sender forever).
- **A 3xx is an outage, never followed:** logged at `SEVERE` with the target host, the batch requeued, the breaker opened. Fix the base URL to deliver.
- **Per-event `retryable` failures** are resent at most `maxRetries` times with jittered backoff, then treated as an outage; a 2xx that still carries retryable events no longer resets the breaker, so its cooldown grows.
- **Breaker cooldown** is `max(250 ms, random(0, ceiling))`; it could be 0 ms.
- **`flush()` while the breaker is open** makes one attempt instead of returning at once. **Shutdown after an outage** keeps retrying with jittered backoff until the deadline instead of waiting out the cooldown.
- `Retry-After` may be fractional (`1.5`); an event whose serialization recurses (cyclic metadata) is dropped as `INVALID` at `track()` instead of throwing.
- **Spring:** `AforoClientLifecycle` uses phase `DEFAULT_PHASE - 3072` (`AforoClientLifecycle.PHASE`). The old `DEFAULT_PHASE - 2048` equals Spring Boot's web server stop phase, so the client could close before the server's last requests were metered.

### Added (review fixes, 2026-10-27)
- `AforoOptions.onError(Consumer<AforoError>)` with `AforoError.kind()` (`OUTAGE`, `AUTH`, `REJECTED`, `SHUTDOWN`, `CLOSED`), `events()`, `status()`, `willRetry()`; `AforoOptions.onAccepted(...)` with the unwrapped 2xx body.

## [1.1.2] - 2026-10-01

### Changed
- **`AforoServletFilter` truncates over-long request labels instead of letting the event be lost.** `endpointPath` is cut to 512 characters and `httpMethod` to 16 (the ingestor's limits, counted in UTF-16 code units); the event is sent. `httpMethod` was not bounded before, so a request with a longer method was sent and refused by the ingestor. The cut never splits a surrogate pair. One `WARNING` is logged per label per filter instance.
- Fields set by the caller are unchanged: an over-long `customerId` (including one read from the customer header), `metricName` (fixed or from a `MetricNameResolver`), `idempotencyKey` or `productType` still drops the event as `INVALID`. `track(...)` does not truncate anything passed to it.

### Added
- `RequestLabels.truncate(String, int)`: the surrogate-safe cut used by the filter.

## [1.1.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.1.0] - 2026-10-01

Merge of the 1.0.1 line (execution status, drop observability) with the public-repo ingest fixes.

### Changed
- **Maven groupId is `ai.aforo`** (was `com.aforo`): `ai.aforo:metering:1.1.0`. Java package names (`com.aforo.metering`) and the Spring property prefix (`aforo.*`) are unchanged.
- **Breaking (fix):** the API key is sent as `X-API-Key`; `Authorization: Bearer` is no longer sent.
- **Breaking (fix):** the default base URL is `https://api.aforo.ai` (`AforoOptions` and `aforo.base-url`).
- **Breaking (fix):** the servlet filter records the metric `api_calls` (or `aforo.metric-name` / a `MetricNameResolver` bean) instead of `"METHOD /path"`. The customer id comes from a `CustomerIdResolver` bean or `aforo.customer-id-header` (default `X-Customer-Id`); the caller's `X-Api-Key` header is never used, and the principal name only with `aforo.use-principal-as-customer-id: true`. `OPTIONS` requests are not metered.
- `flushCount` is clamped to 1–1000, the ingestor's batch limit.

### Added
- Top-level `productType` on every event: `AforoOptions.productType(...)` / `aforo.product-type` (default `API`), `TrackEvent.Builder.productType(...)` per event, `AforoServletFilter.productType(...)` per filter. Trimmed and upper-cased.
- `TrackEvent.Builder`: `occurredAt(Instant)`, `endpointPath`, `httpMethod`, `statusCode`, `responseTimeMs`; the servlet filter sets them (endpoint path capped at 512 characters).
- `DropReason.INVALID`: an event the ingestor would refuse — blank `customerId` / `metricName`, `quantity <= 0`, `customerId` over 64 characters, `metricName` or `idempotencyKey` over 255, `productType` over 20, a `quantity` with more than 14 integer digits or 6 decimal places — is not buffered. It is counted in `droppedCount()`, logged, and passed to `onDrop`. `track(...)` does not throw for it, and nothing is truncated or rounded.
- Partial results: when a 2xx response lists refused events in `errors[]`, `FlushResult.failed()` counts them and they are passed to `onDrop` as `REJECTED`. Rejection log lines carry the ingestor's `errors[].message`.

## [1.0.1] - 2026-09-30

- `TrackEvent.Builder.executionStatus(...)`: optional outcome status for OUTCOME_BASED pricing, trimmed and upper-cased. A value outside the 11 canonical statuses (or longer than 20 characters) is logged and left off the event.
- Drop observability: `droppedCount()`, a `WARNING` log, and the opt-in `AforoOptions.onDrop(events, reason)` hook (`OVERFLOW`, `RETRY_EXHAUSTED`, `REJECTED`).
- An event with no `idempotencyKey` gets a random UUID, minted once when `track(...)` enqueues it and reused by every retry. `IdempotencyKeyGenerator.generate(...)` stays public but is no longer the default: two identical events in the same millisecond hashed to one key and the second was deduplicated away.
- `close()` removes the JVM shutdown hook it registered.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoClient` (`AutoCloseable`): buffered, batched event delivery to `POST https://ingest.aforo.ai/v1/ingest/batch` with size/time-threshold flush, 3× retry on 5xx/408/429 (honoring `Retry-After`), and a JVM shutdown hook.
- `AforoOptions` fluent configuration; `TrackEvent` builder; `FlushResult` record.
- Spring Boot auto-configuration (`aforo.enabled=true`) wiring an `AforoClient` bean and `AforoServletFilter` (request-end, non-blocking, default path excludes).
- `PathNormalizer` for route-template / id-segment normalization; deterministic idempotency-key derivation.
