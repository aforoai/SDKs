# Changelog — aforo-metering-lambda

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

This function ships on the Aforo gateway-plugins line; the whole repo is versioned and tagged together. The version lives in `package.json`. Entries below are the AWS-Lambda-specific slice of each repo release (see the parent `aforo-gateway-plugins/CHANGELOG.md` for the cross-plugin picture).

## [Unreleased]

Brings the function in line with the ingestor contract. **Breaking** for deployments: SAM parameters `AforoTenantId` and `CustomerIdSource` were removed, and the stage's access-log format must now include `customerId` from the authorizer context.

### Fixed
- `index.handler` was `undefined` at runtime: `exports.handler` was set and then `module.exports` was replaced wholesale for tests. The handler is now exported.
- Authenticates with `X-API-Key` alone (was `Authorization: Bearer`, which the ingestor never reads — and rejects 401 if present). Same fix in `preflight-quota.js` and `compound-metering.js`. `X-Tenant-Id` is no longer sent; the tenant comes from the key.
- Customer identity came from `$context.identity.apiKey` — the raw API key, a secret, sent to Aforo as `customerId` — or the CLF client IP. It now comes only from `$context.authorizer.customerId` (set by `authorizer.js` from the verified JWT). Entries without one, or with one longer than 64 chars, are skipped instead of being sent with `customerId: null` (which failed the whole batch).
- `OPTIONS` (CORS preflight) and quantity ≤ 0 (e.g. an empty 204 with `QUANTITY_SOURCE=response_size`) are no longer metered.
- The default metric was `{method} {path}` — never a catalog metric, so every batch failed 400. Added `METRIC_MAPPINGS` (EXACT/PREFIX/CONTAINS, first match wins) and `DEFAULT_METRIC` (`api_calls`); `METRIC_NAME_PATTERN` applies only when explicitly set.
- Retries: 408 and 429 are now retried; other 4xx are dropped with the response body logged. Batches are sent concurrently under one deadline taken from `context.getRemainingTimeInMillis()`, so retries cannot run past the Lambda timeout or starve later batches. A batch that still fails transiently makes the handler throw so Lambda's async retry re-delivers it (idempotency keys dedupe).
- `compound-metering.js` required `uuid`, which is not a dependency — now `crypto.randomUUID()`. Its default compound URL is built from the endpoint's origin instead of appended to the batch URL.
- MCP idempotency key no longer embeds the tenant id or timestamp (`mcp:{requestId}:{tool}`).

### Tests
- Handler-level tests against a local capture server: `X-API-Key` only, no `Authorization`/`X-Tenant-Id`, OPTIONS/no-customer/oversize-customer skipped, API key never in payload, 400 dropped without retry, 429 retried, 5xx throws, deadline respected, zero quantity skipped, metric mapping resolution.

## [2.0.0] — 2026-06-29

Initial public distribution packaging for the AWS Lambda metering function: README, user guide, and versioning, documented against the 2.0.0 source.

This packaging documents the AWS slice of the **v2.0.0 security release (2026-04-23)**. The Lambda had no exploitable IDOR finding — it sources customer identity from API Gateway's verified `$context.identity.apiKey` / `.caller`, never a request header. The 2.0.0 work was hardening hygiene to prevent re-introduction of a header-based source:

- `index.js`: documented that `CUSTOMER_ID_SOURCE='header'` is no longer accepted; the legacy branch was dead code and is now explicitly called out. Only `'consumer'` resolves an identity; any other value drops through with `customerId=null` (the ingestor then rejects on schema validation).
- `template.yaml`: the `CustomerIdSource` CloudFormation parameter's allowed values narrowed to `[consumer]` (was `[consumer, header]`).
- `package.json`: bumped to `2.0.0`.
- All 14 existing tests still pass.

## [1.1.0] — 2026-04-16

- Lambda authorizer (separate `authorizer.js`): response-body TCP accumulation + negative JWKS caching (commit `d00dd86`).

## [1.0.0] — 2026-04-01

- Initial release: CloudWatch Logs subscriber that parses API Gateway access-log entries (JSON, with a CLF fallback), batches usage events (default 50), and POSTs them to the Aforo ingestor with 3x exponential-backoff retry.
- JWT/JWKS validation shipped in the companion Lambda authorizer.
