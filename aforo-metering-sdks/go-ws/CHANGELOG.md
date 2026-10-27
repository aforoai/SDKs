# Changelog

All notable changes to `ws-metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [2.0.0] - 2026-10-26

**Breaking.** New import path `github.com/aforoai/SDKs/aforo-metering-sdks/go-ws/v2`. Migration: `billing.Shutdown(ctx)` takes a context; add the metric `websocket_api.connection_opened` to your catalog if you bill connections opened.

### Changed
- **Transport edge cases (wave 5 review, contract/TRANSPORT-SPEC.md "Edge cases").** Redirects are never followed, also with a caller-supplied `HTTPClient` (a copy with redirects refused is used): a `3xx` is logged at ERROR with the target host and handled like an outage. Every `5xx` is retried (`501`/`505` were dropped). `Timeout` now also covers reading the response body; a `2xx` whose body is cut off is retried with the same keys instead of counted as sent. Events a `2xx` names in `errors[]` as `retryable` are resent after the normal backoff at most `MaxRetries` times, then handled as an outage; `errors[]` is used even when `failed` is missing or 0. The breaker pause is `max(250 ms, random(0, 5 s·2^n))`, capped at 5 min (it was 5 s plus jitter). Shutdown keeps retrying an unreachable ingestor until its deadline instead of stopping at the first outage. `Retry-After` accepts fractional seconds (`1.5`). A second close returns the first one's result.
- **Callbacks may call Flush and Close.** Calling them from `OnDrop`, `OnError` or `OnAccepted` deadlocked the sender; `Flush` now returns at once there and close starts the shutdown and returns.
- **Typed `OnError` and new `OnAccepted`.** Sending problems reach `OnError` as `*TransportError` (`errors.As`, branch on `Kind`: `KindOutage`, `KindAuth`, `KindRejected`, `KindShutdown`, `KindClosed`; `Events` holds the events). The signature stays `func(error)`; invalid events still arrive as a plain error. `Config.OnAccepted(body, events)` receives each `2xx` body (envelope removed, e.g. `killedSessionIds`).
- **`ConnectionIdleTimeout` must not be negative.** `New` returns an error for a negative value (it switched the idle sweep off, so the connection map could grow without bound). Migration: drop a negative setting; 0 means the 1 h default.
- **`Open` racing `Shutdown`.** An `Open` that ran while `Shutdown` was closing connections could be billed `CONNECTION_OPENED` with no `CONNECTION_CLOSED`. It is now either closed by `Shutdown` or refused as `closed` and not sent.
- **OPEN has its own frame type (G279).** `CONNECTION_OPENED` is sent with `wsFrameType: "OPEN"` and metric `websocket_api.connection_opened` (it was `PING` / `websocket_api.message`).
- **No leaked connections (G279).** `Shutdown` emits `CONNECTION_CLOSED` (`GOING_AWAY`, metadata `closedBy: "sdk_shutdown"`) for every connection still open, and a sweep closes connections idle longer than `ConnectionIdleTimeout` (default 1 h; `ABNORMAL_CLOSURE`, `closedBy: "sdk_idle_timeout"`). New `OpenConnections()`.
- Identity: `Open` takes the customer id you resolved; there is no default identity source, so no resolver option is needed.

### Changed (all Go variants)
- **Bounded queue, one sender (G266, G276).** Recording appends to a bounded queue (`MaxQueueSize`, default 10 000; when full the oldest event is dropped as `overflow`) and wakes one long-lived sender. It no longer starts a goroutine per push or keeps an unbounded slice.
- **Outages keep the events (G267).** After the retries, and on `401`/`403`, a batch goes back to the front of the queue with the same idempotency keys and the sender pauses (5 s, doubling to 5 min). `retry_exhausted` is no longer reported.
- **Bounded shutdown.** `Shutdown(ctx)` sends until the earlier of `ctx`'s deadline and `ShutdownTimeout` (5 s), reports the rest as `shutdown` and returns an error wrapping `ErrShutdownIncomplete`. Recording after `Shutdown` reports `closed`. New `Flush(ctx)`.
- **Retries (G268).** Full-jitter backoff (base 500 ms, cap 30 s); `Retry-After` in seconds or HTTP-date form, capped at 60 s; `413` splits the batch; per-event `retryable` failures are requeued.
- **Batches and connections (G269).** Default `FlushCount` 500 (was 100 events / 3 s), `FlushInterval` 5 s. One pooled HTTP client. No gzip (the ingestor does not decode it).
- **https only (G270).** `New` returns an error for an `http://` `IngestorURL` other than localhost unless `AllowInsecureHTTP` is set. `Config.String()` never prints the API key.
- **One transport core (G271).** Sending is `internal/ingest`, a byte-identical copy of the Go core's (`scripts/sync-transport.sh`). New `Config` fields: `AllowInsecureHTTP`, `MaxQueueSize`, `MaxRetries`, `RetryBase`, `Timeout`, `ShutdownTimeout`. New drop reasons `DropOverflow`, `DropShutdown`, `DropClosed`. Requests send `User-Agent: aforo-go-ws/2.0.0`.
- A blank customer id is no longer skipped silently: it is dropped as `invalid` and counted.
- `VERSION`: 2.0.0.

## [1.2.1] - 2026-10-01

### Fixed
- **2xx responses are read from the `{success, data}` envelope.** The ingestor wraps every 2xx JSON body, so `failed`, `errors[]` arrive under `data`. They were read at the top level, where they are never present, so events the ingestor rejected inside a 2xx response were counted as sent. A bare (unwrapped) body is still accepted.

## [1.2.0] - 2026-10-01

### Changed
- Merge of the working repository and the public `aforoai/SDKs` repository. Both sets of behaviour are kept.
- `EventOptions` carries both `ExecutionStatus` and `ProductType`. The recording methods accept optional trailing `EventOptions`; the `*WithOptions` forms remain.
- Transport: a non-retryable `4xx` drops the batch with `DropRejected` after one attempt; exhausted retries drop it with `DropRetryExhausted`; a `2xx` partial-failure response drops only the events named by `errors[].index` (`DropRejected`), and failures the ingestor does not identify are counted without naming an event. All of these count in `DroppedCount()` and reach `Config.OnDrop`.
- New drop reason `DropInvalid` (`invalid`): an event that fails client-side validation is not buffered; it is counted, WARN-logged (first occurrence, then every 1000th), reported via `OnError` and passed to `OnDrop`. Covers `customerId` > 64 and `productType` > 20; `Open` returns `""`.
- Length limits count characters (UTF-16 code units, as the server does), not bytes.
- `sdkVersion` and `VERSION`: 1.2.0. Releases are git tags `aforo-metering-sdks/go-ws/vX.Y.Z` on github.com/aforoai/SDKs.

### From the public repository
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** batches are POSTed to `/v1/ingest/batch` instead of `/v1/ingest/events`. `/v1/ingest/events` is a single-event Apigee-format endpoint and does not accept `{"events":[...]}`, so batches were not being ingested.
- Each flush is split into requests of at most 1000 events (the ingestor's batch limit). Retries resend the same body, so `idempotencyKey`s are stable across attempts.
- Events whose `customerId` exceeds 64 characters are dropped (reason `invalid`) and reported via `OnError` instead of being rejected by the ingestor.
- Duration is sent as `executionDurationMs`; the previous `durationMs` is not an ingestor field and was silently dropped. `wsDirection` / `wsFrameType` from `RecordFrame` are upper-cased and omitted when outside the ingestor's enums, instead of getting the event rejected.
- `productType` is now configurable: new `Config.ProductType` (default `"WEBSOCKET_API"`, previously hard-coded) and a per-event `EventOptions{ProductType}` override (`Open`, applied to all of that connection's events). Values are trimmed and upper-cased; unknown values are passed through.
- Delivery follows the ingestor contract: a non-retryable `4xx` (anything but `408`/`429`) is reported via `OnError`, dropped with reason `rejected` and no longer retried; `429` honours `Retry-After` (capped at 60s); the ingestor's `errors[].message` is included in `OnError` messages, and a `2xx` with `failed > 0` is reported too. Blank (whitespace-only) customer ids are skipped like empty ones.

## [1.1.1] - 2026-09-30

- An `executionStatus` outside the 11 canonical values (or longer than 20 characters) is WARN-logged and left off the event instead of being sent; the ingestor rejected such events.

## [1.1.0] - 2026-09-30

- Optional `executionStatus` on every event, trimmed and upper-cased. Sent only when passed (`OpenWithOptions`, `RecordFrameWithOptions`, `CloseWithOptions`).

## Earlier working-repo changes (reported as 1.0.0)

- 2026-09-30: module path is `github.com/aforoai/SDKs/aforo-metering-sdks/go-ws`.
- 2026-07-05: drop observability — `DroppedCount()`, WARN log and the opt-in `Config.OnDrop(events, reason)` hook (`retry_exhausted`, `rejected`); batches are POSTed to `/v1/ingest/batch`; ingest-contract test driven by `contract/ingest-contract.json`.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field) and in the package's `sdkVersion` constant.

Documents the existing package as-is: the `wsmetering` package at module path `github.com/aforo/ws-metering-go` — `New`/`Config`, `Open`, `RecordFrame`, `Close`, and `Shutdown`. Per-connection aggregation (frames + bytes + duration) emitting a `websocket_api.message` open event and a `websocket_api.connection_closed` close event with WebSocket close-code → reason mapping, optional `PerFrameEvents`, `X-Tenant-Id` header, batched delivery with 3× retry to `POST /v1/ingest/events`. Framework-agnostic (no WebSocket-library dependency). No source logic changed.
