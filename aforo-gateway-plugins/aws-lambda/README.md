# aforo-metering-lambda

An AWS Lambda function that subscribes to API Gateway CloudWatch access logs, parses each entry, and batch-POSTs usage events to Aforo. It runs off the log stream asynchronously, so it adds nothing to your request path.

**Version:** 2.5.1 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

> Version lives in [`package.json`](package.json) (`"version": "2.5.1"`). It matches the version stated here and in the changelog.

## Install

There are two ways to deploy it. Both need JSON access logging on the stage, in the format under "Access-log format".

### Deploy with SAM

This is a private, SAM-deployed function — `package.json` is `"private": true` and there is no npm package. The function has no dependencies outside the Node.js 20 runtime.

Store the Aforo API key in AWS Secrets Manager first. The function reads it from there (once per container, refreshed every 5 minutes); it is never put in an environment variable.

```bash
aws secretsmanager create-secret \
  --name aforo/metering/api-key \
  --secret-string "$AFORO_API_KEY"
# Copy the "ARN" from the output.
```

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/aws-lambda

sam build
sam deploy --guided \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    AforoEndpoint=https://api.aforo.ai/v1/ingest/batch \
    AforoApiKeySecretArn="$AFORO_API_KEY_SECRET_ARN" \
    DefaultMetric=api_calls \
    ApiGatewayLogGroupName=/aws/apigateway/aforo-access-logs
```

The template creates the function (arm64, reserved concurrency `ReservedConcurrency`, default 10; `0` reserves none), an IAM policy that lets it read only that secret, the `lambda:InvokeFunction` permission for CloudWatch Logs, a `SubscriptionFilter` on the named log group, the function's log group `/aforo/lambda/aforo-metering` (retention `LogRetentionDays`, default 14), and the SQS failure queue described under "Delivery".

The subscription filter (`AccessLogFilterPattern`) forwards only lines that can bill: entries containing `customerId` or `caller`, and metering-proxy records (`aforoUsage`). Set it to `''` to forward every line while you debug an access-log format; lines without an identity are then counted as `no customerId` in the function's log.

If the secret is encrypted with a customer-managed KMS key, pass its ARN as `SecretsKmsKeyArn`.

### Deploy from Aforo (one click)

In Aforo, open the AWS API Gateway connection and deploy metering. Using the IAM role from the connection's CloudFormation stack, Aforo:

1. creates the function `aforo-metering-<connection id>` from `index.js` and `compound-metering.js`, with the connection's settings as environment variables;
2. sets its async retry policy (2 retries, 6 hours);
3. lets CloudWatch Logs invoke it for your access log group;
4. adds a subscription filter on that log group.

Deploying again updates the code only when it changed and always refreshes the settings it manages. Environment variables you added yourself (`METRIC_MAPPINGS`, `DEFAULT_METRIC`, `PRODUCT_TYPE`, `MCP_ENABLED`, …) are kept. Removing it deletes the filter, the permission and the function.

Before you deploy:

- **The connection's stack must grant the metering-install permissions.** The role template Aforo serves for the connection has an `AllowMeteringInstall` parameter; leave it at `true`. Stacks created before one-click metering are read-only — update the stack, and the deploy tells you which permission is missing if it isn't there. Since 3.0.0, `aws-cloudformation/aforo-apigateway-role.yaml` in this repo is the same template. Its subscription permission covers log groups starting with `/aws/apigateway/` or `API-Gateway-`; for any other access log group, update the stack with `AccessLogGroupPrefix=<log group name>`.
- **Access logging must be on** for each stage you bill, writing to one log group, in the format below. Aforo does not change your stages. Put the log group's name in the connection's `accessLogGroup` setting (default `/aws/apigateway/aforo-access-logs`).

The one-click install does not create the SQS failure queue. For that, use the SAM template.

### Access-log format

> ⚠ This Lambda parses **API Gateway access logs**, not the request itself. An entry it cannot attribute to a customer is skipped.

> ⚠ API Gateway can only write access logs once the account has a CloudWatch Logs role (API Gateway → Settings → *CloudWatch log role ARN*, one per account and region, policy `AmazonAPIGatewayPushToCloudWatchLogs`). Without it, enabling access logging on the stage fails.

```json
{"requestId":"$context.requestId","httpMethod":"$context.httpMethod","resourcePath":"$context.resourcePath","status":"$context.status","responseLatency":"$context.responseLatency","responseLength":"$context.responseLength","stage":"$context.stage","customerId":"$context.authorizer.customerId","keyId":"$context.authorizer.keyId","subscriptionId":"$context.authorizer.subscriptionId","caller":"$context.identity.caller"}
```

Where the customer comes from, in order:

| Field | Source | When |
|---|---|---|
| `customerId` | `$context.authorizer.customerId` — set by an Aforo authorizer: `key-authorizer.js` from the customer's Aforo key (`sk_live_…`, issued at subscription), or `authorizer.js` from a verified Aforo JWT. See [AUTHORIZER.md](AUTHORIZER.md). | Routes behind an Aforo authorizer. |
| `caller` | `$context.identity.caller` — the IAM principal API Gateway verified from the SigV4 signature. | IAM-authorized routes. Used only when `customerId` is absent and `CUSTOMER_ID_SOURCE` is `consumer` (the default). The value must be the customer's id in Aforo. |

Never used, even if your format logs them: `$context.identity.apiKey` (the API key **value** — a secret; remove it from your log format), `$context.authorizer.principalId`, request headers, and the client IP. An entry with no identity, or with one longer than 64 characters, is skipped and counted in the Lambda log as `no customerId` — it is never sent with a null or placeholder customer.

- `subscriptionId` (`$context.authorizer.subscriptionId`, set by `key-authorizer.js`) is sent as the event's `subscriptionId`, so billing picks the right subscription when a customer has several pricing the same metric. Optional; omitted when unset or longer than 64 characters.
- HTTP APIs with a native JWT authorizer: `"customerId":"$context.authorizer.claims.customer_id"` (not verified on a live stage — test against yours).
- CLF-format entries parse, but carry no customer, so they are never metered.
- Metric mappings match the logged `resourcePath` (for REST APIs the resource template, e.g. `/v1/users/{id}`). To match concrete paths, log `$context.path` as `path` and drop `resourcePath`.

## Quickstart

```bash
sam deploy \
  --parameter-overrides \
    AforoEndpoint=https://api.aforo.ai/v1/ingest/batch \
    AforoApiKeySecretArn="$AFORO_API_KEY_SECRET_ARN" \
    DefaultMetric=api_calls \
    MetricMappings='[{"matchType":"PREFIX","value":"/v1/sms","metricName":"sms_sent"}]' \
    ApiGatewayLogGroupName=/aws/apigateway/aforo-access-logs
```

Send a request through your stage, wait for the access log to flush to CloudWatch, then check the Lambda's logs for `Sent N/N events to Aforo`.

## Configuration

The function reads everything from environment variables.

| Env var | SAM parameter | Default | What it does |
|---------|---------------|---------|--------------|
| `AFORO_ENDPOINT` | `AforoEndpoint` | `https://api.aforo.ai/v1/ingest/batch` (template) | Aforo ingestor batch URL. |
| `AFORO_API_KEY_SECRET_ARN` | `AforoApiKeySecretArn` (required) | — | Full ARN (with the six-character suffix, `…:secret:<name>-AbCdEf`; the template refuses a partial ARN because the IAM grant is for that exact ARN) of the Secrets Manager secret holding the Aforo API key, scope `usage:ingest`, as plain text or JSON `{"apiKey":"…"}`. Read once per container and refreshed every 5 minutes; a failed refresh keeps the last value. Until the first read succeeds, a failed read makes the next invocations fail fast for 5 s (doubling to 60 s, with jitter) instead of each waiting up to 3 s on Secrets Manager. Sent as `X-API-Key`, alone — no `Authorization` header (the ingestor answers 401 to one) and no `X-Tenant-Id`. The tenant is derived from the key. If the secret cannot be read on a cold start, the invocation fails and Lambda retries it (nothing is dropped). A 401 or 403 from the ingestor rereads the secret at once and resends the batch with the new key (a rotated key is in use within one invocation, not 5 minutes); still refused, the invocation fails and Lambda redelivers (2.5.1; before, the batch was dropped with a 200). |
| `AFORO_API_KEY` | `AforoApiKey` (must be empty) | — | The key as a plain environment variable. Used only when `AFORO_API_KEY_SECRET_ARN` is unset. Aforo's one-click deploy stops setting it with organization-service's W6 installer and aws-cloudformation 3.1.0: it stores the key in `aforo/metering/<function>` and removes this variable on the next deploy. The template refuses a non-empty `AforoApiKey` since 2.4.0. With neither set, every invocation fails rather than sending events without a key. |
| `METRIC_MAPPINGS` | `MetricMappings` | `[]` | JSON array of `{matchType, value, metricName}` rules, first match wins. `matchType` is `EXACT`, `PREFIX` or `CONTAINS` (plain string comparison). Invalid JSON, or an invalid rule, is logged and ignored. |
| `METRIC_NAME_PATTERN` | `MetricNamePattern` | *(empty)* | Route-shaped template (`{method}`, `{path}`, `{service}`=stage, `{route}`=resource). Applies only when set, to requests no mapping matches. Every resulting name must be a catalog metric, which route-shaped names rarely are. |
| `DEFAULT_METRIC` | `DefaultMetric` | `api_calls` | Metric for requests that neither a mapping nor the pattern names. |
| `QUANTITY_SOURCE` | `QuantitySource` | `1` | `1` = count, `response_size` = response bytes. An entry whose quantity is 0 (an empty 204, say) is skipped. |
| `PRODUCT_TYPE` | `ProductType` | `API` | `productType` sent on every event (trimmed, upper-cased; unknown values passed through). Two detections override it: an MCP `tools/call` with both `toolName` and `agentId` is sent as `MCP_SERVER`; and, when this is `API`, a request with a valid W3C `traceparent` (or an `x-trace-id`) is sent as `AGENTIC_API` with a top-level `traceId`. Any other configured value is kept as is. Entries missing the fields their type requires are skipped: `AI_AGENT`, `GRPC_API`, `GRAPHQL_API`, `WEBSOCKET_API` and `MQTT_BROKER` need fields an access log does not carry. |
| `EXCLUDE_STATUS_CODES` | `ExcludeStatusCodes` | `401,403,429` | Status codes that are not metered. A list replaces the default; `none` (or an empty value) meters every status. |
| `STATUS_OUTCOMES` | `StatusOutcomes` | *(empty)* | `executionStatus` overrides for OUTCOME_BASED pricing, e.g. `404=VALIDATION_FAILED,429=ERROR`. Exact codes 200–599; invalid entries are skipped with a warning; the last duplicate wins. |
| `CUSTOMER_ID_SOURCE` | `CustomerIdSource` | `consumer` | `consumer`: authorizer `customerId`, then IAM `caller`. `authorizer`: authorizer `customerId` only. Any other value (the long-removed `header` included) behaves as `authorizer` and logs a warning. |
| `FLUSH_COUNT` | `FlushCount` | `500` | Max events per POST (50 before 2.4.0). Capped at 1000: the ingestor rejects a larger batch with 400. |
| `INCLUDE_METADATA` | — (`true` in template) | `true` | Include request metadata in the event. `false` omits it. |
| `MCP_ENABLED` | — | `false` | Detect MCP JSON-RPC `tools/call` in a `requestBody` field of an access-log line. Records from `metering-proxy.js` carry their tool calls already and need no flag. |
| `MCP_METRIC` | `McpMetric` | *(empty → `DEFAULT_METRIC`)* | Metric for MCP tool-call events that no `METRIC_MAPPINGS` rule names. Up to 2.3.0 this was hard-coded `mcp_server.tool_invocations`; set that value to keep it. |
| `TOKEN_METRIC` | `TokenMetric` | `Tokens Consumed` | `AI_AGENT` only: metric of the second, per-call token event (quantity = input + output tokens) when a proxy record carries token usage. Empty turns it off. |
| `AFORO_TENANT_ID` | `AforoTenantId` | *(empty)* | Optional. Not sent to Aforo. It is part of the MCP idempotency key and a property on the EMF metrics; if you set it before 2.2.0, keep the same value. |

**Metric name precedence:** `METRIC_MAPPINGS` match → `METRIC_NAME_PATTERN` (if set) → `DEFAULT_METRIC`. The Lambda cannot see your catalog: a name that is empty or longer than 255 characters is dropped here (WARN log, EMF metric `EventsDroppedInvalidMetric`); any other name is sent, and the ingestor rejects an event whose metric is not registered — that event only, not the batch it travelled in. Rejected events show up in the log and in `EventsRejected`.

**Execution status mapping.** Every event carries `executionStatus` derived from the HTTP status: 2xx/3xx `SUCCESS`; 408, 504 `TIMEOUT`; 499 `CANCELLED`; 400, 422 `VALIDATION_FAILED`; 401, 403, 429 `BLOCKED`; every other 4xx/5xx `ERROR`; no determinable status → the field is omitted. `STATUS_OUTCOMES` overrides exact codes. An access log has no response body, so a JSON-RPC `error` inside a 200 reads as `SUCCESS`.

**Never metered:** `OPTIONS` (CORS preflights); entries with no customer identity; quantity ≤ 0; paths starting `/health`, `/ready`, `/metrics`, `/favicon.ico`; the status codes in `EXCLUDE_STATUS_CODES`.

`MCP_PRODUCT_ID` and `MARGIN_GUARD_*` are not read by `index.js`.

For `AI_AGENT` and `MCP_SERVER` products, see [USER_GUIDE.md](USER_GUIDE.md#ai-agent-and-mcp-server-metering-proxy): the `metering-proxy.js` integration logs the tool calls, tokens and sessions an access log cannot see.

## Delivery

Batches are sent concurrently under one deadline taken from the Lambda's remaining time (minus 1.5 s), so retries cannot run past the function timeout.

| Layer | Handles | Window |
|---|---|---|
| In-handler retries | Network errors, 5xx, 408, 429 | 3 attempts, 1 s then 2 s backoff. On 429 the `Retry-After` header sets the wait; one longer than 30 s, or longer than the time left, ends the attempts. |
| Lambda async retry | A batch still failing transiently — the handler **throws**, so the same log events are redelivered | 2 retries (`MaximumRetryAttempts: 2`), events up to 6 hours old |
| OnFailure SQS queue (SAM template only) | Async retries also exhausted | Failed invocation record kept **14 days**, replayable |

A **permanent rejection** — any 4xx other than 408/429 — is not retried and does not throw: the same bytes would get the same answer. The batch is dropped, the response body is logged, and `EventsRejected` is emitted. The same applies to individual events the ingestor rejects inside an accepted batch (read from `data.errors` in the `{success, data, meta}` response).

**Why throwing does not double-bill:** every `idempotencyKey` is built from log data only — the entry's `requestId`, or the CloudWatch log-event id when the format has none; for MCP events `mcp:<AFORO_TENANT_ID>:<requestId>:<toolName>:<log timestamp>`. Nothing from the time of execution feeds a key, and the request body is serialized once per batch, so every retry and every redelivery carries identical keys and the ingestor deduplicates — including batches that had already landed before the failing one.

## Alarms

Custom metrics are written in CloudWatch Embedded Metric Format — no SDK, no extra IAM. Namespace `Aforo/Metering`, dimension `Gateway=aws-api-gateway`.

| Signal | Meaning |
|---|---|
| `EventsFailedToSend` | Events in an invocation that ended in a transient failure. Emitted before each throw, so it fires while retries are still pending. |
| `EventsRejected` | Events dropped after a permanent 4xx or a per-event rejection. Usually a wrong API key, an unregistered metric or an unknown customer. |
| `EventsDroppedInvalidMetric` | Events whose resolved metric name was empty or over 255 characters. |
| `ApproximateNumberOfMessagesVisible` on `aforo-metering-failures` | In-handler and async retries all exhausted; that batch is undelivered until you replay it. Alarm at `> 0`. |
| Lambda `Errors` | Each throw increments it. |

## Replaying from the failure queue

Each SQS message is a [Lambda async failure record](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html#invocation-async-destinations) whose `requestPayload` is the original CloudWatch Logs event. To replay, re-invoke the function with that payload:

```bash
aws sqs receive-message --queue-url <FailureQueueUrl> --max-number-of-messages 1 \
  | jq -r '.Messages[0].Body' | jq '.requestPayload' > event.json
# --cli-binary-format is required on AWS CLI v2, which otherwise expects
# a base64-encoded payload and rejects the raw JSON file.
aws lambda invoke --function-name aforo-metering \
  --invocation-type Event --cli-binary-format raw-in-base64-out \
  --payload file://event.json /dev/null
# delete the SQS message only after the replay invocation succeeds
```

A replay rebuilds the same keys from the same log data, so replaying a batch that partly landed bills nothing twice.

## Compound metering and preflight helpers

`compound-metering.js` and `preflight-quota.js` are modules for your own Lambda code (an authorizer or an integration); the metering function does not call them.

```js
const c = require('./compound-metering');
const event = c.buildCompoundEvent(customerId, measurements, metadata, requestId /* seed */, 'AI_AGENT');
```

The 4th argument is the correlation seed — pass the request's stable id. `correlationId` is a UUID derived from it, so a retried or redelivered event keeps the same id (the server derives every per-metric dedup key from it). Without a seed (and without `metadata.requestId`) the id is random and a redelivery can double-bill; the module warns. For code written against 2.1.0, where the 4th argument was the productType: a 4th argument that is exactly a known productType, with no 5th argument, is still read as the productType. An options object `{ correlationSeed, productType }` also works. No `customerId`, or one over 64 characters, returns `null`. Compound events carry no `executionStatus`.

Both modules authenticate with `X-API-Key` only. `preflight-quota.js` reads the decision from the response's `data` field.

`preflight-quota.js` (`checkPreFlightQuota(config, customerId, metricName)`):

| `config` field | Default | |
|---|---|---|
| `preflightUrl` | — | `https://…/api/v1/quota/check`. Not https → fallback. |
| `apiKey` | — | Sent as `X-API-Key`. Missing → fallback. |
| `timeoutMs` | `250` | Whole request, including a cold TLS handshake. Was 50. |
| `preflightFallback` | `ALLOW` | Decision on timeout, network error, non-2xx status or a body without `ALLOW` / `WARN` / `DENY`. Not cached. |
| `tenantId` | — | Optional; only scopes the local cache. |
| `allowCacheTtlMs` | `1000` | How long an `ALLOW` / `WARN` is reused. |
| `cacheMaxEntries` | `5000` | Least recently used entries are dropped. |

Cache entries are keyed by a fingerprint of `apiKey`, `tenantId`, the customer and the metric, so one workspace's `DENY` is never returned for another's key. A `DENY` is reused until the server's `retryAfterMs`, at most 60 s (a wallet top-up unblocks within a minute), or 5 s when the server sent none; a cached `DENY` reports the wait that is left. `build429Response` sets `Retry-After` to `retryAfterMs` rounded up to whole seconds, at least 1. Connections are kept alive between calls.

`margin-guard.js` (`checkMarginGuard(customerId, config)`): calls pricing's `GET /api/v1/margin-guard/quick-check` with `X-API-Key: config.apiKey` (no key → no call, allowed). `marginGuardTimeoutMs` (default 200), `marginGuardCacheTtlMs` (30000; `BLOCK` and a plain `ALLOW` only), `marginGuardCacheMaxEntries` (10000, least recently used dropped). Cache entries are keyed by a fingerprint of the API key and the customer id. Fails open on any error or a body without `verdict`; failures are not cached.

## Walk me through it

Step by step from `sam deploy` to a verified event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Blocking a request.** This Lambda runs after the response was served. For quota or margin enforcement, deploy `authorizer.js` (needs `AFORO_TENANT_ID` since 2.5.0) / `margin-guard.js` as an API Gateway Lambda Authorizer (see [AUTHORIZER.md](AUTHORIZER.md)).
- **Routes with only an API Gateway API key.** A usage-plan key alone gives no customer identity this function will use (the key value is a secret). Put an Aforo authorizer on the route (`key-authorizer.js` accepts the customer's Aforo key directly), or use IAM authorization.
- **Outages longer than the retry window.** `MaximumEventAgeInSeconds: 21600` bounds async retries at 6 hours; past that the record goes to the failure queue (SAM deploy) or is lost (one-click deploy, which has no queue).
- **gRPC, GraphQL, WebSocket.** An access log does not carry the fields those product types need.
- **A live run of the failure paths.** The suites run against a stubbed transport and a local HTTP server. The 2.3.0 changelog records one live production run of the happy path on 2026-10-16 (REST stage → `key-authorizer.js` → access log → `index.js` → ingestor); retries on a 5xx from the ingestor, the 6-hour async-retry window and the failure queue have not been exercised on a real stage.

## Tests

```bash
npm test
```

Runs `tests/authorizer.test.js` (JWT authorizer: tenant pin and required issuer, revocation fails closed, TLS + AUTH, stage-scoped Allow, JWKS refetch limit), `tests/guards.test.js` (`margin-guard.js`, `preflight-quota.js`), `../aws-cloudformation/tests/templates.test.cjs`, `tests/agent-mcp.test.js` (AI_AGENT / MCP events from proxy records), `tests/metering-proxy.test.js`, `tests/key-authorizer.test.js`, `tests/key-authorizer-jwt.test.js`, `tests/handler.test.js` (delivery, EMF metrics, key stability across redelivery, AGENTIC_API detection, compound `correlationId`, execution status) and `tests/contract.test.js` (wire contract against a local capture server: auth header, identity, metric mappings and precedence, `PRODUCT_TYPE`, `Retry-After`, deadline).
