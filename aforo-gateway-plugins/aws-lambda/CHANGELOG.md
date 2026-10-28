# Changelog — aforo-metering-lambda

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

This function ships on the Aforo gateway-plugins line; the whole repo is versioned and tagged together. The version lives in `package.json`. Entries below are the AWS-Lambda-specific slice of each repo release (see the parent `aforo-gateway-plugins/CHANGELOG.md` for the cross-plugin picture).

## [2.5.0] - not yet released

### Runtime

- **Node.js 24 (`nodejs24.x`) for every function in `template.yaml`** (was `nodejs20.x`, deprecated on 2026-04-30; AWS blocks creating functions on it from 2027-02-01 and updating them from 2027-03-03). The code uses Node.js built-ins only and the suite passes on Node 24. Upgrade note: a stack update replaces the runtime in place; no configuration change. The organization-service one-click deploy uses the same runtime from its matching release.

### Security (G340, G341, G342, G343, G344; W6.2 review fixes)

- **`authorizer.js` revocation fails closed (G340).** The Redis lookup used a plain TCP socket with no AUTH, and read any reply not starting with `$` (for example `-NOAUTH`), a timeout or a connection error as "not revoked". It now connects with TLS (default; `REDIS_TLS=false` only for a local Redis, logged), sends `AUTH` when `REDIS_AUTH_SECRET_ARN` (Secrets Manager, via `aws-secret.js`) or `REDIS_AUTH_TOKEN` is set (`REDIS_USERNAME` for ElastiCache RBAC), sends both `GET`s on one connection, and parses RESP. A timeout (`REDIS_TIMEOUT_MS`, default 1000), TLS failure, error reply or unexpected reply denies the token with `error: REVOCATION_CHECK_FAILED`. With no `REDIS_HOST`, revocation is still not checked (logged once per container).
- **Allow policy covers one stage (G341).** The Allow resource was built by cutting the method ARN on `:`, which left the method path in place with `:*` appended — neither the documented API-wide wildcard nor the method. It is now `arn:…:<apiId>/<stage>/*`; Deny covers the called method only. AUTHORIZER.md recommended an 840 s authorizer cache, so a revoked token stayed allowed ~14 minutes; it now says 60 s or less (0 to check every call). `authorizer.js` has no per-route scope configuration, so scopes are still only passed on in the context.
- **JWKS refetch on an unknown `kid` is rate-limited (G343).** It cleared the cache and refetched on every request with an unknown `kid`. Now at most one refetch per 30 s; if it fails the previous key set stays in use. A failed fetch no longer blocks requests while a fresh key set is cached (the 30 s error backoff was checked before the cache).
- **`margin-guard.js` cache is bounded and per tenant key (G342, on top of G332).** Least-recently-used eviction at `marginGuardCacheMaxEntries` (default 10000; it used to clear the whole cache when full); expired entries are dropped on read; the cache key includes a fingerprint of `apiKey`, so a container used with two tenants' keys never answers one from the other's entry. A bad `marginGuardUrl` fails open without a call; a non-positive `marginGuardTimeoutMs` uses the default.
- **`preflight-quota.js` (G344).** Checks the HTTP status (non-2xx → `preflightFallback`; it used to return a 500's body as the decision), requires a decision of `ALLOW` / `WARN` / `DENY`, caches `ALLOW` / `WARN` for `allowCacheTtlMs` (default 1000) and `DENY` until `retryAfterMs` (default 60 s, max 1 h), bounded at `cacheMaxEntries` (default 5000). Keep-alive HTTPS agent. Default timeout 250 ms over the whole request (was 50 ms on socket idle, which fails open on a cold TLS handshake). Refuses a non-https URL. Response bodies over 64 KiB are refused.
- **`authorizer.js` accepts only your workspace's tokens (W6.2 review, G341).** Organization-service signs every tenant's tokens with one key, so any Aforo workspace's token used to be allowed, with its own `tenant_id` passed downstream. New required `AFORO_TENANT_ID`: a token whose `tenant_id` differs (or is missing) is denied with `error: TENANT_MISMATCH`; unset or blank denies every request (`TENANT_NOT_CONFIGURED`, error log) — never Allow. `tenantId` in the context is always `AFORO_TENANT_ID`. The issuer check is now always on: `iss` must equal `AFORO_JWT_ISSUER` (default `https://auth.aforo.ai`; it was skipped when unset); only `AFORO_JWT_ISSUER_CHECK_DISABLED=true` turns it off (logged). Same rule as `key-authorizer.js` and the Kong plugin (2.8.0).
- **`preflight-quota.js` cache (W6.2 review, G344).** A `DENY` is cached at most 60 s (was up to 1 h — a wallet top-up must unblock quickly), 5 s when the server sent no `retryAfterMs` (was 60 s). The cache key adds a SHA-256 fingerprint of `apiKey` and the optional `config.tenantId` (it was customer + metric only, so one container used with two workspaces' keys could answer one workspace's caller with the other's `DENY`). A cached `DENY` reports the remaining wait as `retryAfterMs`; `build429Response` rounds `Retry-After` up, at least 1 s (a sub-second wait used to send `Retry-After: 0`), and sends `Retry-After: 5` when the server gave no wait (was 60), the time that DENY stays cached.
- **`aws-secret.js` backs off before the first success (W6.2 review, G340).** With no cached value, every invocation called Secrets Manager (3 s timeout), so an outage or an IAM mistake cost each call up to 3 s. After a failed read, calls now fail fast with the same error for 5 s, doubling per failure up to 60 s, jittered to 50–100 %. Once a value is cached nothing changes (a failed refresh keeps it and retries after 30 s). Applies to `index.js`, `key-authorizer.js` and the Redis AUTH token in `authorizer.js`.
- Tests: `tests/authorizer.test.js` (52; local RESP server, and a TLS round trip when `openssl` is available), `tests/guards.test.js` (42), `tests/aws-secret.test.js` (17), `../aws-cloudformation/tests/templates.test.cjs` (33) added to `npm test`. Suite 543 → 674.

#### Upgrade from 2.4.0

1. `authorizer.js` with `REDIS_HOST` set: turn on in-transit encryption on the ElastiCache cluster (or set `REDIS_TLS=false` for a cluster without it, which keeps the old plaintext behaviour and logs a warning). If the cluster has AUTH or RBAC on, store the token: `aws secretsmanager create-secret --name aforo/redis-auth --secret-string '<token>'`, set `REDIS_AUTH_SECRET_ARN`, and allow the authorizer's role `secretsmanager:GetSecretValue` on that secret. The VPC needs a route to Secrets Manager.
2. Expect denials when Redis is unreachable: before 2.5.0 those calls were allowed. Watch the authorizer log for `revocation check failed`.
3. Lower the authorizer result TTL: `aws apigateway update-authorizer --rest-api-id <id> --authorizer-id <id> --patch-operations op=replace,path=/authorizerResultTtlInSeconds,value=60`, then redeploy the stage.
4. Packaging `authorizer.js` by hand: include `aws-secret.js` in the zip.
5. `preflight-quota.js` callers: a 4xx/5xx now returns `preflightFallback` instead of the body; set `timeoutMs` if you relied on 50 ms.
6. **Breaking — `authorizer.js` needs `AFORO_TENANT_ID`.** Set it to your Aforo workspace id before deploying 2.5.0, or every request is denied: `aws lambda update-function-configuration --function-name aforo-jwt-authorizer --environment 'Variables={…,AFORO_TENANT_ID=<workspace id>}'` (the call replaces the whole variable set, so repeat the existing ones). Tokens issued for another workspace are now denied.
7. `authorizer.js` without `AFORO_JWT_ISSUER`: the issuer is now checked against `https://auth.aforo.ai`. Set `AFORO_JWT_ISSUER` if your tokens carry another issuer; `AFORO_JWT_ISSUER_CHECK_DISABLED=true` only if they carry none you can name.
8. `preflight-quota.js` callers that relied on a long `DENY` cache: it now lasts at most 60 s, so a customer over quota is asked about again every minute. Pass `config.tenantId` if one container serves several workspaces with the same key (optional).
9. A cold container whose Secrets Manager read fails now fails fast for up to 60 s after repeated failures; after fixing IAM or the endpoint, expect up to that long (or a new container) before it reads again.

## [2.4.0] - not yet released

### Security and cost (G337, G338, G339)

- **The Aforo key is read from AWS Secrets Manager (G337).** New `aws-secret.js` (Node.js built-ins only; signs `GetSecretValue` with SigV4, checked against AWS's published SigV4 example) is shared by `index.js` (`AFORO_API_KEY_SECRET_ARN`) and `key-authorizer.js` (`AFORO_TENANT_KEY_SECRET_ARN`). The secret is plain text or JSON `{"apiKey":"…"}`, read on first use, cached per container and refetched every 5 minutes so a rotated key reaches warm containers; a failed refresh keeps the last value and retries after 30 s. `AWS_ENDPOINT_URL_SECRETS_MANAGER` overrides the endpoint (VPC endpoint, local testing).
- **Behaviour change:** `index.js` fails the invocation (Lambda retries it; the OnFailure queue keeps it) when no key is configured or the secret cannot be read on a cold start. Before, it posted with an empty `X-API-Key` and the ingestor dropped the batch with 401.
- `key-authorizer.js` reads the tenant key on a cache miss only; if the secret cannot be read the call is denied with 500, as for an introspection outage.
- The plain `AFORO_API_KEY` / `AFORO_TENANT_KEY` variables still work when no secret ARN is set (Aforo's one-click deploy still sets `AFORO_API_KEY`), and log a warning once per container.
- **SAM template:** new required `AforoApiKeySecretArn`; optional `AforoTenantKeySecretArn` and `SecretsKmsKeyArn`. Each function may call `secretsmanager:GetSecretValue` on its one secret only (`kms:Decrypt` on the given key via Secrets Manager only). `AforoApiKey` / `AforoTenantKey` stay as parameters but must be empty: a `Rules` assertion (`NoPlaintextAforoKeys`) fails the deployment with a message naming the replacement. Chosen over keeping the plaintext path behind an opt-in: an opt-in leaves the leaky path one flag away, and a failed change set costs one redeploy.
- **Reserved concurrency and batch size (G338):** `ReservedConcurrency` (default 10; `0` reserves none, for accounts whose quota leaves nothing to reserve) on `aforo-metering` only — the proxy and authorizer are in the request path and stay uncapped. `FlushCount` (default 500, max 1000); the code default is 500 as well (was 50).
- **Filter, arm64, retention (G339):** the access-log subscription filter is `AccessLogFilterPattern`, default `?"customerId" ?"caller" ?"aforoUsage"` — only lines that can bill (it was `''`, every line). Every function runs on `arm64` (`Globals`). `aforo-metering` and `aforo-key-authorizer` log to `/aforo/lambda/aforo-metering` and `/aforo/lambda/aforo-key-authorizer` (`LoggingConfig`) with `LogRetentionDays` (default 14), which the proxy log group uses too.
- Tests: `tests/aws-secret.test.js` (14), `tests/secret-wiring.test.js` (19), `tests/template.test.js` (41); suite 461 → 535. `cfn-lint` 1.58.0 clean apart from W2531 (nodejs20.x deprecation, unchanged). Not deployed to AWS.

#### Upgrade from 2.3.0 (SAM)

1. Store the key: `aws secretsmanager create-secret --name aforo/metering/api-key --secret-string "$AFORO_API_KEY"` and keep the ARN. Same for the authorizer's tenant key if you use `DeployKeyAuthorizer` with customer keys.
2. Redeploy with `AforoApiKeySecretArn=<arn> AforoApiKey=''` (and `AforoTenantKeySecretArn=<arn> AforoTenantKey=''`). `sam deploy` reuses a value saved in `samconfig.toml`: remove `AforoApiKey` from it. Add `SecretsKmsKeyArn` if the secret uses your own KMS key.
3. `ReservedConcurrency` defaults to 10. If the update fails with "decreases account's UnreservedConcurrentExecution below its minimum value", deploy with `ReservedConcurrency=0`.
4. The function's logs move to `/aforo/lambda/aforo-metering`. The old `/aws/lambda/aforo-metering` group is left as it was (no retention): set one or delete it, e.g. `aws logs put-retention-policy --log-group-name /aws/lambda/aforo-metering --retention-in-days 14`. Update any alarm or metric filter that reads the old group; the EMF metrics are unaffected.
5. Access-log lines without `customerId`, `caller` or `aforoUsage` no longer reach the function, so the `no customerId` count in its log stays at 0 for them. Deploy with `AccessLogFilterPattern=''` while you fix an access-log format.
6. Packaging by hand: `key-authorizer.js` and `index.js` now require `aws-secret.js`; include it in the zip.

### Margin guard calls the public, key-authenticated check (G332)

- `margin-guard.js` calls pricing's `GET /api/v1/margin-guard/quick-check?scopeType=CUSTOMER&scopeId=…` with `X-API-Key` (the deployment's `usage:ingest` key; pricing takes the tenant from it). It called `/internal/v1/margin-guard/quick-check`, which public hosts refuse, with no credential, and read `allowed` / `level` / `throttleRate`, which pricing never sent, so it never blocked anything.
- It reads `verdict` (`ALLOW` / `THROTTLE` / `BLOCK`, bare or inside `data`). `THROTTLE` is pricing's decision for this request: always a 429, never cached, no local dice. `BLOCK` and a plain `ALLOW` are cached for `marginGuardCacheTtlMs`.
- **Breaking (library API):** `checkMarginGuard(customerId, config)` — the tenant id argument is gone; `config.apiKey` is required (no key = check skipped with one warning). `marginGuardTimeoutMs` (default 200; was a fixed 50). `buildEnforcementResponse(result, config)`: `Retry-After` is the cache TTL for `BLOCK`, 1 s for `THROTTLE`.
- Needs pricing with `/api/v1/margin-guard/quick-check` (aforoai/aforo-nextgen-pricing-service, branch `jayaforo/w6.7-public-margin-check`). Tests: `tests/margin-guard.test.js` (9). Cached answers are per API key (SHA-256 fingerprint in the cache key), so two workspaces sharing a warm container never see each other's verdict.

### AWS Lambda: AI_AGENT and MCP_SERVER through API Gateway

- **`key-authorizer.js` accepts Aforo client-credential JWTs** (`POST /oauth/token`). RS256 only, verified with Node's `crypto` against the JWKS at `AFORO_JWKS_URL` (cached 1 h, one rate-limited refetch on an unknown `kid`); `exp` / `nbf` / `iat` with 30 s leeway; `iss` == `AFORO_JWT_ISSUER`; `tenant_id` == the new `AFORO_TENANT_ID` (required; unset refuses every JWT). A JWKS failure fails closed (500) and is not cached. The context adds `subscriptionIds`, `agentId` (from the `agent_id` claim) and `authType`. The `sk_live_` / `sk_test_` path is unchanged apart from `authType: "key"`.
- **New `metering-proxy.js`**: a Lambda proxy integration that forwards to `UPSTREAM_URL` or `UPSTREAM_FUNCTION`, returns the upstream response unchanged (502 on error or timeout), and writes one `{"aforoUsage":1,...}` record per call: identity from the authorizer context, trace and session headers, MCP `tools/call` names (single or batch), token usage (`x-aforo-*` headers, else an Anthropic / OpenAI `usage` object in the body). Bodies and `Authorization` are never logged.
- **`index.js`** reads proxy records, also behind a Lambda log prefix or inside Lambda's JSON log format. `AI_AGENT`: `agentId` only from the authorizer, `sessionId` from the record else `requestId`, plus a `TOKEN_METRIC` event (default `Tokens Consumed`) keyed `<requestId>:tokens`. MCP: one event per tool call keyed `<requestId>:mcp:<i>`; access-log MCP keeps its frozen key. An X-Ray `Root=…;Parent=…` `x-trace-id` is reduced to the root id.
- **Behaviour change:** the MCP metric is no longer hard-coded `mcp_server.tool_invocations`. It is `METRIC_MAPPINGS` → `MCP_METRIC` → `DEFAULT_METRIC`; set `MCP_METRIC=mcp_server.tool_invocations` to keep the old name.
- SAM template: optional proxy function, log group and subscription filter (`UpstreamUrl` / `UpstreamFunction`); optional key authorizer (`DeployKeyAuthorizer`, `AuthorizerTenantId`); `McpMetric`, `TokenMetric`.
- Tested locally only (stubbed JWKS, local upstream server); not yet run on AWS.

## [2.3.0] - 2026-10-16

### Added
- `key-authorizer.js`: API Gateway TOKEN authorizer for the customer's Aforo key (`Authorization: Bearer sk_live_…`, issued at subscription). Checks the key with Aforo's `POST /api/v1/customer-keys/introspect` using the tenant key, caches answers per container, fails closed, never logs the key. Sets `customerId`, `keyId`, `subscriptionId`, `productType`. Before this, a customer's subscription key could not be used at AWS: `authorizer.js` accepts only JWTs. See AUTHORIZER.md.
- `subscriptionId` from `$context.authorizer.subscriptionId` is sent as the event's top-level `subscriptionId`. Add it to the access-log format.

### Docs
- The account-level API Gateway CloudWatch Logs role is a prerequisite for access logging.

### Verified
- Live in production on 2026-10-16: API Gateway REST stage → `key-authorizer.js` → access log → `index.js` → ingestor. Calls with the customer's key were stored under that customer; unknown or missing keys got 401 and were not metered.

## [2.2.0] - 2026-10-02

Merges the two lines of this function: the public 2.1.0 release (mirror work by Gowtham and Eswar) and the working repository's delivery, outcome and detection work. Every setting either line read still works.

### From the 2.1.0 line
- Customer identity from `$context.authorizer.customerId`; the API key value and the client IP are never a `customerId`; no identity or an id over 64 characters → no event.
- `METRIC_MAPPINGS` (EXACT / PREFIX / CONTAINS, first match wins), `DEFAULT_METRIC` (`api_calls`), `PRODUCT_TYPE` on every event.
- `OPTIONS` and quantity ≤ 0 not metered; `FLUSH_COUNT` capped at 1000.
- 408 / 429 retried, `Retry-After` honoured (30 s cap), other 4xx dropped with the body logged; batches sent concurrently under a deadline from `getRemainingTimeInMillis()`.
- `X-API-Key` only; default endpoint `https://api.aforo.ai/v1/ingest/batch`; `index.handler` exported.

### From the working repository
- `executionStatus` on every event from the HTTP status (2xx/3xx SUCCESS, 408/504 TIMEOUT, 499 CANCELLED, 400/422 VALIDATION_FAILED, 401/403/429 BLOCKED, other 4xx/5xx ERROR), with `STATUS_OUTCOMES` overrides. This replaces 2.1.0's MCP-only SUCCESS/ERROR.
- `EXCLUDE_STATUS_CODES` (default `401,403,429`; a list replaces the default; `none` or empty meters everything) — 2.1.0 had the list hardcoded.
- AGENTIC_API detection: with `PRODUCT_TYPE=API`, a valid W3C `traceparent` (or `x-trace-id`) sends `productType: AGENTIC_API` and a top-level `traceId`.
- Delivery: EMF metric `EventsFailedToSend` before each throw; SQS OnFailure queue (14 days) and `MaximumEventAgeInSeconds: 21600` in `template.yaml`; replay procedure in the README.
- Compound events: `correlationId` is a UUID derived from the request's stable seed, not random per call.

### Added
- EMF metrics `EventsRejected` (permanent 4xx, and events rejected individually inside an accepted batch — read from `data.errors` of the `{success, data, meta}` response) and `EventsDroppedInvalidMetric`.
- A resolved metric name that is empty or longer than 255 characters is dropped with a WARN instead of sent.
- `CUSTOMER_ID_SOURCE=authorizer` to disable the IAM-caller fallback.
- `buildCompoundEvent(customerId, measurements, metadata, correlationSeed, productType)`; an options object `{ correlationSeed, productType }` is accepted as the 4th argument.
- `npm test` runs two suites: `tests/handler.test.js` and `tests/contract.test.js`.

### Changed — what a 2.1.0 user will notice
- A request carrying `traceparent` is now sent as `AGENTIC_API` when `PRODUCT_TYPE` is `API`. Set `PRODUCT_TYPE` to anything else to keep one type for every event.
- MCP events get `executionStatus` from the shared table (504 is `TIMEOUT`, not `ERROR`), and the MCP idempotency key is back to `mcp:<AFORO_TENANT_ID>:<requestId>:<toolName>:<log timestamp>` (2.1.0 used `mcp:<requestId>:<toolName>`). Both shapes are stable across retries; an MCP event in flight across the upgrade from 2.1.0 can be counted twice.
- SAM parameters `AforoTenantId` and `CustomerIdSource` are accepted again (both optional), so parameter overrides written for either line deploy. The template gains `ExcludeStatusCodes`, `StatusOutcomes` and the failure queue.
- `buildCompoundEvent`'s 4th argument is the correlation seed. A 4th argument that is exactly a known productType, with no 5th argument, is still read as the productType.
- An IAM `caller` in the access log is used as the customer when the authorizer set none.

### Changed — what a user of the working repository's build will notice
- **`$context.identity.apiKey` is no longer the customer.** It is the key value, a secret. Stages metered through an API Gateway API key alone produce no events until the route has the Aforo authorizer (or IAM authorization) and the access-log format logs `customerId`. Remove `apiKey` from the log format. `principalId` and the CLF client IP are no longer used either.
- No `X-Tenant-Id` header is sent (index.js, `compound-metering.js`, `preflight-quota.js`).
- The default metric is `api_calls`, not `{method} {path}`. `METRIC_NAME_PATTERN` still applies when set.
- A permanent 4xx no longer throws: the batch is dropped and counted in `EventsRejected` instead of being redelivered twice and parked in the failure queue.
- Every event carries `productType` (default `API`); an MCP `tools/call` without an `agentId` keeps the configured type instead of `MCP_SERVER`.
- An MCP entry with no `requestId` now keys on the CloudWatch log-event id instead of the literal `undefined`.

### Deprecated aliases
None — the two lines used the same names. `AFORO_TENANT_ID` / `AforoTenantId` and `CUSTOMER_ID_SOURCE` / `CustomerIdSource`, removed in 2.1.0, are read again; `CUSTOMER_ID_SOURCE=header` stays unsupported and behaves as `authorizer`.

## [2.1.0] — 2026-10-01

### Added
- `PRODUCT_TYPE` env var / `ProductType` SAM parameter (default `API`): every event now carries the `productType` the ingestor requires in production. `compound-metering.js` `buildCompoundEvent` takes an optional `productType` (default `PRODUCT_TYPE` / `API`).

### Fixed (product type / retries)
- MCP `tools/call` is sent as `MCP_SERVER` only when both `toolName` and `agentId` are known; otherwise the configured type is kept, rather than an event the ingestor must reject (failing the whole batch). Entries missing the fields their `productType` requires are skipped.
- 429 honours `Retry-After` (up to 30 s; longer ends the attempts so Lambda's async retry re-delivers later).

Brings the function in line with the ingestor contract. **Breaking** for deployments: SAM parameters `AforoTenantId` and `CustomerIdSource` were removed, and the stage's access-log format must now include `customerId` from the authorizer context.

### Fixed
- `index.handler` was `undefined` at runtime: `exports.handler` was set and then `module.exports` was replaced wholesale for tests. The handler is now exported.
- Authenticates with `X-API-Key` alone (was `Authorization: Bearer`, which the ingestor never reads — and rejects 401 if present). Same fix in `preflight-quota.js` and `compound-metering.js`. `X-Tenant-Id` is no longer sent; the tenant comes from the key.
- Customer identity came from `$context.identity.apiKey` — the raw API key, a secret, sent to Aforo as `customerId` — or the CLF client IP. It now comes only from `$context.authorizer.customerId` (set by `authorizer.js` from the verified JWT). Entries without one, or with one longer than 64 chars, are skipped instead of being sent with `customerId: null` (which failed the whole batch).
- `OPTIONS` (CORS preflight) and quantity ≤ 0 (e.g. an empty 204 with `QUANTITY_SOURCE=response_size`) are no longer metered.
- The default metric was `{method} {path}` — never a catalog metric, so every batch failed 400. Added `METRIC_MAPPINGS` (EXACT/PREFIX/CONTAINS, first match wins) and `DEFAULT_METRIC` (`api_calls`); `METRIC_NAME_PATTERN` applies only when explicitly set.
- Retries: 408 and 429 are now retried; other 4xx are dropped with the response body logged. Batches are sent concurrently under one deadline taken from `context.getRemainingTimeInMillis()`, so retries cannot run past the Lambda timeout or starve later batches. A batch that still fails transiently makes the handler throw so Lambda's async retry re-delivers it (idempotency keys dedupe).
- `compound-metering.js` required `uuid`, which is not a dependency — now `crypto.randomUUID()`. Its default compound URL is built from the endpoint's origin instead of appended to the batch URL.
- Default `AforoEndpoint` is now `https://api.aforo.ai/v1/ingest/batch`. `ingest.aforo.ai` is CloudFront in front of S3: a POST gets a 301 from AmazonS3 and never reaches the ingestor.
- `FLUSH_COUNT` is capped at 1000, because the ingestor rejects a larger batch with 400.
- MCP idempotency key no longer embeds the tenant id or timestamp (`mcp:{requestId}:{tool}`).

### Tests
- Handler-level tests against a local capture server: `X-API-Key` only, no `Authorization`/`X-Tenant-Id`, OPTIONS/no-customer/oversize-customer skipped, API key never in payload, 400 dropped without retry, 429 retried, 5xx throws, deadline respected, zero quantity skipped, metric mapping resolution.

## [2.0.0] — 2026-06-29

Initial public distribution packaging for the AWS Lambda metering function: README, user guide, and versioning, documented against the 2.0.0 source.

This packaging documents the AWS slice of the **v2.0.0 security release (2026-04-23)**. The Lambda had no exploitable IDOR finding — it sources customer identity from API Gateway's verified `$context.identity.apiKey` / `.caller`, never a request header. The 2.0.0 work was hardening hygiene to prevent re-introduction of a header-based source:

- `index.js`: documented that `CUSTOMER_ID_SOURCE='header'` is no longer accepted; the legacy branch was dead code and is now explicitly called out. Only `'consumer'` resolves an identity; any other value drops through with `customerId=null` (the ingestor then rejects on schema validation).
- `template.yaml`: the `CustomerIdSource` CloudFormation parameter's allowed values narrowed to `[consumer]` (was `[consumer, header]`).
- `package.json`: bumped to `2.0.0`.
- All 14 existing tests still pass.

## [1.1.0] — 2026-04-16

- Lambda authorizer (separate `authorizer.js`): response-body TCP accumulation + negative JWKS caching (commit `d00dd86`).

## [1.0.0] — 2026-04-01

- Initial release: CloudWatch Logs subscriber that parses API Gateway access-log entries (JSON, with a CLF fallback), batches usage events (default 50), and POSTs them to the Aforo ingestor with 3x exponential-backoff retry.
- JWT/JWKS validation shipped in the companion Lambda authorizer.
