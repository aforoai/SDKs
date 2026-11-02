# Aforo AWS CloudFormation Templates — User Guide

**Version:** 3.2.0 (not yet released) · **Updated:** 2026-10-28 · **Audience:** AWS account owners connecting Amazon API Gateway to Aforo.

## What you'll build

A role in your AWS account that Aforo can assume only with your `ExternalId`. It reads API Gateway configuration in one region and, if you allow it, installs Aforo's metering Lambda on your API Gateway access logs and lets Gateway Orchestration and push ingestion work without access keys. Optionally, a policy that blocks deletion of monetized API Gateway resources.

## Prerequisites

- Permission to create IAM roles and policies (`CAPABILITY_NAMED_IAM`).
- The `ExternalId` (a UUID) from Aforo, shown when you start the AWS API Gateway connection.
- AWS CLI, or the CloudFormation console.

## Step 1 — Get the ExternalId

Start the AWS API Gateway connection in Aforo. It shows the `ExternalId` and either a Quick Create link (everything filled in) or the template to upload. The Quick Create link opens in your connection's region; keep that region.

## Step 2 — Deploy the role

```bash
aws cloudformation deploy \
  --region <region> \
  --template-file aforo-apigateway-role.yaml \
  --stack-name aforo-apigateway-integration \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ExternalId="<uuid-from-aforo>"
```

Add, when they apply:

- `ApiGatewayRegion=<region>` if your APIs are not in the stack's region, or `*` for every region.
- `AccessLogGroupPrefix=<name>` if your access log group's name starts with neither `/aws/apigateway/` nor `API-Gateway-` (Aforo's default is `/aws/apigateway/aforo-access-logs`).
- `AllowMeteringInstall=false` for a read-only role; then deploy `aws-lambda/template.yaml` yourself.

> ⚠ `ExternalId` must be 32–44 letters, digits or hyphens. Use the value Aforo shows, unchanged.

## Step 3 — Give the role ARN to Aforo

```bash
aws cloudformation describe-stacks --region <region> \
  --stack-name aforo-apigateway-integration \
  --query "Stacks[0].Outputs[?OutputKey=='AforoRoleArn'].OutputValue" --output text
```

Paste it into Aforo and click Finish connecting. Aforo calls `sts:AssumeRole` with your `ExternalId` to check it.

## Step 4 — (Optional) Gateway Orchestration and push ingestion without access keys

Only when the Aforo connection has the role and no access keys. A connection with access keys keeps using them for these calls, and you can skip this step.

What `AllowGatewayOrchestration=true` adds to the role, in `ApiGatewayRegion` only:

| For | Permission |
|---|---|
| Usage plans and API keys (create, change quota/throttle/keys, enable/disable, delete) | `apigateway:POST` on `/usageplans`, `/usageplans/*/keys`, `/apikeys`; `PATCH` and `DELETE` on `/usageplans/*`, `/apikeys/*` |
| Reading the keys Aforo manages (enforcement status, key list of a plan) | `apigateway:GET` on `/apikeys/*`, `/usageplans/*/keys` — these return key values. Listing every key (`GET /apikeys`) stays denied. |
| Pull ingestion | `cloudwatch:GetMetricData` (no resource-level permissions, so `*`) |
| Push ingestion | Firehose create/describe/update/delete on `deliverystream/aforo-gateway-*`; `logs:PutSubscriptionFilter` / `DeleteSubscriptionFilter` on API Gateway log groups; `iam:PassRole` of one role to Firehose and one to CloudWatch Logs |

Usage plans and API keys can't be limited by IAM to the ones Aforo created, so the role can change any usage plan or API key in that region.

Push ingestion needs an S3 bucket in this account for records Firehose cannot deliver. Pass it, and the stack creates the two service roles:

```bash
aws cloudformation deploy \
  --region <region> \
  --template-file aforo-apigateway-role.yaml \
  --stack-name aforo-apigateway-integration \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ExternalId="<uuid-from-aforo>" \
    AllowGatewayOrchestration=true \
    FirehoseBackupBucketArn=arn:aws:s3:::<your-bucket>
```

On an existing stack, `aws cloudformation deploy` with the same stack name updates it and keeps the values of parameters you don't pass (`ExternalId`, `ApiGatewayRegion` and the rest), so the two overrides above are enough. In the console: Update stack → Use current template (or replace it with this file) → set `AllowGatewayOrchestration` to `true` and `FirehoseBackupBucketArn`.

Then copy the outputs into the Aforo connection:

| Stack output | Aforo connection field |
|---|---|
| `FirehoseRoleArn` | `firehoseRoleArn` |
| `CloudWatchLogsRoleArn` | `cloudWatchLogsRoleArn` |
| `FirehoseBackupBucketArn` | `firehoseBackupBucketArn` |

```bash
aws cloudformation describe-stacks --region <region> --stack-name aforo-apigateway-integration \
  --query "Stacks[0].Outputs[?starts_with(OutputKey,'Firehose') || OutputKey=='CloudWatchLogsRoleArn'].[OutputKey,OutputValue]" --output table
```

> ⚠ To use roles you made yourself, pass `FirehoseRoleArn=<arn>` and `CloudWatchLogsRoleArn=<arn>` and leave `FirehoseBackupBucketArn` empty (the stack refuses both). Enter the bucket ARN in Aforo yourself. Your Firehose role needs the S3 actions on the bucket; your CloudWatch Logs role needs `firehose:PutRecord` and `firehose:PutRecordBatch` on `aforo-gateway-*`.

To turn it off again, update the stack with `AllowGatewayOrchestration=false`. The role is then back to exactly what 3.1.0 grants and the two service roles are deleted; delete the Firehose stream and subscription from Aforo first, or by hand (`aforo-gateway-<id>`, filter `aforo-gateway-events`).

## Step 5 — (Optional) Protect monetized resources

```bash
aws cloudformation deploy \
  --region <region> \
  --template-file aforo-monetized-deny-policy.yaml \
  --stack-name aforo-deny-delete-monetized \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AttachToRoles="deploy-role,ci-role" AttachToGroups="developers"
```

The policy denies `apigateway:DELETE` on resources tagged `aforo-monetized=true` for the roles, users and groups you list. With none listed it is created but protects nothing.

## Step 6 — Check what you granted

```bash
ROLE=$(aws cloudformation describe-stack-resource --region <region> --stack-name aforo-apigateway-integration \
  --logical-resource-id AforoRole --query StackResourceDetail.PhysicalResourceId --output text)
aws iam get-role --role-name "$ROLE" --query Role.AssumeRolePolicyDocument
aws iam simulate-principal-policy --policy-source-arn "$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)" \
  --action-names apigateway:GET --resource-arns "arn:aws:apigateway:<region>::/apikeys"
```

The trust policy names `arn:aws:iam::082424191442:root` with your `ExternalId`; the simulation answers `explicitDeny`.

To revoke access: `aws cloudformation delete-stack --region <region> --stack-name aforo-apigateway-integration`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `deploy` fails on `ExternalId` | Not 32–44 letters, digits or hyphens. | Use the UUID Aforo shows. |
| Aforo cannot connect | `ExternalId` differs from Aforo's, or the ARN pasted is from another stack. | Compare the values; read `AforoRoleArn` again. |
| Import finds no APIs | The role is scoped to another region. | Redeploy with `ApiGatewayRegion=<your API region>`. |
| One-click metering fails on `secretsmanager:DescribeSecret` / `CreateSecret` | The stack is older than 3.1.0, which added the Secrets Manager permissions. | Update the stack with the current template (same parameters), then deploy metering again. |
| Metering Lambda logs `could not read AFORO_API_KEY_SECRET_ARN … AccessDeniedException` | The execution role predates 3.1.0, or the connection uses its own `meteringExecutionRoleArn`. | Update the stack; for your own role, allow `secretsmanager:GetSecretValue` on `aforo/metering/*`. |
| One-click metering fails on `logs:PutSubscriptionFilter` | The access log group is outside `/aws/apigateway/*` and `API-Gateway-*`. | Redeploy with `AccessLogGroupPrefix=<log group name>`. |
| Monetized APIs can still be deleted | The deny policy is not attached, or the resource is not tagged. | Pass `AttachToRoles` / `AttachToUsers` / `AttachToGroups`; check the `aforo-monetized` tag. |
| Usage plan or API key calls fail with `AccessDenied` on a role-only connection | `AllowGatewayOrchestration` is `false`, or the APIs are in another region. | Update the stack with `AllowGatewayOrchestration=true` (and `ApiGatewayRegion` if needed). |
| Push ingestion fails on `iam:PassRole` | No Firehose / CloudWatch Logs role was created or given, or the ARNs in Aforo differ from the outputs. | Pass `FirehoseBackupBucketArn` (or your own role ARNs) and copy the outputs into Aforo. |
| Update fails with `CreatedOrOwnEventRoles` | `FirehoseBackupBucketArn` and your own role ARNs were both set. | Use one: the bucket (stack creates the roles) or your two role ARNs. |
| Firehose writes nothing to the backup bucket | The bucket uses a customer-managed KMS key. | Allow the Firehose role `kms:GenerateDataKey` and `kms:Decrypt` on that key. |
| `InsufficientCapabilitiesException` | The stack creates named IAM resources. | Add `--capabilities CAPABILITY_NAMED_IAM`. |

## What this guide does NOT cover

- The metering function itself (`aws-lambda/`).
- Service Control Policies for org-wide enforcement.
- Creating the backup bucket, or KMS permissions for a bucket with a customer-managed key.
- Running Gateway Orchestration in Aforo itself; this guide covers only the AWS side.
