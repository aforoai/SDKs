# Changelog — Aforo Azure ARM Templates

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file. This IaC template lives in the `aforo-gateway-plugins` monorepo but versions independently of the metering plugins (the v2.0.0 tenant-ID IDOR security release did not touch it).

## [Unreleased]

## [2.0.0] — 2026-10-27

Wave 6 W6.3, gap G354. Not deployed to Azure yet; `node azure-arm-templates/tests/deny-policy.test.cjs` checks the structure.

### Fixed

- **The policy never denied anything.** It matched `"field": "actionType"`, which is not an Azure Policy field, with the `deny` effect, which acts on create/update requests and not on DELETE. The rule now uses the `denyAction` effect with `actionNames: ["delete"]`.
- **The template created no assignment**, so even a correct definition enforced nothing until someone ran `az policy assignment create`. It now deploys the definition and its assignment (subscription scope; schema changed to `subscriptionDeploymentTemplate`).

### Changed (breaking)

- **APIs and products are matched by name, not by tag.** `Microsoft.ApiManagement/service/apis` and `.../products` do not support ARM tags, so `tags['aforo-monetized']` could never match them (and Aforo sets no such tag; APIM's own "tags" are a different thing that Azure Policy cannot see). List the resources to protect in the `protectedResources` parameter as `<apim-service-name>/<api-or-product-id>`.
- **The APIM service itself** is protected when it carries the ARM tag `aforo-monetized=true` (parameter `protectMonetizedServices`, default true). Azure Policy does not stop a child from being deleted together with its parent, and with mode `All` does not stop a resource-group delete, so this is the guard against deleting the whole instance.
- New parameter `enforcementMode` (`Default` / `DoNotEnforce`).

### Upgrade

Redeploy with `az deployment sub create`, passing `protectedResources`. The 1.0.0 assignment, if you created one by hand with the same name, is replaced.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and a `VERSION` file.

The template predates this documentation pass:

- `aforo-monetized-deny-policy.json` — an Azure Policy definition (`aforo-deny-delete-monetized`, effect `deny`, mode `All`) that blocks delete on `Microsoft.ApiManagement/service/apis` and `.../products` tagged `aforo-monetized=true`.

This pass adds the version file and the docs; it did not change the template logic.
