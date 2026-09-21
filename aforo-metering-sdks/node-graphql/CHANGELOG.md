# Changelog

All notable changes to `@aforo/graphql-metering` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com); this package adheres to [SemVer](https://semver.org).

## [Unreleased]

### Fixed
- **Breaking (fix):** the tenant API key is sent as `X-API-Key` instead of `Authorization: Bearer`. The ingestor parses Bearer values as JWTs and rejected every request 401 (sending both headers is also 401), so no usage was being delivered.
- Docs and examples use the real ingestor host `https://usage-ingestor.aforo.ai` (`ingest.aforo.ai` / `ingestor.aforo.ai` serve a static site, not the ingestor).
- Batches are POSTed to `<ingestorUrl>/v1/ingest/batch`. `/v1/ingest/events` is the ingestor's Apigee single-event endpoint and never accepted an `{events:[...]}` batch, so no usage was being delivered. Flushes are split into requests of at most 1000 events (the ingestor's batch limit), and each event's `idempotencyKey` is minted once and re-sent unchanged on retries.
- Events with a blank `customerId` are skipped, and ones longer than 64 characters are dropped with `onError`, since the ingestor rejects both. `gqlOperationName` is trimmed to 255 characters and `idempotencyKey` to 255 characters.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoGraphQlBilling` class: buffered, batched, retrying GraphQL operation metering.
- `aforoApolloPlugin(billing)` for Apollo Server 4; `billing.middleware()` for Express / `graphql-http` / `express-graphql`.
- AST complexity scoring via `defaultComplexityScorer` (`fieldCount + 5 × maxDepth`), overridable per instance.
- Events posted to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer` + `X-Tenant-Id`; 3× exponential-backoff retry (1s/2s/4s) then `onError`.
- Defaults: `flushCount` 50, `flushIntervalMs` 5000.
