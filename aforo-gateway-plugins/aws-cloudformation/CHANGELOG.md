# Changelog — Aforo AWS CloudFormation Templates

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file. These IaC templates live in the `aforo-gateway-plugins` monorepo but version independently of the metering plugins (the v2.0.0 tenant-ID IDOR security release did not touch them).

## [Unreleased]

- _Nothing yet._

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and a `VERSION` file.

The two templates predate this documentation pass:

- `aforo-apigateway-role.yaml` — cross-account IAM role (`aforo-apigateway-role`) for Aforo to manage Amazon API Gateway and read CloudWatch Logs, gated by `sts:AssumeRole` with an `ExternalId` for confused-deputy protection.
- `aforo-monetized-deny-policy.yaml` — managed policy (`aforo-deny-delete-monetized-apis`) denying `apigateway:DELETE` on resources tagged `aforo-monetized=true`.

This pass adds the version file and the docs; it did not change any template logic.
