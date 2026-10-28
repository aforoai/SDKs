# Changelog

All notable changes to `@aforoai/graphql-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

## [2.0.0] - 2026-10-26

Breaking. Migration: pass `customerResolver: (context) => …` (or `trustCustomerHeader: true` behind a proxy you control) to `new AforoGraphQlBilling`, use an `https://` `ingestorUrl` (or `allowInsecureHttp: true`), and call `await billing.shutdown()` from your SIGTERM handler.

### Fixed (transport core, review of 2026-10-26)
These come from the shared Node core (`src/transport-core/core.ts`) and follow contract/TRANSPORT-SPEC.md "Edge cases every core handles the same way".
- **The request deadline covers reading the response body.** A server that sent headers and then stalled, or dripped the body a byte at a time, held `flush()` and `shutdown()` forever; the read is now inside `timeoutMs` and the batch is retried.
- **Redirects are never followed.** Every request is sent with `redirect: 'manual'`, so the API key cannot reach the host a 3xx names. A 3xx keeps the batch queued, opens the breaker and is logged once at ERROR with the target host (never the key); fix the base URL and the queue drains without loss. `onError` gets `kind: 'outage'` with the 3xx `status`.
- **Events are serialized when tracked.** An event JSON cannot represent (a `BigInt`, a cycle, `NaN` or `Infinity` in metadata) is dropped as `invalid` and counted at track time; before, it made the whole batch fail to serialize and every event in it was lost unreported. Later changes to a tracked object are no longer sent.
- **Exit flush waits for the batch in flight.** On `beforeExit` the process stays alive (up to the shutdown deadline) until the queue and the batch being sent or retried are done. It used to exit during a retry and lose that batch.
- **Per-event `retryable` failures back off and are capped.** They are re-sent after the normal jittered backoff, at most `maxRetries` times, then treated as an outage; a 2xx that hits the cap no longer resets the breaker, so its cooldown keeps growing instead of flapping.
- **Breaker cooldown is `max(250 ms, random(0, ceiling))`** even when a small `breakerInitialMs` is configured.

### Changed (breaking)
- **Customer identity (G265).** The constructor throws unless you pass `customerResolver` (`customerIdExtractor` still works as a deprecated alias) or `trustCustomerHeader: true`. The `x-customer-id` header and the context's `customerId` are no longer read by default. An operation with no customer — including `record()` with a blank `customerId` — is counted as an `invalid` drop instead of being skipped silently.
- **Metering runs after the response is sent (G298).** `middleware()` calls the original `res.end` first and parses/records on the next turn (`setImmediate`); the Apollo plugin records after `willSendResponse` the same way. `flush()` and `shutdown()` wait one turn first so those operations are included.
- **Delivery (G266, G267, G268, G296).** Bounded queue (`maxQueueSize`, default 10 000; overflow drops the oldest) with one background sender — recording never starts a request. Every request has a total deadline (`AbortSignal.timeout`, `timeoutMs`). Full-jitter retries; `Retry-After` in both forms, capped at 60 s. After the retries, or on 401/403, the batch is requeued with its keys behind a breaker; `retry_exhausted` is no longer produced. New drop reasons `overflow`, `shutdown`, `closed`.
- **Defaults (G269).** `flushCount` 500 (was 50).
- **https required (G270).** `ingestorUrl` must be `https://` except for localhost; the API key is held only by the transport and never shown by `inspect()` / `JSON.stringify`.
- `shutdown()` is bounded by `shutdownTimeoutMs`; events still queued then are dropped with reason `shutdown` and reported through `onError`.

### Added
- `onError` receives a `CoreTransportError` (still an `Error`) for delivery reports: branch on `err.kind` — `outage`, `auth` (401/403, wrong or revoked key), `rejected`, `shutdown`, `closed` — and read `err.events` instead of matching the message. Exported from the package.
- Shared Node transport core in `src/transport-core/` (copied from `node/`, G271).
- `flush()`, `queuedCount`, and the options `allowInsecureHttp`, `maxQueueSize`, `maxRetries`, `timeoutMs`, `shutdownTimeoutMs`, `flushOnExit`. `User-Agent: aforo-graphql-metering/<version>`.

## [1.2.2] - 2026-10-01

### Changed
- **An operation name longer than 255 characters is truncated, and the event is sent.** The name is read from the incoming query, so dropping the event let a caller avoid metering by sending a long name. `gqlOperationName` is cut to 255 UTF-16 code units (never splitting a surrogate pair). One WARN is logged per label name per `AforoGraphQlBilling` instance.
- **Idempotency key.** Still `gql:{tenantId}:{productId}:{operationName}:{millis}:{random}`, minted once per event from the untruncated name. When that is longer than 255 characters the name is replaced by its SHA-256 hex digest; the key is no longer cut from the front. Keys of 255 characters or fewer are built exactly as before.

### Unchanged
- An over-long `customerId` (64) or `productType` (20) still drops the event with reason `'invalid'`; nothing the caller sets is altered.

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
- Events get a top-level `productType` (default `GRAPHQL_API`; client option `productType`, per call `record({ productType })`, per integration `middleware({ productType })` / `aforoApolloPlugin(billing, { productType })`), trimmed and upper-cased.
- An event the ingestor would refuse is dropped before it is buffered, with drop reason `invalid`: `customerId` over 64 characters, operation name over 255, `productType` over 20. Nothing is truncated and `record()` does not throw.
- `executionDurationMs` is rounded to an integer. The SDK-generated `idempotencyKey` stays within 255 characters (tail kept); it is still minted once, when the event is recorded.
- A flush is split into requests of at most 1000 events, the ingestor's batch limit.
- Only network errors, 408, 429 (honouring `Retry-After`, capped at 30 s) and 5xx are retried. Any other 4xx is not retried: the batch is dropped with reason `rejected` and `onError` carries the ingestor's `errors[].message`.
- A 2xx response with `failed > 0` is reported through `onError`; the events its `errors[]` names by index are dropped with reason `rejected` (counted only, when no usable index is given).
- New drop reason `invalid` on `onDrop` / `droppedCount` for events that fail a client-side check. The warning is logged for the first occurrence per field and every 1000th after.
- A throwing `onError` hook can no longer make a delivered batch look like a network failure and be re-sent.
- `package.json` license is `Apache-2.0`.

## [1.1.1] - 2026-09-30

- A caller `executionStatus` outside the 11 accepted values (or a Promise from an async resolver) is reported through `onError` and ignored; the derived status is sent instead, or none when nothing can be derived.
- `errors` counts as present unless it is missing, `null` or `[]`. A non-array `errors` used to be treated as none, so a failed request billed `SUCCESS`. `gqlHasErrors` follows the same rule whenever the response is known.

## [1.1.0] - 2026-09-30

- `executionStatus` on every event, derived from the GraphQL response (`outcomeFromGraphQlResponse`) or the HTTP status (`outcomeFromHttpStatus`); override with `record({ executionStatus })`, `middleware({ executionStatus })` or `aforoApolloPlugin(billing, { executionStatus })`.
- Shipped earlier in 2026-07 without a version bump: `droppedCount` and the opt-in `onDrop(events, reason)` hook (reasons `retry_exhausted`, `rejected`); batches POSTed to `/v1/ingest/batch` (they went to `/v1/ingest/events`, a single-event endpoint, and every flush was refused); a contract test that checks the wire request against `contract/ingest-contract.json`; `onError` fires once, not twice, when retries are exhausted on a network error.

## [1.0.0] - 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoGraphQlBilling` class: buffered, batched, retrying GraphQL operation metering.
- `aforoApolloPlugin(billing)` for Apollo Server 4; `billing.middleware()` for Express / `graphql-http` / `express-graphql`.
- AST complexity scoring via `defaultComplexityScorer` (`fieldCount + 5 × maxDepth`), overridable per instance.
- Events posted to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer` + `X-Tenant-Id`; 3× exponential-backoff retry (1s/2s/4s) then `onError`.
- Defaults: `flushCount` 50, `flushIntervalMs` 5000.
