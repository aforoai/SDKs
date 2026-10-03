# Changelog

All notable changes to `aforo-agent-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

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
