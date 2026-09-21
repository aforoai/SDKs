# Changelog

All notable changes to `@aforoai/agent-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

The SDK surface as documented at this version:

- `AforoAgent` client with `startSession`, `emitEvent`, and `flush`.
- `AgentSession` handle with `recordStep`, `recordToolCall`, and `end`.
- Direct buffered/batched emit to `https://usage-ingestor.aforo.ai/v1/ingest` (override via `ingestorUrl`), with `Authorization: Bearer <apiKey>` and `X-Tenant-Id`.
- Best-effort delivery: a failed flush logs and drops the batch.
