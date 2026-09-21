# Changelog

All notable changes to `aforo-graphql-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** batches are POSTed to `/v1/ingest/batch` instead of `/v1/ingest/events`. `/v1/ingest/events` is the Apigee-format single-event endpoint and does not accept `{"events": [...]}`, so no usage was being recorded. Each flush is split into requests of at most 1000 events (the ingestor's batch limit).
- Events with a blank or over-64-character `customerId` are dropped client-side (the ingestor rejects them), and over-long `idempotencyKey`s are capped at 255 characters.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoGraphQlBilling`, the Strawberry `strawberry_extension(billing)`, and the framework-agnostic `asgi_middleware(billing, path=...)`.
- Documented AST complexity scoring (`default_complexity_scorer`, override via `complexity_scorer`) and customer-ID resolution (`x-customer-id` default, override via `customer_id_extractor`).
- Full configuration reference; one `graphql_api.operations` event per operation, delivered to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[Unreleased]: https://github.com/aforoai/aforo-metering-sdks/compare/python-graphql-v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-sdks/releases/tag/python-graphql-v1.0.0
