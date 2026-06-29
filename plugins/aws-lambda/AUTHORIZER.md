# Aforo JWT Lambda Authorizer for AWS API Gateway

## Overview

`authorizer.js` is an AWS API Gateway **TOKEN Lambda Authorizer** that validates
RS256 JWTs issued by Aforo's OAuth token endpoint (`POST /oauth/token` on org-service).

It uses **no external npm packages** — only Node.js built-ins (`https`, `http`, `crypto`, `net`).
This keeps the deployment package tiny and eliminates supply-chain risk.

## Validation Steps

1. Decode and parse JWT header + claims
2. Fetch JWKS from `AFORO_JWKS_URI` (cached for `TOKEN_CACHE_TTL_MS` across warm invocations)
3. Verify RS256 signature using the matching `kid` key
4. Enforce `exp` (expiry with 30s clock-skew tolerance) and `iss` (issuer)
5. Check jti blocklist in Redis: `jti:blocked:{jti}` — key exists = token revoked
6. Check client-level revocation in Redis: `jti:client:{keyId}` — key exists = all tokens for this key revoked
7. Return IAM `Allow` with JWT claims as authorizer context variables

On any failure, return IAM `Deny` (never throw — that would produce HTTP 500 instead of 403).

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AFORO_JWKS_URI` | Yes | — | Full URL of Aforo's JWKS endpoint, e.g. `https://auth.smartai.com/.well-known/jwks.json` |
| `AFORO_JWT_ISSUER` | No | — | Expected `iss` claim. If unset, issuer check is skipped. |
| `REDIS_HOST` | No | — | ElastiCache host for jti/client blocklist. If unset, blocklist check is skipped (fail-open). |
| `REDIS_PORT` | No | `6379` | ElastiCache port |
| `TOKEN_CACHE_TTL_MS` | No | `3600000` | JWKS cache TTL in ms (1 hour default) |

## Deployment

### Step 1 — Package

```bash
cd aforo-gateway-plugins/aws-lambda
zip -r authorizer.zip authorizer.js
```

No `npm install` needed — zero dependencies.

### Step 2 — Create Lambda Function

```bash
aws lambda create-function \
  --function-name aforo-jwt-authorizer \
  --runtime nodejs20.x \
  --handler authorizer.handler \
  --zip-file fileb://authorizer.zip \
  --role arn:aws:iam::ACCOUNT:role/aforo-authorizer-role \
  --environment Variables="{
    AFORO_JWKS_URI=https://auth.smartai.com/.well-known/jwks.json,
    AFORO_JWT_ISSUER=https://auth.aforo.ai,
    REDIS_HOST=aforo-cache.xxxx.cache.amazonaws.com,
    REDIS_PORT=6379
  }" \
  --vpc-config SubnetIds=subnet-xxx,SecurityGroupIds=sg-xxx \
  --timeout 10 \
  --memory-size 256
```

VPC config is required to reach ElastiCache. The Lambda must be in the same VPC
and security group as your ElastiCache cluster.

### Step 3 — Create Authorizer on API Gateway

```bash
aws apigateway create-authorizer \
  --rest-api-id YOUR_API_ID \
  --name aforo-jwt-authorizer \
  --type TOKEN \
  --authorizer-uri "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:ACCOUNT:function:aforo-jwt-authorizer/invocations" \
  --identity-source "method.request.header.Authorization" \
  --authorizer-result-ttl-in-seconds 840
```

**Caching TTL recommendation**: Set to `token_expiry_seconds - 60`. For 15-minute
Aforo tokens (900s), use 840s. This avoids re-invoking the Lambda on every request
while ensuring expired tokens are caught within 1 minute.

### Step 4 — Grant API Gateway Permission to Invoke Lambda

```bash
aws lambda add-permission \
  --function-name aforo-jwt-authorizer \
  --statement-id apigateway-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:us-east-1:ACCOUNT:YOUR_API_ID/authorizers/*"
```

### Step 5 — Attach Authorizer to Methods

In the API Gateway console or via IaC: set the authorization type to `CUSTOM`
and select `aforo-jwt-authorizer` on each method (or use a resource-level default).

### Step 6 — Access Context Variables in Lambda Integration

The authorizer injects these variables into `$context.authorizer.*`:

| Variable | JWT Source | Example |
|---|---|---|
| `customerId` | `customer_id` or `sub` | `cust_abc123` |
| `tenantId` | `tenant_id` | `tenant_xyz` |
| `keyId` | `key_id` | `key_live_abc` |
| `scopes` | `scopes` | `read:usage write:events` |
| `environment` | `environment` | `live` |
| `offeringIds` | `offering_ids[]` | `["off_1","off_2"]` |
| `subscriptionIds` | `subscription_ids[]` | `["sub_1"]` |

In API Gateway mapping templates or Lambda proxy integrations:
```
$context.authorizer.tenantId
$context.authorizer.customerId
```

## IAM Role Requirements

The Lambda execution role needs:
- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` (CloudWatch)
- `ec2:CreateNetworkInterface`, `ec2:DescribeNetworkInterfaces`, `ec2:DeleteNetworkInterface` (VPC)

No AWS service permissions needed — the authorizer only calls external HTTPS
(JWKS endpoint) and ElastiCache TCP.

## Relation to the Metering Lambda (index.js)

| | `index.js` | `authorizer.js` |
|---|---|---|
| Trigger | CloudWatch Logs subscription | API Gateway TOKEN authorizer |
| Phase | Async post-response | Synchronous pre-request |
| Can block requests | No | Yes (Allow/Deny) |
| Purpose | Usage metering | JWT authentication |

Use both together: `authorizer.js` gates access, `index.js` meters usage.

## SAM / CloudFormation

See `template.yaml` in this directory — add the authorizer resource alongside
the existing Lambda function definition.
