# Changelog

All notable changes to `aforo-mcp-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoMcpBilling` and the `@billing.wrap_tool_handler` decorator: per-call timing, `SUCCESS`/`ERROR` status, and one `mcp_server.tool_invocations` event per invocation.
- Documented session heartbeats (`start_session` / `end_session`, periodic `system.session.heartbeat`) and the server-driven `killedSessionIds` / `on_session_killed` signal.
- Full configuration reference; events deliver to `POST https://ingest.aforo.ai/v1/ingest/batch` with Bearer auth and an `X-Tenant-Id` header.

[Unreleased]: https://github.com/aforoai/aforo-metering-sdks/compare/python-mcp-v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-sdks/releases/tag/python-mcp-v1.0.0
