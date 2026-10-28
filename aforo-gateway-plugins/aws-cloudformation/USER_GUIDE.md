# Aforo AWS CloudFormation Templates — User Guide

**Version:** 3.0.0 (not yet released) · **Updated:** 2026-10-28 · **Audience:** AWS account owners connecting Amazon API Gateway to Aforo.

## What you'll build

A role in your AWS account that Aforo can assume only with your `ExternalId`. It reads API Gateway configuration in one region and, if you allow it, installs Aforo's metering Lambda on your API Gateway access logs. Optionally, a policy that blocks deletion of monetized API Gateway resources.

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

## Step 4 — (Optional) Protect monetized resources

```bash
aws cloudformation deploy \
  --region <region> \
  --template-file aforo-monetized-deny-policy.yaml \
  --stack-name aforo-deny-delete-monetized \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AttachToRoles="deploy-role,ci-role" AttachToGroups="developers"
```

The policy denies `apigateway:DELETE` on resources tagged `aforo-monetized=true` for the roles, users and groups you list. With none listed it is created but protects nothing.

## Step 5 — Check what you granted

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
| `InsufficientCapabilitiesException` | The stack creates named IAM resources. | Add `--capabilities CAPABILITY_NAMED_IAM`. |

## What this guide does NOT cover

- The metering function itself (`aws-lambda/`).
- Service Control Policies for org-wide enforcement.
- Key and usage-plan provisioning: this role grants no API Gateway writes.
