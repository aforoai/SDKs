# Changelog — Aforo AWS CloudFormation Templates

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in the `VERSION` file. These IaC templates live in the `aforo-gateway-plugins` monorepo but version independently of the metering plugins (the v2.0.0 tenant-ID IDOR security release did not touch them).

## [Unreleased]

## [3.2.0] — not yet released

### `aforo-apigateway-role.yaml`

- **Opt-in Gateway Orchestration and push ingestion for role-only connections.** New parameter `AllowGatewayOrchestration` (default `false`). With `false` the template grants exactly what 3.1.0 granted, for every parameter combination (`tests/templates.test.cjs` resolves both templates and compares them; the 3.1.0 file is kept as `tests/fixtures/aforo-apigateway-role-3.1.0.yaml`). With `true` the Aforo role gets one more policy, `AforoGatewayOrchestration`, with only the calls organization-service's `AwsApiGatewayProvisioningAdapter`, `AwsApiGatewayEnforcementAdapter` and `AwsApiGatewayEventAdapter` make, in `ApiGatewayRegion`:
  - `apigateway:POST` on `/usageplans`, `/usageplans/*/keys`, `/apikeys` (CreateUsagePlan, CreateUsagePlanKey, CreateApiKey);
  - `apigateway:PATCH` and `apigateway:DELETE` on `/usageplans/*`, `/apikeys/*` (UpdateUsagePlan, UpdateApiKey, DeleteUsagePlan, DeleteApiKey);
  - `apigateway:GET` on `/apikeys/*` and `/usageplans/*/keys` (GetApiKey for enforcement status, GetUsagePlanKeys) — these return key values, so `NeverReadApiKeys` stops denying these two paths under the opt-in. `GET /apikeys` (every key, `includeValues=true`) and `GET /usageplans/*/keys/*` stay denied in every region;
  - `cloudwatch:GetMetricData` on `*` (it has no resource-level permissions);
  - `firehose:CreateDeliveryStream`, `DescribeDeliveryStream`, `UpdateDestination`, `DeleteDeliveryStream` on `deliverystream/aforo-gateway-*`;
  - `logs:PutSubscriptionFilter`, `DeleteSubscriptionFilter` on the API Gateway log groups (`/aws/apigateway/*`, `API-Gateway-*`, `AccessLogGroupPrefix`);
  - `iam:PassRole` of one role to `firehose.amazonaws.com` and one to `logs.amazonaws.com` (`iam:PassedToService`), and only when that role exists.
- **Push ingestion's two service roles.** `FirehoseBackupBucketArn` (an existing bucket) makes the stack create `AforoFirehoseDeliveryRole` (trusted by Firehose with `sts:ExternalId` = this account; the six S3 actions Firehose needs, on that bucket only) and `AforoLogsToFirehoseRole` (trusted by CloudWatch Logs with `aws:SourceArn` in this account and region; `firehose:PutRecord` / `PutRecordBatch` on `aforo-gateway-*`), and output `FirehoseRoleArn`, `CloudWatchLogsRoleArn` and `FirehoseBackupBucketArn` for the Aforo connection. To use your own roles instead, pass `FirehoseRoleArn` and `CloudWatchLogsRoleArn` and leave the bucket empty; a stack rule refuses both at once.
- Tests resolve the template for given parameters (`tests/cfn.cjs`, no npm packages) and check every adapter call against the resulting policies, plus the calls that must stay refused. `cfn-lint` 1.58.0 passes.

### Upgrade from 3.1.0

1. Nothing changes unless you set `AllowGatewayOrchestration=true`; updating with the same parameters leaves the role's permissions as they were.
2. To turn it on: update the stack with `AllowGatewayOrchestration=true` and, for push ingestion, `FirehoseBackupBucketArn=<bucket ARN>` (see `USER_GUIDE.md`), then copy the three outputs into the Aforo connection.
3. A connection that has access keys keeps using them for these calls; the opt-in matters only for a role-only connection.

## [3.1.0] — not yet released

### `aforo-apigateway-role.yaml`

- **The one-click metering install keeps the Aforo API key in Secrets Manager.** With `AllowMeteringInstall=true`, the Aforo role may `CreateSecret`, `PutSecretValue`, `DescribeSecret`, `DeleteSecret`, `RestoreSecret` and `TagResource` on `secretsmanager:…:secret:aforo/metering/*` in the metering region (statement `MeteringApiKeySecret`); it cannot read a secret back. The execution role `aforo-metering-exec-<ExternalId>` gets `secretsmanager:GetSecretValue` on the same prefix (policy `AforoMeteringApiKeySecret`). organization-service's installer now writes `aforo/metering/<function>` and passes only its ARN (`AFORO_API_KEY_SECRET_ARN`, aws-lambda 2.4.0+); before, the key was a plain `AFORO_API_KEY` environment variable anyone with `lambda:GetFunctionConfiguration` could read.

### Upgrade from 3.0.0

1. Update the stack with this template, same parameters. Until you do, a one-click deploy stops at `secretsmanager:DescribeSecret` and leaves an installed function as it was.
2. Deploy metering again from Aforo. That stores the key in Secrets Manager and removes `AFORO_API_KEY` from the function. Removing metering schedules the secret for deletion with a 7-day recovery window.
3. If the connection sets its own `meteringExecutionRoleArn`, allow that role `secretsmanager:GetSecretValue` on `arn:<partition>:secretsmanager:<region>:<account>:secret:aforo/metering/*` first.

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
