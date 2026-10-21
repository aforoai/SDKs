# Changelog

All notable changes to `@aforoai/agent-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [2.0.0] - 2026-10-21

The SDK now speaks the usage ingestor's batch contract.

### Changed
- **Endpoint.** Events are sent in batches of up to `maxBatchSize` (default 100, max 1000) to `POST /v1/ingest/batch` as `{"events":[...]}`. Default endpoint `https://api.aforo.ai/v1/ingest/batch` (new `endpoint` option; a bare host or `.../v1/ingest` is completed). Before, each event went alone to the Apigee-format `/v1/ingest/events`.
- **Event shape.** Each event is an `IngestUsageEventRequest`: `customerId`, `metricName`, `quantity`, `occurredAt`, `idempotencyKey`, `productType` (`AI_AGENT`), top-level `agentId`, `sessionId`, `traceId`, optional `subscriptionId`, `capabilityName`, `executionStatus`, `executionDurationMs`, `stepNumber`, `parentStepId`, `sessionBoundary`, and `metadata` (`model_provider`, `model_name`, `input_tokens`, `output_tokens`, `productId`, ...). The `eventType` / `metricKey` / `value` / `properties` fields are gone.
- **Metric names** are the default AI_AGENT catalog names (`Agent Sessions`, `Agent Steps`, `Agent Tool Calls`, `Tokens Consumed`, `Execution Minutes`, `GPU Hours`, `Knowledge Queries`, `Tasks Completed`, `Active Agents`) and can be overridden with `metricNames`. Before: `session_count`, `step_count`, `tokens_total`, `session_completed`.
- **Session events.** `startSession()` sends nothing and returns the session synchronously (awaiting it still works). `end()` / `endSession()` sends `Tasks Completed` (if `taskCompleted`), `Execution Minutes` (if given), then `Agent Sessions` with `sessionBoundary: "SESSION_END"`. A `TOOL_CALL` step also counts one `Agent Tool Calls`.
- **Idempotency keys** are deterministic, `<sessionId>:<n>`. Generated session ids are UUIDs; each session gets a 32-hex `traceId`.
- **Failed flushes no longer lose events.** On a network error, 408, 429 (`Retry-After` honoured) or 5xx after `maxRetries` attempts, the batch stays in a bounded buffer (`maxBufferSize`, default 10000) and is re-sent on the next flush. Overflow drops the oldest events and reports them.
- **The batch response is read.** A 202 with `data.failed > 0` / `data.errors[]` is reported as `partial` with the per-event messages and idempotency keys; duplicates count as accepted.
- `record*` calls no longer wait for the network; a full batch flushes in the background. `flush()`, `end()` and the new `shutdown()` resolve to `{ accepted, duplicates, failed, pending }`.
- Zero quantities are skipped instead of reported as invalid.

### Added
- `onError(err)` with `err.kind` `retrying` | `partial` | `rejected` | `invalid` | `overflow`; `logger` option (default `console`, `null` silences).
- Config `agentId`, `subscriptionId`, `endpoint`, `metricNames`, `maxBatchSize`, `maxBufferSize`, `requestTimeoutMs`.
- `session.recordTokens(model, input, output)`, `session.recordUsage(metric, quantity)`, `session.endSession()`, `agent.shutdown()`, `agent.pendingCount`, `DEFAULT_METRIC_NAMES`, `resolveEndpoint()`.

### Deprecated
- `tenantId` (ignored; the API key identifies the tenant, and `X-Tenant-Id` is no longer sent), `ingestorUrl` (use `endpoint`), `flushBatchSize` (use `maxBatchSize`), `onDrop` (use `onError`; still called for dropped events), `emitEvent()` (maps `metricKey`/`value` to `metricName`/`quantity`), the `UsageEvent` type (now `IngestEvent`).
- `tenantId` and `productId` are no longer required.

## [1.2.0] - 2026-10-01

Merge of the public-repo fixes with the working repo's wire contract. The wire shape is unchanged: one Apigee-format event per `POST <ingestorUrl>/events` (`/v1/ingest/events` in `contract/ingest-contract.json`). The public repo's switch to `/v1/ingest/batch` was not taken.

### Changed
- **Auth header.** The API key is sent as `X-API-Key`; `Authorization` is no longer sent.
- **Default `ingestorUrl`** is `https://api.aforo.ai/v1/ingest`. A bare host (`https://api.aforo.ai`, `http://localhost:8084`) gets `/v1/ingest` added; a URL already ending in `/events` or `/batch` is accepted. Events always go to `…/v1/ingest/events`.
- **`customerId` is sent top-level on every event.** The `/v1/ingest/events` endpoint requires it. Set it on the client, per session (`startSession({ customerId })`) or per event (`emitEvent({ customerId })`).
- **Retries.** Each event is retried on 408, 429 (`Retry-After` honoured), 5xx and network errors, up to `maxRetries` attempts (default 3) with exponential backoff from `retryBaseDelayMs` (default 1000), always with the same body and idempotency key. Other 4xx are not retried. Before, each event was sent once.

### Added
- `productType` option (default `AI_AGENT`) on the client, per session and per event; trimmed and upper-cased. It is sent top-level and in `properties`. The `/v1/ingest/events` endpoint derives the product type from the event type (`agent_*` and `token_usage` are AI_AGENT).
- `StartSessionOptions.traceId` (sent as `properties.traceId` when set) and `RecordStepOptions.parentStepId`.
- `maxRetries` and `retryBaseDelayMs` options; `AgentEventInput` type.
- **Client-side validation, reported as a drop.** An event the ingestor would reject — no `customerId`, blank `metricKey` / `agentId` / `sessionId`, `value` not > 0, `customerId` over 64 characters, `agentId` over 36, `sessionId` over 64, `capabilityName` over 64, `metricKey` over 255, `productType` over 20 — is not buffered and not sent. `startSession()` and `emitEvent()` do not throw for it. The event is counted in `droppedCount`, WARN-logged (first occurrence, then every 1000th) and passed to `onDrop` with the new reason `'invalid'`. Nothing is truncated.
- The server's error message is included in the WARN for a rejected event.

### Unchanged
- `executionStatus`: the 11 canonical statuses, trimmed and upper-cased, sent in `properties`; an unknown value is logged and left off.
- Idempotency keys: one random key per event, stamped when the event is created, reused by every retry and by `onDrop` replays.
- Top-level `capabilityName`; `onDrop` reasons `retry_exhausted` / `rejected`.

## [1.1.1] - 2026-09-30

### Fixed
- A `metadata.executionStatus` can no longer override the step's status.
- An unknown `executionStatus` is logged and left off the event; the event is still sent.

## [1.1.0] - 2026-09-30

### Added
- `ExecutionStatus` lists all 11 canonical statuses (`PARTIAL`, `FAILED`, `VALIDATION_FAILED`, `FAILURE`, `PENDING` and `BLOCKED` used to fail to compile). `EXECUTION_STATUSES` is exported and checked against `contract/ingest-contract.json`.
- Drop observability: `droppedCount`, WARN log, opt-in `onDrop(events, reason)`.
- Top-level `capabilityName` on step events.

### Fixed
- Events are posted one per request to `/v1/ingest/events`; the earlier `{events:[...]}` body to `/v1/ingest` was rejected on every flush.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

The SDK surface as documented at this version:

- `AforoAgent` client with `startSession`, `emitEvent`, and `flush`.
- `AgentSession` handle with `recordStep`, `recordToolCall`, and `end`.
- Direct buffered/batched emit to `https://usage-ingestor.aforo.ai/v1/ingest` (override via `ingestorUrl`), with `Authorization: Bearer <apiKey>` and `X-Tenant-Id`.
- Best-effort delivery: a failed flush logs and drops the batch.
