# Changelog

All notable changes to `@aforo/mcp-proxy` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- **Fix:** session heartbeats (`system.session.heartbeat`, quantity 0) are no longer sent in the usage batch; the ingestor rejects quantity 0 and failed the whole batch with 400. Session start/end methods are kept as no-ops/flush, heartbeat options are ignored.
- **Fix:** a flush holding more than 1000 events is sent as several `/v1/ingest/batch` requests of at most 1000. The ingestor rejects larger batches with 400, which lost every event in them.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

The proxy surface as documented at this version:

- `aforo-mcp-proxy` CLI with `stdio`, `sse`, and `streamable-http` transports.
- Config resolution with precedence env var > CLI flag > config file > default.
- Meters `tools/call` (tracks `tools/list` / `resources/read` / `prompts/get`; ignores protocol chatter), batched to `<ingestorUrl>/v1/ingest/batch` with `Authorization: Bearer <apiKey>` and `X-Tenant-Id`. 3-attempt backoff, then drop.
- Optional `--quota-enforcement`: pre-flight `POST /api/v1/quota/check`, 50ms budget, fail-open, 5s in-process deny cache; `DENY` returns JSON-RPC error `-32000`.
- Session heartbeats and graceful child-process shutdown (SIGTERM then SIGKILL after 2s) in stdio mode.
