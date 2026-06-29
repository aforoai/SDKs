# Changelog — aforo-metering-lambda

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

This function ships on the Aforo gateway-plugins line; the whole repo is versioned and tagged together. The version lives in `package.json`. Entries below are the AWS-Lambda-specific slice of each repo release (see the parent `aforo-gateway-plugins/CHANGELOG.md` for the cross-plugin picture).

## [Unreleased]

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
