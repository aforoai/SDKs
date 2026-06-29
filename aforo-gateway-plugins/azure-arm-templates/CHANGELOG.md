# Changelog — Aforo Azure ARM Templates

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file. This IaC template lives in the `aforo-gateway-plugins` monorepo but versions independently of the metering plugins (the v2.0.0 tenant-ID IDOR security release did not touch it).

## [Unreleased]

- _Nothing yet._

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and a `VERSION` file.

The template predates this documentation pass:

- `aforo-monetized-deny-policy.json` — an Azure Policy definition (`aforo-deny-delete-monetized`, effect `deny`, mode `All`) that blocks delete on `Microsoft.ApiManagement/service/apis` and `.../products` tagged `aforo-monetized=true`.

This pass adds the version file and the docs; it did not change the template logic.
