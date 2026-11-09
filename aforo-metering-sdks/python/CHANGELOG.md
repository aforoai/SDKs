# Changelog

All notable changes to `aforo-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [2.1.1] - 2026-11-09

### Fixed
- **An event that cannot be sent no longer stops the sender thread.** A string with a lone surrogate (what `json.loads` returns for `"\ud800"`) passed the JSON check, then failed to encode on the sender thread, which died: its batch was lost unreported and every later event stayed queued. It is now dropped as `invalid` when it is recorded, and the sender survives any unexpected error (the batch concerned is reported as `invalid`).
- **Per-event `retryable` re-sends are encoded afresh.** The smaller re-sent body kept the first body's gzip flag and went out as plain JSON labelled `Content-Encoding: gzip`; the ingestor answered 400 and the events were dropped as `rejected`.
- **An event the ingestor cannot read at all is refused when it is recorded.** usage-ingestor reads the whole batch body before it checks any one event, so such a value failed every event of the batch with 400. Now dropped as `invalid`: an `occurredAt` without seconds or a zone (`Z` or `+HH:MM`), a `metadata` / `trace` that is not an object, a `quantity` that is not a number, an object where a string belongs. An optional integer field out of the range the ingestor stores (for example `executionDurationMs` past 2^31 ms) is left off and the event kept.
- **The API key is stripped and checked.** A key read with a trailing newline was sent raw: every request failed and the HTTP library's error, which quotes the header value, put the key into the WARNING log and `on_error`. Surrounding whitespace is now stripped; a key that still holds whitespace, control or non-ASCII characters raises `ValueError` (the key is not shown). Failure text and ingestor messages are redacted of the key before they are logged or passed to `on_error`.
- **A `multiprocessing` child flushes at exit.** A forked child leaves with `os._exit()`, which skips `atexit`, so what it tracked in its last seconds was lost unreported. The client now also registers a multiprocessing exit finalizer, re-registered in each forked child.
- **429 with a per-key limit below the batch size.** When the ingestor answers 429 with `X-RateLimit-Limit` (events per minute for the API key) lower than the batch's event count, the batch goes back to the head of the queue, in order, and is sent in parts of at most that many events; batches stay that small while the ingestor reports the limit. Otherwise 429 is retried as before.
- **`occurred_at` must carry seconds and a zone.** `datetime.utcnow().isoformat()` (no zone) passed the check and made the ingestor reject the whole batch; it is now dropped as `invalid`. `datetime.now(timezone.utc).isoformat()` works. A non-dict `metadata` or `extra_fields` is dropped as `invalid` instead of failing the batch or raising.
- **`quantity` written with an exponent is checked.** `1e16` was counted as one integer digit and passed; it has 17, as the ingestor counts it.
- **All the ingestor's string limits are checked**, taken from `contract/ingest-contract.json`: `teamId`, `parentStepId`, `sessionBoundary` and the protocol labels were missing.
- **`exclude_paths` match on path-segment boundaries** (all middlewares): `/health` excludes `/health` and `/health/db`, no longer `/healthcare/patients`; `/static` no longer excludes `/static-maps`.
- **FastAPI / Starlette:** `/openapi.json` and `/docs` are excluded by default, as documented (the defaults never applied); `exclude_paths=[]` meters every path. A request whose handler raises is metered with `statusCode` 500, as Flask and Django already did; the exception still propagates.
- **Flask** honours `quantity`, `metadata`, `flush_count`, `flush_interval` and `max_queue_size`; they were silently ignored, so `quantity=3` billed 1.
- **Django:** an `AFORO_CUSTOMER_RESOLVER` / `AFORO_CUSTOMER_ID` value shaped like a dotted path that does not import raises `ValueError` at start-up. A typo used to bill every request to the literal string.
- **A customer resolver that raises** is counted as an `invalid` drop (FastAPI, Flask, Django); it was logged at debug and not counted.

## [2.1.0] - 2026-10-30

### Changed
- **Batches are gzip-compressed by default** (wave 8, G269): a body of 1 KiB or more is sent with `Content-Encoding: gzip`, compressed once and re-sent unchanged on every retry; smaller bodies go plain. Needs usage-ingestor wave 8 or later. `compression="none"` always sends plain JSON.

## [2.0.0] - 2026-10-26

Breaking. Migration: give every middleware a `customer_resolver` (or set `trust_customer_header=True` to keep reading `X-Customer-Id`); stop catching `RuntimeError` from `track()` after shutdown; use `https://` for `base_url` (or `allow_insecure_http=True`).

### Changed
- **One transport core (`aforo/_transport`)**, copied byte-for-byte into every Python variant (wave 5, G271). `aforo.transport.Transport` and `aforo.buffer.RingBuffer` are removed.
- **One sender thread per client** (G281). `track()` only queues; it no longer starts a thread when `flush_count` is reached, and nothing sends while holding a lock `track()` needs (G283).
- **Outages no longer drop events** (G267). After `max_retries` (and on 401/403, logged at ERROR) the batch goes back to the front of the queue with the same idempotency keys and the sender pauses 5 s, growing to 5 min with jitter. `retry_exhausted` is no longer reported.
- **Full-jitter backoff** (`retry_base_s` default 0.5); `Retry-After` read as seconds or an HTTP date, capped at 60 s (G268, G283). 413 splits the batch.
- **`shutdown_timeout` is enforced** (G283): `shutdown()` and the `atexit` hook flush for at most that long; events still queued go to `on_drop` with the new reason `shutdown`. `track()` after shutdown no longer raises; the event goes to `on_drop` with the new reason `closed`.
- **Fork-safe** (G282): a client built before `fork()` (gunicorn `--preload`) gets a new lock, queue, HTTP client and sender in each child.
- **One pooled HTTP client per client** (G269, G284), closed on shutdown. Default `flush_count` is 500; batches over 4 MiB are split. No gzip (the ingestor does not decode it yet).
- **`base_url` must be `https://`** except for localhost / 127.0.0.1 / ::1, unless `allow_insecure_http=True` (G270). `AforoOptions` / `MiddlewareOptions` no longer show `api_key` in `repr()`.
- **Field limits count UTF-16 units**, as the ingestor does (G284).
- **Middleware needs a customer resolver** (G265): `customer_resolver` (FastAPI/Flask keyword, `AFORO_CUSTOMER_RESOLVER` setting/config), or `trust_customer_header=True` to read `X-Customer-Id`; neither → `ValueError` at start-up. Django no longer falls back to `request.user.id` on its own; use `aforo.middleware.django.user_id_resolver`. A request with no customer is counted as an `invalid` drop. Middleware errors are logged at debug instead of swallowed silently. Each middleware exposes `.client`.

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
- **`AforoOptions` gains `on_error` and `on_accepted`** (`on_accepted(body, events)` sees the response `data` of every accepted batch). `aforo.TransportError` is exported.

## [1.1.2] - 2026-10-01

### Changed
- **Middlewares (Flask, Django, FastAPI/ASGI): request-derived labels are truncated, not dropped.** `endpointPath` and `httpMethod` are read from the incoming request. A value over the ingestor's limit (`endpointPath` 512, `httpMethod` 16) is cut to the limit and the event is still sent. The length is counted in UTF-16 code units, as the ingestor counts it, and a surrogate pair is never split. Before, the path was cut at 512 code points, which a path containing characters outside the Basic Multilingual Plane could still exceed, and the event was then rejected. One WARNING is logged per field name per process.
- New helpers in `aforo.limits`: `truncate_label`, `truncate_utf16`, `utf16_length`.

### Unchanged
- Fields the caller sets (`customer_id`, `metric_name`, `idempotency_key`, `product_type`, and anything passed in `extra_fields` to `track()`) are never truncated. An over-long one still drops the event with reason `invalid`.
- The idempotency key is the caller's key or a random UUID per event; it does not depend on the request path.

## [1.1.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` and `killedSessionIds` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent and the heartbeat response returned to the caller did not carry `killedSessionIds`. A bare (unwrapped) body is still accepted.

## [1.1.0] - 2026-10-01

Merge of the public repository's fixes with the working repository's 1.0.1.

### Changed
- **Auth:** the API key is sent as `X-API-Key`; no `Authorization` header is sent. The ingestor accepts `X-API-Key` for every key.
- **Default host** is `https://api.aforo.ai` (was `ingest.aforo.ai`, which is not the ingestor).
- **Session heartbeats** have quantity 1, top-level `sessionId` / `productType` / `sessionBoundary`, and are each POSTed alone as `{"events": [hb]}` — never through the usage buffer. One attempt, best-effort; a failed heartbeat is not counted in `dropped_count`. `start_session(customer_id=...)` and the `heartbeat_interval` option are new.
- **Transport:** 408 and 429 are retried (429 honours `Retry-After`); other 4xx are not, and their `errors[].message` is logged. A `202` with `failed` > 0 is read: the rejected events are dropped with reason `rejected` (only the ones the response names by index are passed to `on_drop`). `FlushResult` gains `failed_indices`.
- `flush_count` is clamped to 1..1000, the ingestor's batch limit.
- `occurredAt` defaults to a millisecond ISO-8601 instant with a `Z` suffix.
- **Middleware (FastAPI / Flask / Django):** default metric is `api_calls` (was `"METHOD /path"`); `metric_name`, `customer_id` and `product_type` options; the caller's `X-Api-Key` is never used as the customer id; `OPTIONS` requests are not metered; events carry top-level `endpointPath`, `httpMethod`, `statusCode`, `responseTimeMs`.

### Added
- `product_type` client option (default `API`) and per-event `track(product_type=...)`; every event carries top-level `productType`. `extra_fields` adds optional top-level ingest fields by wire name.
- Field-limit checks mirroring the ingestor (`aforo/limits.py`): `customerId` 64, `metricName` 255, `idempotencyKey` 255, `productType` 20, `quantity` 14 integer / 6 decimal digits, ISO-8601 `occurred_at`, and the `extra_fields` limits.
- Drop reason **`invalid`**: an event with a blank `customer_id` / `metric_name`, `quantity <= 0` or a field over a limit is not buffered or sent. `track()` does **not** raise for it (in 1.0.x a blank `customer_id` / `metric_name` raised `ValueError`); the event is counted in `dropped_count`, WARN-logged (first occurrence, then every 1000th) and passed to `on_drop(events, "invalid")`.

### Unchanged from 1.0.1
- `execution_status`, `on_drop` / `dropped_count`, random per-event idempotency keys minted once at `track()`, the `atexit` flush.

## [1.0.1] - 2026-09-30

- An `execution_status` outside the 11 canonical values (or over 20 characters) is WARN-logged and left off the event; it used to be sent as-is and the ingestor rejected that event.

## 1.0.0 (working repository, 2026-07 – 2026-09)

- `execution_status` on `track()` / `TrackEvent`: optional, trimmed, upper-cased.
- Drop observability: `dropped_count`, WARN log, opt-in `on_drop(events, reason)` with reasons `overflow`, `retry_exhausted`, `rejected`. A hook that calls `flush()` no longer deadlocks.
- An event without a caller `idempotency_key` gets a random UUID (was a content hash that collided for same-instant events). The key is minted once at `track()` and reused by every retry.
- Events are POSTed to `/v1/ingest/batch` as `{"events": [...]}`; a contract test loads `contract/ingest-contract.json`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoClient` (buffered, batched, retrying), the `track()` event API, `flush()`, session heartbeats, and graceful `shutdown()`.
- Documented FastAPI/Starlette (`AforoMeteringMiddleware`), Flask (`AforoMetering`), and Django (`AforoMeteringMiddleware`) adapters, including customer-ID resolution and path/status exclusions.
- Full configuration reference for `AforoOptions`, `track()` arguments, and `MiddlewareOptions`.
- Events deliver to `POST https://ingest.aforo.ai/v1/ingest/batch` with Bearer auth.

[1.0.0]: https://github.com/aforoai/SDKs/releases/tag/v1.0.0
