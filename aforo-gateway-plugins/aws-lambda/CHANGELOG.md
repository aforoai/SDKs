# Changelog — aforo-metering-lambda

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

This function ships on the Aforo gateway-plugins line; the whole repo is versioned and tagged together. The version lives in `package.json`. Entries below are the AWS-Lambda-specific slice of each repo release (see the parent `aforo-gateway-plugins/CHANGELOG.md` for the cross-plugin picture).

## [Unreleased]

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
