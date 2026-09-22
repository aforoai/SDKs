# Changelog

All notable changes to `aforo-graphql-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- `product_type` constructor option (default `"GRAPHQL_API"`) for the top-level `productType` the ingestor requires on every event, with a per-event override via `record(product_type=...)`. Values are trimmed and upper-cased; unknown values are passed through rather than rejected.

### Fixed
- Batch delivery no longer retries 4xx responses other than 408 and 429 (a bad key or invalid batch cannot succeed on retry), honours `Retry-After` on 429 (capped at 60 s), no longer sleeps after the final attempt, and passes the ingestor's `errors[].message` to `on_error`, including per-event failures reported in a 202 response.
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use `https://api.aforo.ai`, Aforo's public API gateway in front of the ingestor (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- **Breaking (fix):** batches are POSTed to `/v1/ingest/batch` instead of `/v1/ingest/events`. `/v1/ingest/events` is the Apigee-format single-event endpoint and does not accept `{"events": [...]}`, so no usage was being recorded. Each flush is split into requests of at most 1000 events (the ingestor's batch limit).
- Events with a blank or over-64-character `customerId` are dropped client-side (the ingestor rejects them), and over-long `idempotencyKey`s are capped at 255 characters.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoGraphQlBilling`, the Strawberry `strawberry_extension(billing)`, and the framework-agnostic `asgi_middleware(billing, path=...)`.
- Documented AST complexity scoring (`default_complexity_scorer`, override via `complexity_scorer`) and customer-ID resolution (`x-customer-id` default, override via `customer_id_extractor`).
- Full configuration reference; one `graphql_api.operations` event per operation, delivered to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[Unreleased]: https://github.com/aforoai/aforo-metering-sdks/compare/python-graphql-v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-sdks/releases/tag/python-graphql-v1.0.0
