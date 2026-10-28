# Aforo AWS CloudFormation Templates

Two CloudFormation templates: a cross-account role that lets Aforo read your Amazon API Gateway configuration and, if you allow it, install Aforo's metering Lambda; and a policy that blocks deletion of monetized API Gateway resources.

**Version:** 3.1.0 (not yet released) · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## When to reach for this

Use these when you run Amazon API Gateway and connect it to Aforo with a role instead of access keys. Aforo assumes a role you own, only with the `ExternalId` it gave you (confused-deputy protection), and you revoke access by deleting the stack.

`aforo-apigateway-role.yaml` is the same file organization-service hosts for the console's one-click "Connect AWS" link (`src/main/resources/cloudformation/aws-apigateway-role.yaml` there). There is no metering code here; the metering function is in `aws-lambda/`.

| Template | What it creates |
|---|---|
| `aforo-apigateway-role.yaml` | An IAM role Aforo's account can assume with your `ExternalId`. Read: API Gateway `GET` on REST APIs, HTTP APIs and usage plans in one region. Never: API key values, API Gateway writes, log reads. With `AllowMeteringInstall=true` (default): create and update Lambda functions named `aforo-metering-*`, write (not read) the Secrets Manager secrets `aforo/metering/*` that hold their Aforo API key, and subscribe them to API Gateway log groups; plus an execution role `aforo-metering-exec-<ExternalId>` that can only write its own logs and read `aforo/metering/*` secrets. |
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

Outputs: `AforoRoleArn`, and `AforoMeteringExecutionRoleArn` when `AllowMeteringInstall=true`.

`aforo-monetized-deny-policy.yaml`:

| Parameter | Default | What it does |
|---|---|---|
| `AttachToRoles` / `AttachToUsers` / `AttachToGroups` | empty | Comma-separated IAM names to attach the policy to. Empty attaches to none. |
| `AforoAccountId` | empty | Not used; kept so stacks created with it still update. Empty or 12 digits. |

Output: `PolicyArn`.

### What the role cannot do

- Read API key values: `GET /apikeys*` and `GET /usageplans/*/keys*` are explicitly denied in every region.
- Change API Gateway (no `POST` / `PUT` / `PATCH` / `DELETE`).
- Read log events, or subscribe anything to log groups outside the API Gateway prefixes. A subscription's destination is not an IAM condition key; it is limited by what the role can grant: it can add an invoke permission only to `aforo-metering-*` functions, can pass no role to CloudWatch Logs (Kinesis and Firehose destinations need one), and cross-account log destinations are denied.
- Create or change IAM roles; the only role it can pass is the metering execution role, to Lambda only.
- Read the Aforo API key back: it can create, update, describe, delete and restore `aforo/metering/*` secrets, but has no `secretsmanager:GetSecretValue`. Only the execution role reads them.

## Tests

`node aws-cloudformation/tests/templates.test.cjs` (also run by `cd aws-lambda && npm test`). It reads the template text and checks the statements above. `cfn-lint` was not run for 3.0.0 or 3.1.0.

## What this doesn't cover

- **Key and usage-plan provisioning by Aforo.** 1.0.0 granted API Gateway writes for it; Aforo's key provisioning uses access-key connections, not this role, so 3.0.0 drops them.
- **Customer-managed KMS keys.** The install's secrets use the AWS-managed `aws/secretsmanager` key. A secret you re-encrypt with your own key also needs `kms:Decrypt` on the execution role, which this template does not grant.
- **SCPs.** Translating the deny policy into a Service Control Policy is your AWS Organizations step.
- **Tagging.** The deny policy only matches resources already tagged `aforo-monetized=true`.
