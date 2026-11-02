# Aforo AWS CloudFormation Templates

Two CloudFormation templates: a cross-account role that lets Aforo read your Amazon API Gateway configuration and, if you allow it, install Aforo's metering Lambda and run Gateway Orchestration and push ingestion; and a policy that blocks deletion of monetized API Gateway resources.

**Version:** 3.2.0 (not yet released) · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## When to reach for this

Use these when you run Amazon API Gateway and connect it to Aforo with a role instead of access keys. Aforo assumes a role you own, only with the `ExternalId` it gave you (confused-deputy protection), and you revoke access by deleting the stack.

`aforo-apigateway-role.yaml` is the same file organization-service hosts for the console's one-click "Connect AWS" link (`src/main/resources/cloudformation/aws-apigateway-role.yaml` there). There is no metering code here; the metering function is in `aws-lambda/`.

| Template | What it creates |
|---|---|
| `aforo-apigateway-role.yaml` | An IAM role Aforo's account can assume with your `ExternalId`. Read: API Gateway `GET` on REST APIs, HTTP APIs and usage plans in one region. Never: API key values, API Gateway writes, log reads. With `AllowMeteringInstall=true` (default): create and update Lambda functions named `aforo-metering-*`, write (not read) the Secrets Manager secrets `aforo/metering/*` that hold their Aforo API key, and subscribe them to API Gateway log groups; plus an execution role `aforo-metering-exec-<ExternalId>` that can only write its own logs and read `aforo/metering/*` secrets. With `AllowGatewayOrchestration=true` (default `false`): manage usage plans and API keys, read API Gateway CloudWatch metrics, create Firehose streams `aforo-gateway-*` fed from API Gateway log groups, and (with `FirehoseBackupBucketArn`) the two service roles that push ingestion needs. |
| `aforo-monetized-deny-policy.yaml` | A managed policy `aforo-deny-delete-monetized-apis` that denies `apigateway:DELETE` on resources tagged `aforo-monetized=true`, optionally attached to the roles, users and groups you name. |

## Install

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/aws-cloudformation
```

## Quickstart

Deploy in the region your API Gateway runs in, with the `ExternalId` Aforo gave you:

```bash
aws cloudformation deploy \
  --region <region> \
  --template-file aforo-apigateway-role.yaml \
  --stack-name aforo-apigateway-integration \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ExternalId="<uuid-from-aforo>"
```

Read the role ARN and paste it into Aforo:

```bash
aws cloudformation describe-stacks --region <region> --stack-name aforo-apigateway-integration \
  --query "Stacks[0].Outputs[?OutputKey=='AforoRoleArn'].OutputValue" --output text
```

## Configuration

`aforo-apigateway-role.yaml`:

| Parameter | Default | What it does |
|---|---|---|
| `ExternalId` | — (required) | 32–44 letters, digits or hyphens (Aforo issues a UUID). Aforo must present it in `sts:AssumeRole`. |
| `AforoAccountId` | `082424191442` | Aforo's AWS account, the only principal that can assume the role. 12 digits. |
| `ApiGatewayRegion` | empty | Region Aforo may read and install the metering Lambda in. Empty = this stack's region; `*` = every region. |
| `AccessLogGroupPrefix` | empty | Only when your access logs go to a log group whose name starts with neither `/aws/apigateway/` nor `API-Gateway-`: that name or a prefix of it. |
| `AllowMeteringInstall` | `true` | `false` keeps the role read-only; you then deploy the metering Lambda yourself (`aws-lambda/template.yaml`). |
| `AllowGatewayOrchestration` | `false` | `true` lets a connection with no access keys use Gateway Orchestration (usage plans, API keys), pull CloudWatch metrics and push ingestion. `false` grants exactly what 3.1.0 granted. |
| `FirehoseBackupBucketArn` | empty | With `AllowGatewayOrchestration=true`: an existing S3 bucket (`arn:aws:s3:::<bucket>`) for records Firehose cannot deliver. The stack then creates the Firehose and CloudWatch Logs service roles and outputs their ARNs. |
| `FirehoseRoleArn` / `CloudWatchLogsRoleArn` | empty | Only to use your own service roles instead (leave `FirehoseBackupBucketArn` empty; setting both is refused). The Aforo role may pass each one to its service only. |

Outputs: `AforoRoleArn`; `AforoMeteringExecutionRoleArn` when `AllowMeteringInstall=true`; `FirehoseRoleArn`, `CloudWatchLogsRoleArn` and `FirehoseBackupBucketArn` when the stack creates the push-ingestion roles. Each of the last three goes into the Aforo connection field of the same name (`firehoseRoleArn`, `cloudWatchLogsRoleArn`, `firehoseBackupBucketArn`).

`aforo-monetized-deny-policy.yaml`:

| Parameter | Default | What it does |
|---|---|---|
| `AttachToRoles` / `AttachToUsers` / `AttachToGroups` | empty | Comma-separated IAM names to attach the policy to. Empty attaches to none. |
| `AforoAccountId` | empty | Not used; kept so stacks created with it still update. Empty or 12 digits. |

Output: `PolicyArn`.

### What the role cannot do

- Read API key values: `GET /apikeys*` and `GET /usageplans/*/keys*` are explicitly denied in every region. With `AllowGatewayOrchestration=true`, `GET /apikeys/{id}` and `GET /usageplans/{id}/keys` are allowed (Gateway Orchestration creates keys and reads the ones it manages); listing every key (`GET /apikeys`, `includeValues=true`) and `GET /usageplans/*/keys/*` stay denied.
- Change API Gateway (no `POST` / `PUT` / `PATCH` / `DELETE`) — unless `AllowGatewayOrchestration=true`, and then only usage plans and API keys: no `PUT` anywhere, no change to REST or HTTP APIs, stages, deployments or authorizers. Usage-plan and API-key writes are not limited to resources Aforo created; API Gateway's IAM model has no condition that would.
- Read log events, or subscribe anything to log groups outside the API Gateway prefixes. A subscription's destination is not an IAM condition key; it is limited by what the role can grant: it can add an invoke permission only to `aforo-metering-*` functions, can pass no role to CloudWatch Logs unless `AllowGatewayOrchestration=true` (then only the one role for `aforo-gateway-*` streams), and cross-account log destinations are denied.
- Create or change IAM roles; the roles it can pass are the metering execution role (to Lambda) and, with `AllowGatewayOrchestration=true`, the push-ingestion Firehose role (to Firehose) and CloudWatch Logs role (to CloudWatch Logs).
- Touch Firehose streams not named `aforo-gateway-*`, or put records into any stream itself.
- Read the Aforo API key back: it can create, update, describe, delete and restore `aforo/metering/*` secrets, but has no `secretsmanager:GetSecretValue`. Only the execution role reads them.

## Tests

`node aws-cloudformation/tests/templates.test.cjs` (also run by `cd aws-lambda && npm test`). It reads the template text, and resolves the role template for given parameters (`tests/cfn.cjs`, no npm packages) to check that `AllowGatewayOrchestration=false` grants exactly what 3.1.0 granted, that every call organization-service's AWS adapters make is allowed with `true`, and that the calls listed above stay refused. `cfn-lint` 1.58.0 passes on 3.2.0 (it was not run for 3.0.0 or 3.1.0). None of this has run in a live AWS account.

## What this doesn't cover

- **Key and usage-plan provisioning by default.** 1.0.0 granted API Gateway writes for it; 3.0.0 dropped them. A connection with access keys uses those; a role-only connection needs `AllowGatewayOrchestration=true` (3.2.0).
- **The backup bucket.** The stack does not create it. A bucket encrypted with a customer-managed KMS key also needs `kms:GenerateDataKey` / `kms:Decrypt` for the Firehose role, which this template does not grant.
- **Customer-managed KMS keys.** The install's secrets use the AWS-managed `aws/secretsmanager` key. A secret you re-encrypt with your own key also needs `kms:Decrypt` on the execution role, which this template does not grant.
- **SCPs.** Translating the deny policy into a Service Control Policy is your AWS Organizations step.
- **Tagging.** The deny policy only matches resources already tagged `aforo-monetized=true`.
