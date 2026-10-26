# Aforo Lambda Authorizers for AWS API Gateway

Two authorizers ship here. Both set `$context.authorizer.customerId`, which the metering Lambda (`index.js`) reads from the access log. Pick the one that matches what your customers send:

| | `key-authorizer.js` | `authorizer.js` |
|---|---|---|
| Customer sends | The Aforo key issued when they subscribed: `Authorization: Bearer sk_live_…`, **or** (AI agents, MCP clients) an Aforo client-credential JWT | An Aforo JWT from `POST /oauth/token` (client credentials) |
| Checked by | Keys: Aforo, per new key: `POST /api/v1/customer-keys/introspect` with your tenant key. JWTs: locally, RS256 against Aforo's JWKS, `iss` and `tenant_id` pinned | Locally, RS256 against Aforo's JWKS |
| Rejects | Unknown, revoked or expired keys; keys of another tenant; keys with no ACTIVE subscription | Bad signature, expired, revoked `jti` |
| Context | `customerId`, `keyId`, `subscriptionId`, `productType`, `authType`; JWTs add `subscriptionIds`, `agentId` | `customerId`, `tenantId`, `keyId`, `scopes`, … |

## Customer-key authorizer (`key-authorizer.js`)

A TOKEN authorizer. For a key it has not seen within `CACHE_TTL_MS`, it asks Aforo who owns it, authenticating with **your** tenant key (scope `usage:ingest`). Aforo answers `active: true` only for a key of your tenant that is not revoked or expired and is bound to an ACTIVE subscription; anything else gets 401. If Aforo cannot be reached the call is denied (500) and the failure is not cached. The customer key is never logged. No npm dependencies.

| Variable | Default | |
|---|---|---|
| `AFORO_TENANT_KEY` | — | **Required.** Your Aforo tenant key (`usage:ingest`). Keep it in an encrypted environment variable or Secrets Manager. |
| `AFORO_INTROSPECT_URL` | `https://api.aforo.ai/api/v1/customer-keys/introspect` | |
| `CACHE_TTL_MS` | `60000` | Per-container answer cache. A revoked key stops working after this plus the API Gateway result TTL. |
| `INTROSPECT_TIMEOUT_MS` | `3000` | |

```bash
zip key-authorizer.zip key-authorizer.js

aws lambda create-function \
  --function-name aforo-key-authorizer \
  --runtime nodejs20.x \
  --handler key-authorizer.handler \
  --zip-file fileb://key-authorizer.zip \
  --role arn:aws:iam::<ACCOUNT_ID>:role/<LAMBDA_BASIC_EXECUTION_ROLE> \
  --timeout 10 \
  --environment "Variables={AFORO_TENANT_KEY=<your sk_live tenant key>}"

aws apigateway create-authorizer \
  --rest-api-id <API_ID> \
  --name aforo-customer-key \
  --type TOKEN \
  --identity-source method.request.header.Authorization \
  --authorizer-uri "arn:aws:apigateway:<REGION>:lambda:path/2015-03-31/functions/arn:aws:lambda:<REGION>:<ACCOUNT_ID>:function:aforo-key-authorizer/invocations" \
  --authorizer-result-ttl-in-seconds 300

aws lambda add-permission \
  --function-name aforo-key-authorizer \
  --statement-id apigateway-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:<REGION>:<ACCOUNT_ID>:<API_ID>/authorizers/<AUTHORIZER_ID>"
```

Then set each metered method's authorization to `CUSTOM` with this authorizer, add `"subscriptionId":"$context.authorizer.subscriptionId"` to the stage's access-log format (see [README.md](README.md#access-log-format)), and redeploy the stage.

### Client-credential JWTs (AI Agent and MCP Server customers)

Agents and MCP clients usually authenticate with OAuth 2.0 client credentials instead of a static key:

```bash
curl -s -X POST https://org.aforo.ai/oauth/token \
  -d grant_type=client_credentials -d client_id=<client_id> -d client_secret=<client_secret>
# {"access_token":"eyJ…","token_type":"Bearer","expires_in":900,…}
```

The same `key-authorizer.js` accepts that token (`Authorization: Bearer eyJ…`). A bearer value shaped like a JWT (three base64url parts) is verified locally, without calling Aforo per request:

- `alg` must be `RS256` (`none`, `HS*` and everything else → 401), with a `kid` found in the JWKS at `AFORO_JWKS_URL`. The JWKS is cached for `JWKS_CACHE_TTL_MS` (1 h) and refetched once for an unknown `kid` (at most once a minute), so key rotation is picked up.
- `exp` must not have passed, `nbf` must have been reached and `iat` must not be in the future (each with `JWT_CLOCK_SKEW_SECONDS`, default 30 s).
- `iss` must equal `AFORO_JWT_ISSUER` (`https://auth.aforo.ai`) and `tenant_id` must equal `AFORO_TENANT_ID`. **`AFORO_TENANT_ID` is required for this path: when it is unset, every JWT gets 401.** `AFORO_TENANT_KEY` is not needed for JWTs.
- The JWKS cannot be fetched → 500 (fails closed), not cached.
- Tokens are never logged. A verified token's answer is cached by its SHA-256 until `min(exp, CACHE_TTL_MS)`.

| JWT claim | Context key | Notes |
|---|---|---|
| `customer_id` (else `sub`) | `customerId` | Also the `principalId`. |
| `key_id` | `keyId` | |
| `subscription_ids` | `subscriptionId` | Only when the token lists exactly one subscription; otherwise `""`. |
| `subscription_ids` | `subscriptionIds` | Comma-joined, whole ids only, up to 1000 characters. |
| `agent_id` | `agentId` | `""` when the token has none. The only trusted source of an `AI_AGENT` agent id. |
| — | `authType` | `jwt` (customer keys: `key`). |

Revocation of an individual `jti` is not checked here (Aforo's tokens live 15 minutes); revoke the client to stop new tokens being minted.

| Variable | Default | |
|---|---|---|
| `AFORO_TENANT_ID` | — | **Required for JWTs.** Your Aforo tenant id. |
| `AFORO_JWKS_URL` | `https://org.aforo.ai/.well-known/jwks.json` | |
| `AFORO_JWT_ISSUER` | `https://auth.aforo.ai` | |
| `JWKS_CACHE_TTL_MS` | `3600000` | |
| `JWKS_TIMEOUT_MS` | `3000` | |
| `JWT_CLOCK_SKEW_SECONDS` | `30` | |

To meter these customers' calls, put [`metering-proxy.js`](USER_GUIDE.md#ai-agent-and-mcp-server-metering-proxy) behind the authorizer as the method's Lambda proxy integration; it copies `agentId` from this context into each usage record.

## JWT authorizer (`authorizer.js`)

### Overview

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

`template.yaml` deploys the metering function only. Add an authorizer as an
`AWS::Serverless::Function` plus an `AWS::ApiGateway::Authorizer` on your API,
mirroring the CLI steps above.
