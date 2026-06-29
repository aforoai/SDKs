# Changelog — aforo-metering (Apigee shared flow)

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

This bundle ships on the Aforo gateway-plugins line; the whole repo is versioned and tagged together. The version for this artifact lives in the top-level `VERSION` file (Apigee bundles have no manifest version field). Entries below are the Apigee-specific slice of each repo release (see the parent `aforo-gateway-plugins/CHANGELOG.md` for the cross-plugin picture).

## [Unreleased]

## [2.0.0] — 2026-06-29

Initial public distribution packaging for the Apigee shared flow: README, user guide, and a top-level `VERSION` file, documented against the 2.0.0 security-hardened source.

This packaging documents the Apigee slice of the **v2.0.0 security release (2026-04-23)** — tenant/customer-ID IDOR fix:

- `resources/jsc/aforo-metering.js`: removed the `request.header.X-Agent-Id` fallback. `agentId` is now sourced exclusively from the JSON-RPC payload's `params._meta.agent_id`; the header is client-settable and was a billing-attribution spoof vector.
- `resources/jsc/aforo-mcp-metering.js`: same fix for the MCP-only variant.
- `tests/unit-tests.cjs`: test harness rewritten (was broken under the ESM-module workspace root) and 2 security regression tests added; all 15 tests pass.

Closes the Apigee finding (1 MEDIUM) from the 2026-04-20 gateway-plugins IDOR advisory.

## [1.1.0] — 2026-04-16

- Bundle aligned with the repo-wide v1.1.0 release.

## [1.0.0] — 2026-04-01

- Initial release: `PostClientFlow` metering via a JavaScript policy + `ServiceCallout` send, with config read from the org-scoped `aforo-metering-config` KVM.
- Optional JWT/JWKS validation steps (`AforoJwtReadConfig` → `AforoJwtValidation` → `AforoJwtAssignHeaders`) ahead of metering.
