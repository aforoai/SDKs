# Changelog — Aforo Metering Azure APIM Policy

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file. This artifact ships on the shared `aforo-gateway-plugins` monorepo tag — see the repo-root `CHANGELOG.md` for the cross-plugin release record.

## [Unreleased]

- _Nothing yet._

## [2.0.0] — 2026-06-29

Initial public distribution packaging for the Azure APIM policy — README, user guide, and a `VERSION` file pinned to the monorepo's 2.0.0 line.

The policy itself shipped under the monorepo's **v2.0.0 — 2026-04-23 security release** (tenant-ID IDOR fixes). For Azure APIM specifically that release:

- Rewrote identity sourcing in `margin-guard-policy-fragment.xml` (lines 21–22): `mgCustomerId` = JWT `customer_id`/`sub` claim → APIM subscription ID fallback; `mgTenantId` = JWT `tenant_id` claim → admin-pinned `aforo-tenant-id` Named Value. **No policy reads `X-Customer-Id` / `X-Tenant-Id` from a request.**
- Required `jwt-validation-policy.xml` to be applied in `<inbound>` before any metering / margin-guard policy.

This documentation pass adds the README + user guide + version file; it did not change any policy logic.
