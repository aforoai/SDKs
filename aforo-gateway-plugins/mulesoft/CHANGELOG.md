# Changelog — Aforo Metering MuleSoft Policy

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file. This artifact ships on the shared `aforo-gateway-plugins` monorepo tag — see the repo-root `CHANGELOG.md` for the cross-plugin release record.

## [Unreleased]

- _Nothing yet._

## [2.0.0] — 2026-06-29

Initial public distribution packaging for the MuleSoft policy — README, user guide, and a `VERSION` file pinned to the monorepo's 2.0.0 line.

The policy itself shipped under the monorepo's **v2.0.0 — 2026-04-23 security release** (2 CRITICAL + 2 HIGH tenant-ID IDOR findings — the highest-severity set across the five plugins). For MuleSoft specifically that release:

- `jwt-validation-config.yaml` declares `providedCharacteristics: [aforo-jwt-validated]`; `mule-policy.yaml`, `mcp-mule-policy.yaml`, `margin-guard-policy.yaml`, and `preflight-quota-policy.yaml` declare `requiredCharacteristics: [aforo-jwt-validated]`. Anypoint API Manager now enforces policy ordering — metering cannot be applied without JWT validation first.
- The metering DataWeave transformations source `customerId` from `vars.aforo.customerId` (set by JWT validation), and **emit an empty `events` array** if the authenticated identity is missing (fail-closed on billing; the upstream request still proceeds).
- `margin-guard-policy.yaml`: scope-ID + cache key from `vars.aforo.customerId`; tenant prefers the JWT-validated var, falls back to admin-pinned configuration.
- Added `tests/policy-contract.md`: 6 black-box HTTP contract tests for fork maintainers.

This documentation pass adds the version file and rewrites README + user guide to the standard structure; it did not change any policy logic.
