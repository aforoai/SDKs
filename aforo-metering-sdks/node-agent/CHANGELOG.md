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

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

The SDK surface as documented at this version:

- `AforoAgent` client with `startSession`, `emitEvent`, and `flush`.
- `AgentSession` handle with `recordStep`, `recordToolCall`, and `end`.
- Direct buffered/batched emit to `https://usage-ingestor.aforo.ai/v1/ingest` (override via `ingestorUrl`), with `Authorization: Bearer <apiKey>` and `X-Tenant-Id`.
- Best-effort delivery: a failed flush logs and drops the batch.
