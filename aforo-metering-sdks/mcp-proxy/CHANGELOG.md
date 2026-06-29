# Changelog

All notable changes to `@aforo/mcp-proxy` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

The proxy surface as documented at this version:

- `aforo-mcp-proxy` CLI with `stdio`, `sse`, and `streamable-http` transports.
- Config resolution with precedence env var > CLI flag > config file > default.
- Meters `tools/call` (tracks `tools/list` / `resources/read` / `prompts/get`; ignores protocol chatter), batched to `<ingestorUrl>/v1/ingest/batch` with `Authorization: Bearer <apiKey>` and `X-Tenant-Id`. 3-attempt backoff, then drop.
- Optional `--quota-enforcement`: pre-flight `POST /api/v1/quota/check`, 50ms budget, fail-open, 5s in-process deny cache; `DENY` returns JSON-RPC error `-32000`.
- Session heartbeats and graceful child-process shutdown (SIGTERM then SIGKILL after 2s) in stdio mode.
