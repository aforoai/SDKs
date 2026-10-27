# Changelog

All notable changes to `aforo-ws-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [2.0.0] - 2026-10-26

Breaking. Migration: keep passing `customer_id`, or switch to `customer_resolver=` / `trust_customer_header=True` (calling a helper with none of them now raises `ValueError`); use an `https://` `ingestor_url` (or `allow_insecure_http=True`); stop expecting `retry_exhausted` drops.

### Changed
- **An outbound frame is billed only once the send returns.** `track_websockets_connection` and `track_starlette_websocket` count a frame (and emit its per-frame event) after the wrapped `send` / `send_text` / `send_bytes` returns without raising, so a frame the socket refuses is no longer billed. Before, it was counted before the send.
- **Shared transport core** (`aforo_ws_metering/_transport`, a copy of the core SDK's; G271, G285): one bounded queue (`max_queue_size`, default 10 000; overflow drops the oldest as `overflow`) and one sender thread. `push()` no longer starts a thread when `flush_count` is reached, and the old unbounded list is gone.
- **Outages keep events**: after 3 full-jitter retries, or on 401/403, the batch is requeued with the same idempotency keys and retried after a pause (G267, G268). `Retry-After` is read in both forms, capped at 60 s. `retry_exhausted` is no longer reported; new drop reasons `shutdown` and `closed`.
- **`shutdown()` is bounded** by `shutdown_timeout_sec` (default 5) and runs at interpreter exit; one pooled HTTP client; default `flush_count` 500 (G269).
- **`ingestor_url` must be `https://`** (localhost excepted, or `allow_insecure_http=True`); the API key is no longer a public attribute and never in `repr()` (G270).
- **Customer identity** (G265): `track_websockets_connection` / `track_starlette_websocket` accept `customer_resolver=callable(websocket)` or `trust_customer_header=True` (reads the `x-customer-id` handshake header) as alternatives to `customer_id`; with none of them they raise `ValueError`.
- `customerId` and close-reason lengths are counted in UTF-16 units (G284). `httpx` is now a dependency. `__init__.__version__` matches the package (was 1.2.1).

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
- **CONNECTION_OPENED uses frame type `OPEN`** and metric `websocket_api.connection_opened` (it was `PING` / `websocket_api.message`), matching go-ws 2.0.0. Add `websocket_api.connection_opened` to your catalog if you bill connections opened. Migration: filters on `wsFrameType = "PING"` for opens must look for `OPEN`.
- **No leaked connections**: `shutdown()` sends CONNECTION_CLOSED (`GOING_AWAY`, `closedBy: "sdk_shutdown"`) for every connection still open; a connection with no frames for `connection_idle_timeout_sec` (new, default 1 h; negative raises `ValueError`) is closed (`ABNORMAL_CLOSURE`, `closedBy: "sdk_idle_timeout"`) and forgotten. A connection opened while `shutdown()` runs is reported as `closed`, never billed without a close. New `open_connections`, `sweep_idle()`, `sweep_idle_if_due()`.

## [1.2.2] - 2026-10-01

### Changed
- **`wsCloseReason` is cut on a UTF-16 boundary.** A close reason can carry text from the peer's close frame. `push()` already cut it to 32 characters, but counted code points, so a reason containing characters outside the Basic Multilingual Plane could still exceed the ingestor's limit of 32 UTF-16 code units and the event was rejected. It is now cut to at most 32 UTF-16 code units without splitting a surrogate pair, and one WARNING is logged per client when a reason is cut. The event is sent, as before.

### Unchanged
- `customerId` is never truncated: a blank one, or one over 64 characters, still drops the event with reason `invalid`. `wsConnectionId` is sent as given (the connection trackers generate a UUID).
- The idempotency key does not contain the close reason.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

Merge of the public-repo fixes into the working line. Wire behaviour changes; read before upgrading.

### Added
- `product_type` constructor option (default `"WEBSOCKET_API"`) for the top-level `productType` the ingestor requires on every event, with a per-event override. Values are trimmed and upper-cased; values the SDK does not know are passed through.
- Drop reason `invalid`: an event that fails a client-side check is not buffered or sent. It is counted in `dropped_count`, logged at WARNING (once per distinct message) and passed to `on_drop(events, "invalid")`. `push()` does not raise for event content.
- Events the ingestor refuses inside a 202 response are counted in `dropped_count` and passed to `on_drop` with reason `rejected` (only the events the response identifies by index).

### Changed
- The API key is sent as `X-API-Key`; `Authorization: Bearer` is no longer sent. The ingestor accepts `X-API-Key` for every key type.
- Docs and examples use `https://api.aforo.ai`.
- A flush is split into requests of at most 1000 events (the ingestor's batch limit).
- Retry: 4xx responses other than 408 and 429 are not retried and drop the batch with reason `rejected`; 429 waits for `Retry-After` (capped at 60 s); 5xx, 408, 429 and network errors that fail 3 attempts drop with reason `retry_exhausted`. The ingestor's `errors[].message` is passed to `on_error`.
- Connection/frame duration is sent as `executionDurationMs`; the old `durationMs` field does not exist on the ingestor and was silently discarded. `push()` still accepts `durationMs` in its input.
- `wsDirection` / `wsFrameType` are normalised to the ingestor's allowed values and `wsCloseReason` is capped at 32 characters. Events with a blank or over-64-character `customerId`, or no `wsConnectionId`, are no longer sent; they are reported as `invalid` drops.

### Unchanged
- `executionStatus` rules, `on_drop` / `dropped_count`, the `atexit` flush, the `/v1/ingest/batch` endpoint, and idempotency keys (one per event, created when the event is recorded and reused by every retry).

## [1.1.1] - 2026-09-30

- An `executionStatus` outside the 11 accepted values (or longer than 20 characters) is logged and left off the event; it used to be sent and the ingestor rejected that event.

## [1.1.0] - 2026-09-30

- `executionStatus`, explicit only: `execution_status=` on `push()` and on the connection helpers (also settable inside the block); it goes on the `CONNECTION_CLOSED` event.

## 2026-07-05 (shipped under 1.0.0, no version bump)

- Drop observability: `dropped_count`, a WARNING log, and the opt-in `on_drop(events, reason)` hook (`retry_exhausted`, `rejected`). Dropped events keep their idempotency keys.
- Batches are POSTed to `/v1/ingest/batch`; `/v1/ingest/events` is a single-event endpoint and rejected every batch.
- `shutdown()` deregisters the `atexit` handler.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoWsBilling` and the connection trackers `track_websockets_connection` (for the `websockets` library) and `track_starlette_websocket` (FastAPI/Starlette).
- Documented the default open + close billing model (aggregated `messageCount` / `dataBytes` / `durationMs`), the `per_frame_events` mode, and close-code mapping via `WS_CLOSE_REASONS`.
- Full configuration reference; events deliver to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[1.2.0]: https://github.com/aforoai/SDKs/compare/python-ws-v1.0.0...python-ws-v1.2.0
[1.0.0]: https://github.com/aforoai/SDKs/releases/tag/python-ws-v1.0.0
