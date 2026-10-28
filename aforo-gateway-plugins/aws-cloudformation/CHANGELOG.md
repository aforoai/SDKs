# Changelog — Aforo AWS CloudFormation Templates

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file. These IaC templates live in the `aforo-gateway-plugins` monorepo but version independently of the metering plugins (the v2.0.0 tenant-ID IDOR security release did not touch them).

## [Unreleased]

## [3.0.0] — not yet released

Permissions shrink, so this is a major version (G345, G346, G347).

### `aforo-apigateway-role.yaml`

- **Replaced by the template organization-service hosts** for its one-click link; the two files are the same. 1.0.0 was the original full-access role.
- **API Gateway read is scoped (G345).** `apigateway:GET` only on `/restapis`, `/restapis/*`, `/apis`, `/apis/*`, `/usageplans`, `/usageplans/*`, in one region (`ApiGatewayRegion`, default the stack's region). It was `GET/POST/PUT/PATCH/DELETE` on `::/*`, which included `GET /apikeys?includeValues=true` — every API key value in the account. `GET /apikeys*` and `GET /usageplans/*/keys*` are now explicitly denied in every region.
- **No API Gateway writes.** Aforo's key provisioning does not use this role.
- **Log access is limited (G346).** No `logs:GetLogEvents`. Subscription filters only on `/aws/apigateway/*`, `API-Gateway-*` and an optional `AccessLogGroupPrefix`; cross-account log destinations denied. Before: subscription filters on every log group in the region.
- **Parameters (G347).** `ExternalId`: 32–44 letters, digits or hyphens (was `[a-f0-9-]+`, no length). `AforoAccountId`: 12 digits, default Aforo's account (was the placeholder `000000000000`, which made the role unusable).
- Optional metering install (`AllowMeteringInstall`, default `true`): Lambda functions `aforo-metering-*` and an execution role that writes only its own logs.

### `aforo-monetized-deny-policy.yaml`

- `AttachToRoles` / `AttachToUsers` / `AttachToGroups` attach the policy (it was attached to nothing). `AforoAccountId` is optional and unused. The managed policy's `Tags` (not a property CloudFormation supports on `AWS::IAM::ManagedPolicy`) are removed.

### Upgrade from 1.0.0

1. The role's logical id, name and output change: updating a 1.0.0 stack replaces the role. The new role has a generated name; read `AforoRoleArn` (was `RoleArn`) and paste it into Aforo again. Or create a new stack (`aforo-apigateway-integration`) and delete the old one after Aforo connects.
2. Pass `ApiGatewayRegion` if your APIs are not in the stack's region (`*` for all).
3. Pass `AccessLogGroupPrefix` if your access log group does not start with `/aws/apigateway/` or `API-Gateway-`.
4. Deny policy: pass `AttachToRoles` etc. to have it enforce anything.
5. Aforo issues 36-character UUIDs as ExternalIds. A shorter value fails the new constraint; start the connection again in Aforo to get a UUID.

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and a `VERSION` file.

The two templates predate this documentation pass:

- `aforo-apigateway-role.yaml` — cross-account IAM role (`aforo-apigateway-role`) for Aforo to manage Amazon API Gateway and read CloudWatch Logs, gated by `sts:AssumeRole` with an `ExternalId` for confused-deputy protection.
- `aforo-monetized-deny-policy.yaml` — managed policy (`aforo-deny-delete-monetized-apis`) denying `apigateway:DELETE` on resources tagged `aforo-monetized=true`.

This pass adds the version file and the docs; it did not change any template logic.
