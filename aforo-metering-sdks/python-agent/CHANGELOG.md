# Changelog

All notable changes to `aforo-agent-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [1.0.0] - 2026-10-26

**Breaking.**

### Changed
- **No agent fallback for the customer.** When a call passes no `customer_id`, `default_customer_id` is used; without it the event is dropped with reason `invalid` and counted. Before, the event was billed to the `agent_id`.
- **`wrap_capability_handler` needs a customer source**: `customer_resolver(args, kwargs)`, `trust_customer_header=True` (bills the call's `customer_id` keyword argument), or a `default_customer_id` on the client. With none, decorating raises `ValueError`. A call without `agent_id` is dropped as `invalid`; before, it was sent as `"unknown"`.
- **Sending.** `record_*` put events on a bounded queue (`max_queue_size`, 10 000; the oldest are dropped as `overflow` when full) and never need an event loop. Before, a call outside a running loop never flushed. One background thread sends batches over one pooled `httpx` connection, one request at a time, from construction; `start()` does nothing now.
- Outages (network errors, timeouts, 408, 429, 5xx, 401, 403) are retried with jittered backoff and a circuit breaker; the events stay queued. `Retry-After` is read as seconds or an HTTP date and capped at 60 s. 413 splits the batch. `retry_exhausted` no longer happens.
- `flush_count` default 50 → 500.
- `shutdown()` stops after `shutdown_timeout_sec` (5 s) and reports what is left as `shutdown`; an exit hook does the same if you never call it. A forked child gets its own sender. `flush()` returns the number of events still queued.
- `ingestor_url` must be `https://` (plain `http://` only for localhost, or with `allow_insecure_http=True`). The API key is never in `repr()` or logs.
- Field limits are counted in UTF-16 code units, as the ingestor counts them.
- `httpx` is a required dependency; the aiohttp and urllib paths are gone. `post_fn` still works (it runs on the sender thread). The `aiohttp` / `httpx` extras are kept and empty.

### Added
- `flush_sync()`, `shutdown_sync()`, `max_queue_size`, `timeout_sec`, `shutdown_timeout_sec`, `allow_insecure_http`, `http_transport`, `transport_options`; drop reasons `overflow`, `shutdown`, `closed`.

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

## [0.3.2] - 2026-10-01

### Changed
- **`wrap_capability_handler`: an over-long capability name read from the call is truncated, not dropped.** When the decorator has no `capability_name` of its own it reads one from the wrapped call's `capability_name` kwarg. Such a name longer than the ingestor's 64-character limit (counted in UTF-16 code units; a surrogate pair is never split) is cut to 64 and the event is still sent; before, the event was dropped with reason `invalid`. One WARNING is logged per process.

- **Licence is Apache-2.0** (was MIT), the same as every other module in the repository. `pyproject.toml` licence field and classifier.

### Unchanged
- A `capability_name` given to the decorator or to `record_capability`, and `agent_id`, `session_id` and `customer_id` from any source, are never truncated: an over-long one still drops the event with reason `invalid`.
- The idempotency key is `agent:<uuid>`, minted per event; it does not contain the capability name.

## [0.3.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [0.3.0] - 2026-10-01

Brought to parity with the fixes merged into the other SDKs from the public repository.

### Changed
- **Auth:** the API key is sent as `X-API-Key`; the `Authorization: Bearer` header is no longer sent. The ingestor accepts `X-API-Key` for every key.
- **Default host** is `https://api.aforo.ai` (was `usage-ingestor.aforo.ai`).
- **Transport:** 408 and 429 are retried (429 honours `Retry-After`); other 4xx are not, and `on_error` carries the ingestor's `errors[].message`. Events rejected individually in a `202` (`failed` / `errors[]`) are dropped with reason `rejected`; only those the response names by index are passed to `on_drop`. A `post_fn` may return an optional third element, the `Retry-After` header.
- `flush_count` is clamped to 1000 and a flush holding more than 1000 events is sent in slices of 1000.
- `occurredAt` is a millisecond ISO-8601 instant with `Z`.
- **`record_capability` / `record_step` no longer raise `ValueError` for a blank `capability_name`, `agent_id`, `session_id` or `step_type`.** Such an event is dropped with reason `invalid` (below). Constructor argument errors still raise.

### Added
- `product_type` option (default `AI_AGENT`) and per-event `product_type=` override, trimmed and upper-cased.
- Field limits mirroring the ingestor: `agentId` 36, `sessionId` 64, `customerId` 64, `capabilityName` 64, `metricName` 255, `idempotencyKey` 255, `productType` 20.
- Drop reason **`invalid`**: an event with a blank required field or a field over its limit is not buffered or sent; it is counted in `dropped_count`, WARN-logged (first occurrence, then every 1000th) and passed to `on_drop(events, "invalid")`. Nothing is truncated.
- `README.md` rewritten, `USER_GUIDE.md` and this changelog added.

## [0.2.1] - 2026-09-30

- An `execution_status` outside the 11 canonical values is logged and left off the event; it used to be sent as-is and the ingestor rejected that event.
- `wrap_capability_handler`: a cancelled handler is `CANCELLED` (was `SUCCESS`) and a timeout is `TIMEOUT` (was `ERROR`).

## [0.2.0] - 2026-09-30

- `ExecutionStatus` lists all 11 canonical statuses; `EXECUTION_STATUSES` is exported and checked against `contract/ingest-contract.json`. The status is trimmed and upper-cased; a blank or `None` status is left off the event.

## [0.1.0] - 2026-07

- First version: `AforoAgentClient` (`record_capability`, `record_step`, buffered flush, 3 attempts with backoff), `wrap_capability_handler`, drop observability (`dropped_count`, `on_drop` with `retry_exhausted` / `rejected`), contract test.
