# Changelog

All notable changes to `aforo-grpc-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [2.0.0] - 2026-10-26

Breaking. Migration: give the interceptor a customer resolver (`AforoGrpcInterceptor(billing, customer_resolver=...)` or `customer_id_extractor=` on the client), or pass `trust_customer_header=True` to keep reading `x-customer-id` metadata; use an `https://` `ingestor_url` (or `allow_insecure_http=True`).

### Changed
- **Shared transport core** (`aforo_grpc_metering/_transport`, a copy of the core SDK's; G271, G285): one bounded queue (`max_queue_size`, default 10 000; overflow drops the oldest as `overflow`) and one sender thread. `record()` no longer starts a thread per flush, and the old unbounded list is gone.
- **Outages keep events**: after 3 full-jitter retries, or on 401/403, the batch is requeued with the same idempotency keys and retried after a pause (G267, G268). `Retry-After` is read in both forms, capped at 60 s. `retry_exhausted` is no longer reported; new drop reasons `shutdown` and `closed`.
- **`shutdown()` is bounded** by `shutdown_timeout_sec` (default 5) and also runs at interpreter exit; one pooled HTTP client per billing client; default `flush_count` 500 (G269).
- **`ingestor_url` must be `https://`** (localhost excepted, or `allow_insecure_http=True`); the API key is no longer kept as a public attribute and is never in `repr()` (G270).
- **All four RPC shapes are metered** (G286): unary, server streaming, client streaming and bidirectional, with `messageCount` = messages read plus sent. New `AforoAioGrpcInterceptor` for `grpc.aio` servers.
- **Customer resolver required** (G265): `customer_id_extractor` no longer defaults to reading `x-customer-id`; `trust_customer_header=True` opts in. A call with no customer is counted as an `invalid` drop.
- `customerId` length is counted in UTF-16 units (G284). `httpx` is now a dependency.

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
- **An over-long method name is truncated, not rejected.** `grpcMethod` comes from the client's request, whether the interceptor reads it or your code passes it to `record()`. A name longer than the ingestor's 128-character limit (counted in UTF-16 code units; a surrogate pair is never split) is cut to the limit and the call is still metered; before, the event went out with the full name and the ingestor rejected it, so the call was not billed. One WARNING is logged per client.
- **Idempotency key.** The key is built from the full, untruncated value. A key that fits in 255 characters is unchanged. When it would not fit, the over-long part is replaced in the key by its SHA-256 hex digest (the key used to be cut and given a random suffix), so the key is the same for the same input and differs for different inputs.

### Unchanged
- `customer_id` is never truncated: a blank one, or one over 64 characters, still drops the event with reason `invalid`.
- The `service_name` given to the client is configuration and is sent as given.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

Merge of the public-repo fixes into the working line. Wire behaviour changes; read before upgrading.

### Added
- `product_type` constructor option (default `"GRPC_API"`) for the top-level `productType` the ingestor requires on every event, with a per-event override. Values are trimmed and upper-cased; values the SDK does not know are passed through.
- Drop reason `invalid`: an event that fails a client-side check is not buffered or sent. It is counted in `dropped_count`, logged at WARNING (once per distinct message) and passed to `on_drop(events, "invalid")`. `record()` does not raise for event content.
- Events the ingestor refuses inside a 202 response are counted in `dropped_count` and passed to `on_drop` with reason `rejected` (only the events the response identifies by index).

### Changed
- The API key is sent as `X-API-Key`; `Authorization: Bearer` is no longer sent. The ingestor accepts `X-API-Key` for every key type.
- Docs and examples use `https://api.aforo.ai`.
- A flush is split into requests of at most 1000 events (the ingestor's batch limit).
- Retry: 4xx responses other than 408 and 429 are not retried and drop the batch with reason `rejected`; 429 waits for `Retry-After` (capped at 60 s); 5xx, 408, 429 and network errors that fail 3 attempts drop with reason `retry_exhausted`. The ingestor's `errors[].message` is passed to `on_error`.
- `record()` with a blank `method`, or a blank / over-64-character `customerId`, is no longer sent; it is reported as an `invalid` drop (`grpcService` and `grpcMethod` are required on `GRPC_API` events).
- `record()` normalises `status` (a `grpc.StatusCode`, an int code or a label) to a valid `grpcStatusCode` (`UNKNOWN` when unrecognised) and `call_type` to `UNARY` / `CLIENT_STREAM` / `SERVER_STREAM` / `BIDI_STREAM`. Over-long `idempotencyKey`s are capped at 255 characters when the event is created.

### Unchanged
- `executionStatus` rules, `on_drop` / `dropped_count`, the `atexit` flush, the `/v1/ingest/batch` endpoint, and idempotency keys (one per event, created when the event is recorded and reused by every retry).

## [1.1.1] - 2026-09-30

- An `executionStatus` outside the 11 accepted values (or longer than 20 characters) is logged and left off the event; it used to be sent and the ingestor rejected that event.
- The interceptor reads the status from `context.code()`, so `context.abort(...)` and `context.set_code(...)` bill by the code the server sent (abort with `PERMISSION_DENIED` → `BLOCKED`); they were billed `ERROR` / `SUCCESS`.
- `record(status=grpc.StatusCode.X)` sends the code's name; the enum was not JSON-serializable and failed the whole batch.

## [1.1.0] - 2026-09-30

- `executionStatus` on every event, derived from the gRPC status code (`outcome_from_grpc_status`); `execution_status=` on `record()` and `execution_status_resolver` on `AforoGrpcInterceptor`.

## 2026-07-05 (shipped under 1.0.0, no version bump)

- Drop observability: `dropped_count`, a WARNING log, and the opt-in `on_drop(events, reason)` hook (`retry_exhausted`, `rejected`). Dropped events keep their idempotency keys.
- Batches are POSTed to `/v1/ingest/batch`; `/v1/ingest/events` is a single-event endpoint and rejected every batch.
- `shutdown()` deregisters the `atexit` handler.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoGrpcBilling`, the `AforoGrpcInterceptor` (auto-meters unary RPCs), and the manual `record()` path for streaming RPCs.
- Documented gRPC status mapping via `GRPC_STATUS_LABELS` and customer-ID resolution from `x-customer-id` invocation metadata (override via `customer_id_extractor`).
- Full configuration reference; one `grpc_api.rpc_calls` event per RPC, delivered to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[1.2.0]: https://github.com/aforoai/SDKs/compare/python-grpc-v1.0.0...python-grpc-v1.2.0
[1.0.0]: https://github.com/aforoai/SDKs/releases/tag/python-grpc-v1.0.0
