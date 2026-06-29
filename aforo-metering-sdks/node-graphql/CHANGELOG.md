# Changelog

All notable changes to `@aforo/graphql-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoGraphQlBilling` class: buffered, batched, retrying GraphQL operation metering.
- `aforoApolloPlugin(billing)` for Apollo Server 4; `billing.middleware()` for Express / `graphql-http` / `express-graphql`.
- AST complexity scoring via `defaultComplexityScorer` (`fieldCount + 5 × maxDepth`), overridable per instance.
- Events posted to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer` + `X-Tenant-Id`; 3× exponential-backoff retry (1s/2s/4s) then `onError`.
- Defaults: `flushCount` 50, `flushIntervalMs` 5000.
