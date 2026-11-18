# Aforo Lambda Authorizers for AWS API Gateway

Two authorizers ship here. Both set `$context.authorizer.customerId`, which the metering Lambda (`index.js`) reads from the access log. Pick the one that matches what your customers send:

| | `key-authorizer.js` | `authorizer.js` |
|---|---|---|
| Customer sends | The Aforo key issued when they subscribed: `Authorization: Bearer sk_live_…`, **or** (AI agents, MCP clients) an Aforo client-credential JWT | An Aforo JWT from `POST /oauth/token` (client credentials) |
| Checked by | Keys: Aforo, per new key: `POST /api/v1/customer-keys/introspect` with your tenant key. JWTs: locally, RS256 against Aforo's JWKS, `iss` and `tenant_id` pinned | Locally, RS256 against Aforo's JWKS |
| Rejects | Unknown, revoked or expired keys; keys of another tenant; keys with no ACTIVE subscription | Bad signature, expired, revoked `jti`, another workspace's token; optionally a wrong `aud` and a missing scope for the called route |
| Scopes per route | Not checked: any accepted key or JWT can call every route on the stage | `AFORO_ROUTE_SCOPES` (2.6.0) |
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

**Not checked here: scopes and `aud`.** `key-authorizer.js` has no route → scope map and returns a stage-wide Allow, so a key or JWT it accepts can call every route on the stage; it does not read the `scopes` or `aud` claims. If routes need different scopes, use `authorizer.js` with [`AFORO_ROUTE_SCOPES`](#scopes-per-route-aforo_route_scopes) for JWT callers. Bringing the same check to `key-authorizer.js` is open work (customer keys carry no scopes today, so it needs a decision on where a key's scopes come from).

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
4. Enforce `exp` (expiry with 30s clock-skew tolerance), `iss` (issuer, default `https://auth.aforo.ai`), `aud` when `AFORO_JWT_AUDIENCE` is set, and `tenant_id` == `AFORO_TENANT_ID`
5. Check jti blocklist in Redis: `jti:blocked:{jti}` — key exists = token revoked
6. Check client-level revocation in Redis: `jti:client:{keyId}` — key exists = all tokens for this key revoked
7. When `AFORO_ROUTE_SCOPES` is set: the token must hold every scope the called method and path need
8. Return IAM `Allow` with JWT claims as authorizer context variables. Without `AFORO_ROUTE_SCOPES` the Allow covers the called method's stage (`arn:…:<apiId>/<stage>/*`); with it, the called method ARN only

On any failure, return IAM `Deny` for the called method (never throw — that would produce HTTP 500 instead of 403).

Steps 5 and 6 are one Redis round trip (`AUTH` when configured, then two `GET`s), over TLS by default. **They fail closed:** a timeout, a TLS or connection error, an error reply such as `-NOAUTH` or `-WRONGPASS`, or any reply that is not a bulk string or nil denies the token with `error: REVOCATION_CHECK_FAILED` and logs the reason. Before 2.5.0 every one of these was read as "not revoked".

**The token must belong to your workspace.** Organization-service signs every tenant's tokens with the same key, so a valid signature does not say whose token it is. A token whose `tenant_id` claim is not `AFORO_TENANT_ID` (or has none) is denied with `error: TENANT_MISMATCH` and a `TENANT_MISMATCH` log line — the same rule as `key-authorizer.js` and the Kong plugin. When `AFORO_TENANT_ID` is unset or blank, every request is denied with `error: TENANT_NOT_CONFIGURED` and an error log; nothing is allowed. The `tenantId` passed downstream is always `AFORO_TENANT_ID`, never read from the token. Before 2.5.0 any Aforo workspace's token was allowed and its own `tenant_id` passed on.

The issuer check is always on: `iss` must equal `AFORO_JWT_ISSUER` (default `https://auth.aforo.ai`). Only `AFORO_JWT_ISSUER_CHECK_DISABLED=true` turns it off (logged once per container). Before 2.5.0 an unset `AFORO_JWT_ISSUER` skipped the check.

An unknown `kid` refetches the JWKS at most once per 30 s. If that refetch fails, the previous key set stays in use.

## Scopes per route (`AFORO_ROUTE_SCOPES`)

Set this when routes on one stage need different scopes, for example a read-only client that must not reach `DELETE /v1/items/{id}`. Without it, every token of your workspace can call every route on the stage and the scopes only travel on in `$context.authorizer.scopes` (the behaviour before 2.6.0, unchanged when the variable is unset).

The value is a JSON object. Each key is `"METHOD /path"`, each value is one scope or an array of scopes; the token must hold **all** of them.

```json
{
  "GET /v1/items":            "items:read",
  "GET /v1/items/{id}":       "items:read",
  "POST /v1/items":           "items:write",
  "DELETE /v1/items/{id}":    ["items:write", "items:delete"],
  "ANY /v1/admin/**":         "admin",
  "GET /v1/admin/health":     [],
  "*":                        "api:access"
}
```

```bash
# update-function-configuration replaces the whole variable set: repeat the existing variables.
aws lambda update-function-configuration \
  --function-name aforo-jwt-authorizer \
  --environment file://authorizer-env.json   # {"Variables":{"AFORO_JWKS_URI":"…","AFORO_TENANT_ID":"…","AFORO_ROUTE_SCOPES":"{\"GET /v1/items\":\"items:read\"}"}}
```

| In a key | Matches |
|---|---|
| `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS` | That method (case-insensitive in the map). |
| `ANY` or `*` as the method | Every method. |
| A plain segment (`items`) | That exact text, case-sensitive. |
| `{id}` or `*` | Exactly one path segment, whatever its value. `/v1/items/{id}` matches `/v1/items/42`, not `/v1/items` and not `/v1/items/42/owners`. |
| `{proxy+}` or `**`, last segment only | The rest of the path, including nothing: `/v1/admin/**` matches `/v1/admin` and `/v1/admin/users/7`. |
| `"*"` as the whole key | The default for every route no other entry matches. |

**How a path parameter is matched.** API Gateway hands the authorizer the path the client called, inside the method ARN (`arn:…:<apiId>/<stage>/GET/v1/items/42`), not the resource template. The authorizer splits that path on `/`, drops empty segments (so `/v1/items/42/` and `/v1//items/42` are `/v1/items/42`), URL-decodes each segment and compares segment by segment. The name inside `{…}` is for the reader; it is not compared with anything.

**When several entries match, the most specific one wins**, and only that entry's scopes are required. Compared segment by segment from the left: a plain segment beats `{id}`, which beats `**`; a pattern that ends beats one that goes on with `**`; on a tie a named method beats `ANY`. In the example, `GET /v1/admin/health` needs no scope (`[]`) although `ANY /v1/admin/**` also matches it, and `POST /v1/admin/health` needs `admin`. Two entries that match exactly the same routes (`GET /v1/items/{id}` and `GET /v1/items/{itemId}`) make the map invalid.

**A route that no entry matches needs no scope** — the same as without a map. Add the `"*"` entry if every route should need at least one scope; a specific entry with `[]` then marks the routes that stay open to every token of your workspace. With `"*"` in place, a path variant you did not list still needs the default scope.

**A map that is not valid denies every request** (`error: ROUTE_SCOPES_INVALID`), including routes it does not name, and writes one error line when the container first reads it: `Authorizer: AFORO_ROUTE_SCOPES is not valid — denying every request until it is fixed. <reason>`. Not valid means: not JSON, not an object, a key that is not `"METHOD /path"` or `"*"`, an unknown method, `**` before the last segment, a wildcard mixed with text (`item{id}`), a value that is not a scope or an array of scopes, an empty scope string, or two entries for the same routes. Check the value before deploying:

```bash
node -e 'require("./authorizer")._test.parseRouteScopes(process.argv[1]); console.log("ok")' "$AFORO_ROUTE_SCOPES"
```

Other denials this setting adds:

| `$context.authorizer.error` | Meaning |
|---|---|
| `INSUFFICIENT_SCOPE` | The token lacks a scope the route needs. The log names the matched entry and the missing scopes, never the token. |
| `ROUTE_UNKNOWN` | The method ARN has no readable method and path, or the path has a `.` / `..` segment or an encoded slash (`%2F`). Such a path could reach another route on the backend than the one matched here, so it is denied whenever a map is set. |

The token's scopes are read as before: the `scopes` claim, a space-separated string or an array. A scope must equal the required one; `items:reader` does not satisfy `items:read`, and there are no scope wildcards.

### The cache changes when a map is set

With a map, an Allow names the called method ARN only (`arn:…:<apiId>/<stage>/GET/v1/items/42`), never the stage. That is what stops a cached Allow for one route from opening another route that needs a different scope. It also means the cached result is only good for the route it was made for, so the cache key must include the method and the path. A `TOKEN` authorizer cannot do that: its key is the token alone. Pick one of these when you set `AFORO_ROUTE_SCOPES`:

| Authorizer | Identity sources | Result TTL | Effect |
|---|---|---|---|
| `REQUEST` (recommended) | `method.request.header.Authorization, context.httpMethod, context.path` | 60 s or less | One cached result per token, method and path. |
| `TOKEN` | `method.request.header.Authorization` | **0** | No cache: the authorizer runs on every call. |

```bash
# REQUEST authorizer, cached per token + method + path, 60 s
aws apigateway create-authorizer \
  --rest-api-id YOUR_API_ID \
  --name aforo-jwt-authorizer \
  --type REQUEST \
  --authorizer-uri "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:ACCOUNT:function:aforo-jwt-authorizer/invocations" \
  --identity-source "method.request.header.Authorization,context.httpMethod,context.path" \
  --authorizer-result-ttl-in-seconds 60

# An existing TOKEN authorizer: turn its cache off
aws apigateway update-authorizer --rest-api-id YOUR_API_ID --authorizer-id AUTHORIZER_ID \
  --patch-operations op=replace,path=/authorizerResultTtlInSeconds,value=0
```

Console: API Gateway → your API → Authorizers → Create authorizer → Lambda event payload **Request**; add three identity sources (Header `Authorization`, Context `httpMethod`, Context `path`); Authorization caching on, TTL `60`. Redeploy the stage after either change. `authorizer.js` reads the token from `authorizationToken` (TOKEN) or from the `Authorization` header (REQUEST), so the same function serves both.

> **A `TOKEN` authorizer with a TTL above 0 and a map breaks multi-route clients.** API Gateway reuses the first route's policy for the next route called with the same token; that policy does not name the second route, so the call gets 403 until the TTL runs out. It fails closed, but it looks like a random 403.

**The trade-off:** per-method caching means more authorizer invocations. Stage-wide, a client costs one invocation per token per TTL. Per method and path, it costs one per distinct method + path per token per TTL, and `context.path` holds the real path, so `/v1/items/1` and `/v1/items/2` are two cache entries. A client that walks many ids pays one invocation (JWKS from memory, one Redis round trip) per id. `context.resourcePath` (the template, `/v1/items/{id}`) would cut that down, but the cached policy names one real path, so the second id would get 403 — do not use it. If the extra invocations cost more than you want, leave `AFORO_ROUTE_SCOPES` unset on that stage and check `$context.authorizer.scopes` in the integration instead.

None of this has run on a live API Gateway stage; the suite drives the handler with TOKEN and REQUEST events.

## Audience (`AFORO_JWT_AUDIENCE`)

Set this so a token minted for another Aforo-protected API is not accepted here. `AFORO_JWT_AUDIENCE` is a comma-separated list; the token's `aud` claim (a string or an array of strings) must name one of them, compared exactly. Anything else is denied with `error: INVALID_AUDIENCE`.

| `AFORO_JWT_AUDIENCE` | `AFORO_JWT_AUDIENCE_ALLOW_MISSING` | Token `aud` | Result |
|---|---|---|---|
| unset | any | any | Not checked. One warning per container: `AFORO_JWT_AUDIENCE is not set — the aud claim is not checked`. |
| set | unset or not `true` | names an accepted audience | Allow |
| set | unset or not `true` | absent | Deny |
| set | `true` | absent | Allow |
| set | any | present, names none of them (also `[]`, `""`, a number) | Deny — `ALLOW_MISSING` never lets a wrong `aud` through |

These are the Kong plugin's `jwt_audience` and `jwt_audience_allow_missing` under AWS names, with the same meaning.

**Turn it on only after organization-service mints `aud`.** Until that release is deployed, Aforo tokens carry no `aud`, and setting `AFORO_JWT_AUDIENCE` alone denies every one of them. Roll out in this order, the same as for Kong:

1. Confirm organization-service puts `aud` in new tokens: decode one from `POST /oauth/token` and read the claim.
2. Set `AFORO_JWT_AUDIENCE=<that value>` **and** `AFORO_JWT_AUDIENCE_ALLOW_MISSING=true`. Old tokens (no `aud`) and new ones both pass; a token for another audience is already denied.
3. Wait until every token minted before step 1 has expired (Aforo access tokens live 15 minutes; allow the longest lifetime you issue).
4. Remove `AFORO_JWT_AUDIENCE_ALLOW_MISSING`. From here a token without `aud` is denied.

A cached Allow outlives the change by at most the authorizer result TTL.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AFORO_JWKS_URI` | Yes | — | Full URL of Aforo's JWKS endpoint, e.g. `https://auth.smartai.com/.well-known/jwks.json` |
| `AFORO_TENANT_ID` | **Yes** | — | Your Aforo workspace (tenant) id. A token whose `tenant_id` differs is denied (`TENANT_MISMATCH`). Unset → every request denied (`TENANT_NOT_CONFIGURED`). |
| `AFORO_JWT_ISSUER` | No | `https://auth.aforo.ai` | Required `iss` claim. |
| `AFORO_JWT_ISSUER_CHECK_DISABLED` | No | — | `true` skips the issuer check (logged). Any other value keeps it. |
| `AFORO_JWT_AUDIENCE` | No | — | Comma-separated accepted audiences. Set: the token's `aud` must name one, else `INVALID_AUDIENCE`. Unset: `aud` is not checked (logged once per container). See [Audience](#audience-aforo_jwt_audience) before setting it. |
| `AFORO_JWT_AUDIENCE_ALLOW_MISSING` | No | — | `true` accepts a token with no `aud` while `AFORO_JWT_AUDIENCE` is set. For the rollout only; a wrong `aud` is still denied. |
| `AFORO_ROUTE_SCOPES` | No | — | JSON map `"METHOD /path"` → scope(s) the token must hold. Unset: no scope is needed on any route. Not valid: every request is denied. Changes the Allow to the called method ARN, which needs different cache settings. See [Scopes per route](#scopes-per-route-aforo_route_scopes). |
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

**With `AFORO_ROUTE_SCOPES` set, do not use this command as it stands.** The
Allow then covers one method ARN, and a `TOKEN` authorizer caches by token
alone: create a `REQUEST` authorizer with identity sources
`method.request.header.Authorization,context.httpMethod,context.path` (TTL 60 s
or less), or keep `TOKEN` with TTL 0. Commands and the reason:
[The cache changes when a map is set](#the-cache-changes-when-a-map-is-set).

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
| `error` | Set on a Deny only | `INSUFFICIENT_SCOPE`, `INVALID_AUDIENCE`, `ROUTE_SCOPES_INVALID`, `TENANT_MISMATCH`, … |
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

`template.yaml` deploys the metering function, the metering proxy and
`key-authorizer.js`. It does not create `authorizer.js` or its API Gateway
authorizer, so it cannot set the result TTL or the identity sources for you: the
values above are yours to set. To add it to your own template, declare an
`AWS::Serverless::Function` plus an `AWS::ApiGateway::Authorizer` with
`AuthorizerResultTtlInSeconds: 60` (and, with `AFORO_ROUTE_SCOPES`,
`Type: REQUEST` and `IdentitySource: method.request.header.Authorization,context.httpMethod,context.path`),
mirroring the CLI steps above.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every call is 403 right after setting `AFORO_ROUTE_SCOPES`; log shows `AFORO_ROUTE_SCOPES is not valid` | The value does not parse (the log line gives the reason) | Fix the JSON; check it with the `node -e` line under [Scopes per route](#scopes-per-route-aforo_route_scopes). The next cold container, or the next value, is read again. |
| The first route works, the next route with the same token is 403 for up to the TTL, with no authorizer log line | `TOKEN` authorizer with a TTL above 0 and a map: the first route's cached policy is reused | Switch to the `REQUEST` authorizer with the three identity sources, or set the TTL to 0. |
| 403 with `error: INSUFFICIENT_SCOPE` on a route you thought was open | A broader entry (`ANY /v1/admin/**`, `"*"`) matches it | Add a more specific entry for that route with the scope it needs, or `[]` for none. |
| A route needs no scope although the map lists it | The entry does not match the real path: different case, a missing segment, `{id}` where the path has two segments | Compare the entry with the path in the method ARN (API Gateway execution log); add `"*"` so unmatched routes still need a scope. |
| Every call is 403 with `error: INVALID_AUDIENCE` after setting `AFORO_JWT_AUDIENCE` | Tokens carry no `aud` yet, or a different one | Set `AFORO_JWT_AUDIENCE_ALLOW_MISSING=true` until organization-service mints `aud`; compare the list with a decoded token's `aud`. |
| Authorizer invocations and cost went up after setting the map | Per-method caching: one cached result per token, method and path | Expected; see the trade-off under [The cache changes when a map is set](#the-cache-changes-when-a-map-is-set). |
