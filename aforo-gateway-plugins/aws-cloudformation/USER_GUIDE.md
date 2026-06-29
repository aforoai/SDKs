# Aforo AWS CloudFormation Templates — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** AWS account owners / platform engineers wiring Amazon API Gateway to Aforo.

## What you'll build

A cross-account IAM role in your AWS account that Aforo can assume (only with the `ExternalId` you were given), plus an optional managed policy that blocks deletion of monetized API Gateway resources. By the end, Aforo's integration shows "connected" and you've confirmed the trust relationship.

## Prerequisites

- An AWS account with permission to create IAM roles/policies (`CAPABILITY_NAMED_IAM`).
- The **`ExternalId`** (a UUID) from Aforo — generated when you start the API Gateway integration in the Aforo console.
- Aforo's **AWS account ID** — supplied by Aforo (or pre-filled in the console's Quick Create link).
- AWS CLI configured, or access to the CloudFormation console.

## Step 1 — Get the ExternalId from Aforo

In the Aforo console, start the AWS API Gateway integration. It produces an `ExternalId` (UUID) and either a CloudFormation **Quick Create** link (account ID pre-filled) or the raw values to pass yourself. Keep the `ExternalId` — it's the secret that binds this role to your integration.

## Step 2 — Deploy the cross-account role

```bash
aws cloudformation deploy \
  --template-file aforo-apigateway-role.yaml \
  --stack-name aforo-apigateway-role \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    ExternalId="<uuid-from-aforo>" \
    AforoAccountId="<aforo-aws-account-id>"
```

> ⚠ `ExternalId` must match `[a-f0-9-]+` (a UUID). Deploy fails the parameter constraint otherwise. And `AforoAccountId` defaults to `000000000000` — that placeholder lets nobody assume the role; pass the real Aforo account ID or the integration can't connect.

This creates the IAM role `aforo-apigateway-role` with a 1-hour max session, API Gateway management permissions, and CloudWatch Logs read.

## Step 3 — Hand the role ARN back to Aforo

```bash
aws cloudformation describe-stacks \
  --stack-name aforo-apigateway-role \
  --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" \
  --output text
# arn:aws:iam::<your-account>:role/aforo-apigateway-role
```

Paste that ARN into the Aforo console to complete the integration. Aforo will perform a test `sts:AssumeRole` with your `ExternalId`.

## Step 4 — (Optional) Protect monetized resources from deletion

```bash
aws cloudformation deploy \
  --template-file aforo-monetized-deny-policy.yaml \
  --stack-name aforo-deny-delete-monetized \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AforoAccountId="<aforo-aws-account-id>"
```

This creates the managed policy `aforo-deny-delete-monetized-apis`. It denies `apigateway:DELETE` on any resource tagged `aforo-monetized=true`.

> ⚠ Creating the policy doesn't enforce anything by itself — attach it to the IAM principals (or SCP) that must be blocked. And it only matches resources already tagged `aforo-monetized=true`; Aforo applies that tag when a product is monetized.

## Step 5 — Verify the trust relationship

Confirm the role's trust policy names Aforo's account and your `ExternalId`:

```bash
aws iam get-role --role-name aforo-apigateway-role \
  --query "Role.AssumeRolePolicyDocument" --output json
```

You should see `Principal.AWS = arn:aws:iam::<aforo-account>:root` and a `Condition.StringEquals."sts:ExternalId"` matching what you deployed. To verify the whole chain end-to-end, the Aforo console's integration status flips to connected after its test assume-role succeeds.

To revoke access at any time: `aws cloudformation delete-stack --stack-name aforo-apigateway-role`.

## Configuration reference

See the README's Configuration tables: `aforo-apigateway-role.yaml` takes `ExternalId` (required UUID) and `AforoAccountId` (default placeholder); `aforo-monetized-deny-policy.yaml` takes `AforoAccountId`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `deploy` fails on `ExternalId` constraint | The value isn't `[a-f0-9-]+` (not a UUID). | Use the UUID exactly as Aforo issued it. |
| Aforo integration won't connect after pasting the ARN | `AforoAccountId` left at `000000000000`, or the `ExternalId` in Aforo doesn't match the deployed one. | Redeploy with the real `AforoAccountId`; confirm the `ExternalId` matches Aforo's value. |
| `InsufficientCapabilitiesException` | The stack creates named IAM resources. | Add `--capabilities CAPABILITY_NAMED_IAM`. |
| Deletions of monetized APIs still succeed | The deny policy was created but not attached, or the resource isn't tagged `aforo-monetized=true`. | Attach `aforo-deny-delete-monetized-apis` to the relevant principals/SCP; confirm the tag is present. |
| Aforo can manage keys but can't read logs | The CloudWatch Logs statement is scoped to `arn:aws:logs:<region>:<account>:*`; cross-region log groups aren't covered. | Deploy the role stack in each region whose API Gateway logs Aforo needs to read. |

## What this guide does NOT cover

- **The API Gateway metering Lambda** — that's the separate `aws-lambda` plugin; these templates only grant access and protect resources.
- **SCP / Organizations setup** for org-wide deny enforcement — attaching the managed policy or translating it to an SCP is your AWS governance step.
- **Tightening the API Gateway permissions** below the template's `GET/POST/PUT/PATCH/DELETE` on `::/*`. If you scope them down, verify Aforo can still provision keys and usage plans.
