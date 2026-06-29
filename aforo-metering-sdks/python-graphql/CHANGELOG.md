# Changelog

All notable changes to `aforo-graphql-metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- Documented `AforoGraphQlBilling`, the Strawberry `strawberry_extension(billing)`, and the framework-agnostic `asgi_middleware(billing, path=...)`.
- Documented AST complexity scoring (`default_complexity_scorer`, override via `complexity_scorer`) and customer-ID resolution (`x-customer-id` default, override via `customer_id_extractor`).
- Full configuration reference; one `graphql_api.operations` event per operation, delivered to `POST https://ingest.aforo.ai/v1/ingest/events` with Bearer auth and an `X-Tenant-Id` header.

[Unreleased]: https://github.com/aforoai/aforo-metering-sdks/compare/python-graphql-v1.0.0...HEAD
[1.0.0]: https://github.com/aforoai/aforo-metering-sdks/releases/tag/python-graphql-v1.0.0
