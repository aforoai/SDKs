# Aforo AWS CloudFormation Templates

Two CloudFormation templates that grant Aforo cross-account access to manage Amazon API Gateway for usage metering and key provisioning, and protect monetized API Gateway resources from accidental deletion.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## When to reach for this

Reach for these when you run Amazon API Gateway and want Aforo to provision keys / usage plans / stages and read CloudWatch logs in *your* account — without handing over static credentials. The cross-account role uses `sts:AssumeRole` with an `ExternalId` (confused-deputy protection), so Aforo assumes a role you own and can revoke at any time by deleting the stack.

This is infrastructure-as-code you deploy into your own AWS account. There is no package to install and no metering code here — the actual API Gateway metering runs in the separate `aws-lambda` plugin.

| Template | What it creates |
|---|---|
| `aforo-apigateway-role.yaml` | An IAM role `aforo-apigateway-role` that Aforo's account can assume (gated by your `ExternalId`), with API Gateway management + CloudWatch Logs read permissions. |
| `aforo-monetized-deny-policy.yaml` | A managed IAM policy `aforo-deny-delete-monetized-apis` that **denies** `apigateway:DELETE` on resources tagged `aforo-monetized=true`. |

## Install

These are CloudFormation YAML templates, not a package. The repo is **not yet published** publicly; deploy the template files directly. Aforo gives you the `ExternalId` (a UUID) when you start the integration in the console.

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/aws-cloudformation
```

## Quickstart

Deploy the role with the `ExternalId` Aforo gave you (the `AforoAccountId` default is the placeholder `000000000000` — Aforo supplies the real account ID, or it's pre-filled in the console-generated Quick Create link):

```bash
aws cloudformation deploy \
  --template-file aforo-apigateway-role.yaml \
  --stack-name aforo-apigateway-role \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ExternalId="<uuid-from-aforo>" AforoAccountId="<aforo-aws-account-id>"
```

Read back the role ARN and paste it into Aforo to finish the integration:

```bash
aws cloudformation describe-stacks --stack-name aforo-apigateway-role \
  --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text
```

## Configuration

`aforo-apigateway-role.yaml` parameters:

| Parameter | Type | Default | What it does |
|---|---|---|---|
| `ExternalId` | String (`[a-f0-9-]+`, a UUID) | — (required) | The confused-deputy guard. Aforo must present this exact value in its `sts:AssumeRole` call; it's the one secret tying the role to your Aforo integration. |
| `AforoAccountId` | String | `000000000000` | Aforo's AWS account ID — the only principal allowed to assume the role. The default is a placeholder; supply the real value. |

`aforo-monetized-deny-policy.yaml` parameters:

| Parameter | Type | Default | What it does |
|---|---|---|---|
| `AforoAccountId` | String | — (required) | Aforo's AWS account ID (kept for parameter symmetry with the role stack). |

Outputs — `aforo-apigateway-role.yaml`: `RoleArn` (paste into Aforo), `ExternalId` (for verification). `aforo-monetized-deny-policy.yaml`: `PolicyArn`.

> ⚠ The role grants `apigateway:GET/POST/PUT/PATCH/DELETE` on `arn:aws:apigateway:<region>::/*` and CloudWatch Logs read + subscription-filter management. That DELETE grant is exactly why the deny-policy template exists — attach it where you want monetized resources protected.

## Walk me through it

Get the `ExternalId` from Aforo → deploy the role → paste the ARN back → optionally deploy the deny policy → verify the trust relationship: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **The metering itself.** API Gateway usage events are produced by the `aws-lambda` plugin, not these templates.
- **Applying the deny policy to principals.** The template creates the managed policy; attaching it to the roles/users that must be denied (or wiring it into an SCP) is your IAM step.
- **Tagging resources `aforo-monetized=true`.** Aforo applies that tag when a product is monetized; the deny policy only takes effect on already-tagged resources.
