# Changelog

All notable changes to `@aforoai/agent-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- **Breaking (fix):** events go to `POST /v1/ingest/batch` as `{"events":[...]}` in the ingestor's event shape. The old default, `/v1/ingest`, takes a single event, so no batch was ever accepted. An `ingestorUrl` ending in `/v1/ingest` is rewritten to `/v1/ingest/batch`.
- **Breaking (fix):** a `customerId` is now required, either on the client or per session through `startSession({ customerId })`. The ingestor rejects events without one.
- Each event now carries `customerId`, `metricName`, `quantity`, `occurredAt`, `idempotencyKey`, `productType: AI_AGENT`, `agentId`, `sessionId` and `traceId`. `traceId` defaults to the session id. `stepNumber`, `capabilityName`, `executionStatus`, `executionDurationMs` and `parentStepId` are sent when present. All other properties, including `eventType` and `productId`, go into `metadata`.
- The API key is no longer copied into every event body. It is sent only in the `X-API-Key` header.
- The ingestor has no `CANCELLED` or `HITL_REQUIRED` execution status, so these are sent as `metadata.agentExecutionStatus`.
- Flushes are split into requests of at most 1000 events.
- New optional fields: `StartSessionOptions.customerId`, `StartSessionOptions.traceId` and `RecordStepOptions.parentStepId`.
- `agentId` over 36 characters (the ingestor's limit) makes `startSession()` throw. `emitEvent()` logs and drops an event with a blank `metricKey`, `sessionId` or `agentId` (or one over 36 chars) or a `value` that is not > 0, instead of buffering it — one invalid event fails its whole batch.
- Failed batches are retried: 408, 429 (honouring `Retry-After`), 5xx and network errors, up to `maxRetries` attempts (default 3) with exponential backoff from `retryBaseDelayMs` (default 1000). Other 4xx are not retried. Each retry re-sends the same idempotency keys. Per-event rejections in a 2xx response are logged from `errors[].message`.

### Added
- `productType` option (default `AI_AGENT`) on the client, overridable per session (`startSession({ productType })`) and per event (`emitEvent({ productType })`). It was hard-coded to `AI_AGENT`. Values are trimmed and uppercased; unknown values pass through.
- `maxRetries` and `retryBaseDelayMs` options.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

The SDK surface as documented at this version:

- `AforoAgent` client with `startSession`, `emitEvent`, and `flush`.
- `AgentSession` handle with `recordStep`, `recordToolCall`, and `end`.
- Direct buffered/batched emit to `https://usage-ingestor.aforo.ai/v1/ingest` (override via `ingestorUrl`), with `Authorization: Bearer <apiKey>` and `X-Tenant-Id`.
- Best-effort delivery: a failed flush logs and drops the batch.
