# Changelog

All notable changes to `@aforo/mcp-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Fix:** session heartbeats (`system.session.heartbeat`, quantity 0) are no longer sent in the usage batch; the ingestor rejects quantity 0 and failed the whole batch with 400. Session start/end methods are kept as no-ops/flush, heartbeat options are ignored.
- **Fix:** a flush holding more than 1000 events is sent as several `/v1/ingest/batch` requests of at most 1000. The ingestor rejects larger batches with 400, which lost every event in them.
- **Fix:** tool-invocation `idempotencyKey`s carry a random suffix. A millisecond timestamp alone collided for two calls of the same tool in the same millisecond, and the ingestor dropped the second as a duplicate.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

The SDK surface as documented at this version:

- `AforoMcpBilling` client with `wrapToolHandler`, `recordToolInvocation`, `startSession`, `endSession`, `flush`, and `shutdown`.
- Buffered/batched emit of `mcp_server.tool_invocations` events to `<ingestorUrl>/v1/ingest/batch` with `Authorization: Bearer <apiKey>` and `X-Tenant-Id`. 3-attempt exponential backoff; 4xx (except 408/429) is not retried.
- Session heartbeats (`system.session.heartbeat`, 30s default) with server-driven kill signals surfaced via `onSessionKilled`.

> Source note: `package.json` is authoritative at `1.0.0`. The source carries an internal `SDK_VERSION = '1.1.0'` constant in heartbeat metadata (and a separate `sdkVersion: '1.0.0'` literal in tool-invocation metadata) — a metadata-only inconsistency that does not affect the package version or behavior.
