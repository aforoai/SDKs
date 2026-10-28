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
| `AFORO_TENANT_KEY_SECRET_ARN` | — | **Required for customer keys.** ARN of the Secrets Manager secret holding your Aforo tenant key (`usage:ingest`), plain text or JSON `{"apiKey":"…"}`. Read on the first cache miss and refreshed every 5 minutes; if it cannot be read the call is denied (500). The role needs `secretsmanager:GetSecretValue` on that ARN (the SAM template grants it). |
| `AFORO_TENANT_KEY` | — | The same key as a plain environment variable, used only when `AFORO_TENANT_KEY_SECRET_ARN` is unset. Anyone who can read the function's configuration can read it; use the secret. |
| `AFORO_INTROSPECT_URL` | `https://api.aforo.ai/api/v1/customer-keys/introspect` | |
| `CACHE_TTL_MS` | `60000` | Per-container answer cache. A revoked key stops working after this plus the API Gateway result TTL. |
| `INTROSPECT_TIMEOUT_MS` | `3000` | |

```bash
aws secretsmanager create-secret --name aforo/tenant-key --secret-string "<your sk_live tenant key>"

# aws-secret.js is required by key-authorizer.js.
zip key-authorizer.zip key-authorizer.js aws-secret.js

aws lambda create-function \
  --function-name aforo-key-authorizer \
  --runtime nodejs24.x \
  --handler key-authorizer.handler \
  --zip-file fileb://key-authorizer.zip \
  --role arn:aws:iam::<ACCOUNT_ID>:role/<LAMBDA_BASIC_EXECUTION_ROLE> \
  --timeout 10 \
  --architectures arm64 \
  --environment "Variables={AFORO_TENANT_KEY_SECRET_ARN=<secret ARN from create-secret>}"

# Let the function read that one secret.
aws iam put-role-policy \
  --role-name <LAMBDA_BASIC_EXECUTION_ROLE> \
  --policy-name aforo-tenant-key \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"<secret ARN>"}]}'

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
- `iss` must equal `AFORO_JWT_ISSUER` (`https://auth.aforo.ai`) and `tenant_id` must equal `AFORO_TENANT_ID`. **`AFORO_TENANT_ID` is required for this path: when it is unset, every JWT gets 401.** The tenant key is not needed for JWTs.
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

It uses **no external npm packages** — only Node.js built-ins (`https`, `http`, `crypto`, `net`, `tls`) and `aws-secret.js` from this folder.
This keeps the deployment package tiny and eliminates supply-chain risk.

## Validation Steps

1. Decode and parse JWT header + claims
2. Fetch JWKS from `AFORO_JWKS_URI` (cached for `TOKEN_CACHE_TTL_MS` across warm invocations)
3. Verify RS256 signature using the matching `kid` key
4. Enforce `exp` (expiry with 30s clock-skew tolerance), `iss` (issuer, default `https://auth.aforo.ai`) and `tenant_id` == `AFORO_TENANT_ID`
5. Check jti blocklist in Redis: `jti:blocked:{jti}` — key exists = token revoked
6. Check client-level revocation in Redis: `jti:client:{keyId}` — key exists = all tokens for this key revoked
7. Return IAM `Allow` for the called method's stage (`arn:…:<apiId>/<stage>/*`) with JWT claims as authorizer context variables

On any failure, return IAM `Deny` for the called method (never throw — that would produce HTTP 500 instead of 403).

Steps 5 and 6 are one Redis round trip (`AUTH` when configured, then two `GET`s), over TLS by default. **They fail closed:** a timeout, a TLS or connection error, an error reply such as `-NOAUTH` or `-WRONGPASS`, or any reply that is not a bulk string or nil denies the token with `error: REVOCATION_CHECK_FAILED` and logs the reason. Before 2.5.0 every one of these was read as "not revoked".

**The token must belong to your workspace.** Organization-service signs every tenant's tokens with the same key, so a valid signature does not say whose token it is. A token whose `tenant_id` claim is not `AFORO_TENANT_ID` (or has none) is denied with `error: TENANT_MISMATCH` and a `TENANT_MISMATCH` log line — the same rule as `key-authorizer.js` and the Kong plugin. When `AFORO_TENANT_ID` is unset or blank, every request is denied with `error: TENANT_NOT_CONFIGURED` and an error log; nothing is allowed. The `tenantId` passed downstream is always `AFORO_TENANT_ID`, never read from the token. Before 2.5.0 any Aforo workspace's token was allowed and its own `tenant_id` passed on.

The issuer check is always on: `iss` must equal `AFORO_JWT_ISSUER` (default `https://auth.aforo.ai`). Only `AFORO_JWT_ISSUER_CHECK_DISABLED=true` turns it off (logged once per container). Before 2.5.0 an unset `AFORO_JWT_ISSUER` skipped the check.

An unknown `kid` refetches the JWKS at most once per 30 s. If that refetch fails, the previous key set stays in use.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AFORO_JWKS_URI` | Yes | — | Full URL of Aforo's JWKS endpoint, e.g. `https://auth.smartai.com/.well-known/jwks.json` |
| `AFORO_TENANT_ID` | **Yes** | — | Your Aforo workspace (tenant) id. A token whose `tenant_id` differs is denied (`TENANT_MISMATCH`). Unset → every request denied (`TENANT_NOT_CONFIGURED`). |
| `AFORO_JWT_ISSUER` | No | `https://auth.aforo.ai` | Required `iss` claim. |
| `AFORO_JWT_ISSUER_CHECK_DISABLED` | No | — | `true` skips the issuer check (logged). Any other value keeps it. |
| `REDIS_HOST` | No | — | ElastiCache host for the jti/client blocklist. If unset, revocation is not checked (logged once per container). |
| `REDIS_PORT` | No | `6379` | ElastiCache port |
| `REDIS_TLS` | No | `true` | `false` connects without TLS; only for a local Redis without in-transit encryption (logged). |
| `REDIS_TLS_SERVERNAME` | No | `REDIS_HOST` | TLS server name, when it differs from the host (for example a private DNS alias). |
| `REDIS_TLS_CA_FILE` | No | — | PEM file with the CA that signed the Redis certificate, for a self-managed Redis. ElastiCache certificates are trusted by default. |
| `REDIS_AUTH_SECRET_ARN` | No | — | Secrets Manager secret holding the Redis AUTH token (plain text). Required when the cluster has AUTH or RBAC on. |
| `REDIS_AUTH_TOKEN` | No | — | Plain-variable fallback for the AUTH token when no secret ARN is set (logged as a warning). |
| `REDIS_USERNAME` | No | — | ACL user name (ElastiCache RBAC); sends `AUTH <user> <token>`. |
| `REDIS_TIMEOUT_MS` | No | `1000` | Deadline for connect, TLS handshake and replies. Past it the token is denied. |
| `TOKEN_CACHE_TTL_MS` | No | `3600000` | JWKS cache TTL in ms (1 hour default) |

## Deployment

### Step 1 — Package

```bash
cd aforo-gateway-plugins/aws-lambda
zip -r authorizer.zip authorizer.js aws-secret.js
```

No `npm install` needed — zero dependencies.

### Step 2 — Create Lambda Function

```bash
aws lambda create-function \
  --function-name aforo-jwt-authorizer \
  --runtime nodejs24.x \
  --handler authorizer.handler \
  --zip-file fileb://authorizer.zip \
  --role arn:aws:iam::ACCOUNT:role/aforo-authorizer-role \
  --environment Variables="{
    AFORO_JWKS_URI=https://auth.smartai.com/.well-known/jwks.json,
    AFORO_TENANT_ID=YOUR_AFORO_WORKSPACE_ID,
    AFORO_JWT_ISSUER=https://auth.aforo.ai,
    REDIS_HOST=master.aforo-cache.xxxx.use1.cache.amazonaws.com,
    REDIS_PORT=6379,
    REDIS_AUTH_SECRET_ARN=arn:aws:secretsmanager:us-east-1:ACCOUNT:secret:aforo/redis-auth-AbCdEf
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
  --authorizer-result-ttl-in-seconds 60
```

**Caching TTL**: 60 s or less. API Gateway reuses a cached Allow without calling
the authorizer, so a token revoked in Redis keeps working until its cached result
expires. Before 2.5.0 this page recommended 840 s (14 minutes). The cached Allow
covers one stage of one API; set the TTL to 0 if you need every call checked.

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
| `tenantId` | `AFORO_TENANT_ID` (the token's `tenant_id` must equal it) | `tenant_xyz` |
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
- `secretsmanager:GetSecretValue` on the `REDIS_AUTH_SECRET_ARN` secret only, when set (plus `kms:Decrypt` if the secret uses your own KMS key). The secret is read on first use and refreshed every 5 minutes. Until the first read succeeds, a failed read makes later calls fail fast (denied) for 5 s, doubling up to 60 s, instead of every request waiting on Secrets Manager.

The authorizer calls the JWKS endpoint over HTTPS, Secrets Manager, and ElastiCache over TLS. The VPC needs a route to Secrets Manager (a VPC endpoint or a NAT gateway) when `REDIS_AUTH_SECRET_ARN` is set.

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
