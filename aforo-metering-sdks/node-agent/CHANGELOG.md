# Changelog

All notable changes to `@aforoai/agent-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

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
