# Changelog

All notable changes to `aforo-mqtt-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [2.0.0] - 2026-10-26

Breaking. Migration: keep passing `customer_id=` to the wrappers (or use `customer_resolver=` / `trust_customer_header=True`; with none they raise `ValueError`); use an `https://` `ingestor_url` (or `allow_insecure_http=True`); expect PUBLISH events only for publishes paho confirms.

### Changed
- **Shared transport core** (`aforo_mqtt_metering/_transport`, a copy of the core SDK's; G271, G285): one bounded queue (`max_queue_size`, default 10 000; overflow drops the oldest as `overflow`) and one sender thread. `push()` no longer starts a thread per flush; the old unbounded list is gone.
- **Outages keep events**: after 3 full-jitter retries, or on 401/403, the batch is requeued with the same idempotency keys and retried after a pause (G267, G268). `Retry-After` is read in both forms, capped at 60 s. `retry_exhausted` is no longer reported; new drop reasons `shutdown` and `closed`.
- **`shutdown()` is bounded** by `shutdown_timeout_sec` (default 5) and runs at interpreter exit; one pooled HTTP client; default `flush_count` 500 (G269).
- **`ingestor_url` must be `https://`** (localhost excepted, or `allow_insecure_http=True`); the API key is no longer a public attribute and never in `repr()` (G270).
- **Reconnect flaps are not billed** (G288): CONNECT only on an accepted CONNACK; a dropped connection that reconnects within `reconnect_debounce_sec` (default 30) bills no new CONNECT/DISCONNECT; a clean disconnect bills DISCONNECT at once. Handles paho 2.x callback signatures.
- **PUBLISH is billed after success** (G288): after paho's `on_publish` (ack for QoS 1/2), never for a publish paho refuses; aiomqtt after `publish()` returns.
- **Customer identity** (G265): `customer_resolver=` or `trust_customer_header=True` (the MQTT username) as alternatives to `customer_id`; with none the wrapper raises `ValueError`.
- `customerId` length counted in UTF-16 units (G284). `httpx` is now a dependency. `__init__.__version__` matches the package (was 1.2.1).

### Changed (transport core, review 2026-10-26)
Settles the cases in `contract/TRANSPORT-SPEC.md` "Edge cases every core handles the same way". Migration: if your `on_error` hook matched on message text, branch on `error.kind` instead.
- **`on_error` gets a typed `TransportError`** with `kind` (`outage`, `auth`, `rejected`, `shutdown`, `closed`), `events`, `status` and `will_retry`. It subclasses `RuntimeError`, so existing `Exception` hooks keep working. An outage is reported once per breaker opening, and events still queued at the shutdown deadline are reported as `shutdown`.
- **The request timeout covers the whole exchange**, including reading the response body: a server that stalls or drips its answer one byte at a time is cut off at the deadline (httpx's own timeout is per read).
- **Redirects are an outage**: a 3xx is never followed (the API key must not reach another host); the batch is requeued, the breaker opens, and one ERROR names the host it pointed to.
- **Every 5xx is retried** (501, 505, ... too).
- **Per-event `retryable` errors in a 2xx** are re-sent with the same keys after the normal backoff, at most `max_retries` times, then treated as an outage. They were re-sent at once, in a tight loop. `errors[]` is authoritative even when `failed` is missing or 0.
- **Breaker pause** is `max(250 ms, random(0, min(5 min, 5 s * 2^n)))`; a per-event retry cap reached right after a 2xx does not reset `n`.
- **`flush()` while the breaker is open makes one attempt** (it returned at once).
- **Shutdown keeps retrying** with jittered backoff until `shutdown_timeout` after an outage (it stopped at the first one).
- **Nothing taken off the queue is lost unreported at shutdown**: the unsent half of a split batch, and a batch requeued just after shutdown gave up on a hung request, are reported as `shutdown`. Pending `flush()` callers always return.
- **An event that cannot be turned into JSON** (a cycle, `NaN`, an unknown object) is dropped as `invalid` when it is recorded, not when its batch is sent; it no longer goes to `on_error`.
- **A second `shutdown()`** waits for the first one and never drains again; `shutdown()` called from a hook on the sender thread no longer makes a later `shutdown()` wait 7 s.

## [1.2.2] - 2026-10-01

### Changed
- **An over-long topic or client id is truncated, not dropped.** `mqttTopic` and `mqttClientId` come from the MQTT traffic, whether a client wrapper reads them or your code passes them to `push()`. A topic over 500 characters or a client id over 128 (counted in UTF-16 code units; a surrogate pair is never split) is cut to the limit and the event is still sent; before, the event was dropped with reason `invalid`, so a long topic was not billed. One WARNING is logged per field name per client.
- **Idempotency key.** The key is built from the full, untruncated value. A key that fits in 255 characters is unchanged. When it would not fit, the over-long part is replaced in the key by its SHA-256 hex digest (the key used to be cut and given a random suffix), so the key is the same for the same input and differs for different inputs. The topic is replaced first, then the client id.

### Unchanged
- `customer_id` is never truncated: a blank one, or one over 64 characters, still drops the event with reason `invalid`. A missing topic (other than on CONNECT / DISCONNECT) and an unsupported `event_type` still drop the event.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

Merge of the public-repo fixes into the working line. Wire behaviour changes; read before upgrading.

### Added
- `product_type` constructor option (default `"MQTT_BROKER"`) for the top-level `productType` the ingestor requires on every event, with a per-event override. Values are trimmed and upper-cased; values the SDK does not know are passed through.
- Drop reason `invalid`: an event that fails a client-side check is not buffered or sent. It is counted in `dropped_count`, logged at WARNING (once per distinct message) and passed to `on_drop(events, "invalid")`. `push()` does not raise for event content.
- Events the ingestor refuses inside a 202 response are counted in `dropped_count` and passed to `on_drop` with reason `rejected` (only the events the response identifies by index).

### Changed
- The API key is sent as `X-API-Key`; `Authorization: Bearer` is no longer sent. The ingestor accepts `X-API-Key` for every key type.
- Docs and examples use `https://api.aforo.ai`.
- A flush is split into requests of at most 1000 events (the ingestor's batch limit).
- Retry: 4xx responses other than 408 and 429 are not retried and drop the batch with reason `rejected`; 429 waits for `Retry-After` (capped at 60 s); 5xx, 408, 429 and network errors that fail 3 attempts drop with reason `retry_exhausted`. The ingestor's `errors[].message` is passed to `on_error`.
- CONNECT / DISCONNECT events carry `mqttTopic` `$SYS/clients/<clientId>/<connected|disconnected>` instead of an empty string, since `mqttTopic` is required on every `MQTT_BROKER` event.
- `mqttEventType` must be one of PUBLISH / DELIVER / SUBSCRIBE / UNSUBSCRIBE / CONNECT / DISCONNECT and `mqttQos` outside 0–2 is sent as 0. Events with an unsupported type, no topic (other than CONNECT / DISCONNECT), a topic over 500 or client id over 128 characters, or a blank / over-64-character `customerId` are no longer sent; they are reported as `invalid` drops. Nothing is truncated.

### Unchanged
- `executionStatus` rules, `on_drop` / `dropped_count`, the `atexit` flush, the `/v1/ingest/batch` endpoint, and idempotency keys (one per event, created when the event is recorded and reused by every retry).

## [1.1.1] - 2026-09-30

- An `executionStatus` outside the 11 accepted values (or longer than 20 characters) is logged and left off the event; it used to be sent and the ingestor rejected that event.

## [1.1.0] - 2026-09-30

- `executionStatus`, explicit only: `execution_status=` on `push()`. The client wrappers do not set one.

## 2026-07-05 (shipped under 1.0.0, no version bump)

- Drop observability: `dropped_count`, a WARNING log, and the opt-in `on_drop(events, reason)` hook (`retry_exhausted`, `rejected`). Dropped events keep their idempotency keys.
- Batches are POSTed to `/v1/ingest/batch`; `/v1/ingest/events` is a single-event endpoint and rejected every batch.
- `shutdown()` deregisters the `atexit` handler.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoMqttBilling` and the client wrappers `wrap_paho_client` (paho-mqtt, sync) and `wrap_aiomqtt_client` (aiomqtt, async).
- Documented the metered event types (`mqtt_broker.publish` / `.subscribe` / `.unsubscribe` / `.connect` / `.disconnect`), the opt-in `emit_deliver_events` for inbound messages, and QoS/retained attributes for rate-plan tiering.
- Full configuration reference; events deliver to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[1.2.0]: https://github.com/aforoai/SDKs/compare/python-mqtt-v1.0.0...python-mqtt-v1.2.0
[1.0.0]: https://github.com/aforoai/SDKs/releases/tag/python-mqtt-v1.0.0
