# aforo-metering-lambda — User Guide

**Version:** 2.4.0 · **Updated:** 2026-10-27 · **Audience:** engineers running AWS API Gateway who want API usage metered into Aforo from CloudWatch access logs.

## What you'll build

A Lambda subscribed to your API Gateway access-log group. Each batch of log entries is parsed into Aforo usage events and POSTed to the ingestor. Because it runs off the log stream, the request path is untouched. By the end you'll see events land in Aforo with method, path, status, and latency.

## Prerequisites

- AWS API Gateway with **access logging enabled** on the stage, emitting **JSON** entries to a CloudWatch log group. Access logging needs the account-level CloudWatch Logs role (API Gateway → Settings → *CloudWatch log role ARN*, policy `AmazonAPIGatewayPushToCloudWatchLogs`); set it once per account and region.
- AWS SAM CLI authenticated to the target account/region.
- An Aforo API key with scope `usage:ingest` (the tenant is derived from the key — there is no tenant id setting). Events go to `https://api.aforo.ai/v1/ingest/batch` (override `AforoEndpoint`).
- Node.js 24 runtime is set in the template (`nodejs24.x`, since 2.5.0; `nodejs20.x` is deprecated and AWS blocks creating functions on it from 2027-02-01).
- A verified customer identity on every route you want metered: an **Aforo authorizer** (see [AUTHORIZER.md](AUTHORIZER.md)): `key-authorizer.js`, which checks the customer's Aforo key (`sk_live_…`, issued when they subscribe) with Aforo, or `authorizer.js`, which verifies an Aforo JWT (set `AFORO_TENANT_ID` to your workspace id; tokens of any other workspace are denied). Or IAM authorization, where the IAM caller is the customer. Routes with none are not metered.
- The metric(s) you will bill against already registered in the Aforo catalog (at minimum the `DefaultMetric`, `api_calls` by default). The ingestor rejects an event whose metric is not registered — that event, not the whole batch — and the Lambda logs it and counts it in `EventsRejected`.

## Step 1 — Enable JSON access logging on your API stage

Set your stage's access-log format to JSON with at least these fields:

```json
{"requestId":"$context.requestId","httpMethod":"$context.httpMethod","resourcePath":"$context.resourcePath","status":"$context.status","responseLatency":"$context.responseLatency","responseLength":"$context.responseLength","stage":"$context.stage","customerId":"$context.authorizer.customerId","keyId":"$context.authorizer.keyId","subscriptionId":"$context.authorizer.subscriptionId","caller":"$context.identity.caller"}
```

> ⚠ `customerId` must come from `$context.authorizer.customerId` — the value an Aforo authorizer derives from the customer's key or JWT. Do **not** log `$context.identity.apiKey`: it is the API key itself (a secret), not an Aforo customer id, and this Lambda does not read it. `caller` is used only for IAM-authorized routes, when `customerId` is missing. Entries with neither (value missing or `-`) are skipped and counted in the Lambda log as `no customerId`.

> ⚠ Metric mappings match the logged path. With this format that is `resourcePath`, the resource template (for example `/v1/users/{id}`). To match concrete paths instead, log `"path":"$context.path"` **and remove `resourcePath`**: the function reads `resourcePath` first and uses `path` only when `resourcePath` is absent.

## Step 2 — Deploy the function from source

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
    MetricMappings='[{"matchType":"PREFIX","value":"/v1/sms","metricName":"sms_sent"}]' \
    ApiGatewayLogGroupName=/aws/apigateway/aforo-access-logs
```

`--guided` walks you through stack name, region, and saves an `samconfig.toml` so later deploys are just `sam deploy`.

> ⚠ Set `ApiGatewayLogGroupName` to the **exact** log group your stage writes to. The template creates a `SubscriptionFilter` on that group that forwards only lines containing `customerId`, `caller` or `aforoUsage` (`AccessLogFilterPattern`); if it points at the wrong group, the Lambda never fires.

## Step 3 — Confirm the subscription filter

The template wires the `lambda:InvokeFunction` permission and the subscription filter for you. Verify:

```bash
aws logs describe-subscription-filters \
  --log-group-name /aws/apigateway/aforo-access-logs
```

You should see `aforo-metering-filter` pointing at the `aforo-metering` function ARN.

## Step 4 — Send a request through your API

```bash
curl -H "Authorization: Bearer $AFORO_ISSUED_JWT" \
  "https://$API_ID.execute-api.$REGION.amazonaws.com/$STAGE/anything"
```

API Gateway writes the access-log entry, CloudWatch batches it, and invokes the Lambda. There's a short delay (log flush + subscription delivery) — expect seconds, not instant.

## Step 5 — Verify it landed in Aforo

Tail the Lambda's own CloudWatch logs:

```bash
sam logs --name aforo-metering --tail
```

A successful run logs:

```
Processing 1 log events from /aws/apigateway/aforo-access-logs
Sent 1/1 events to Aforo
```

A skipped/filtered run logs `No usage events after filtering` plus a `Skipped: {...}` breakdown (e.g. `OPTIONS`, `no customerId`, `excluded path`). A permanently rejected batch logs:

```
Aforo rejected the batch with 400 — dropping N event(s). Response: {...}
```

and a batch that still fails transiently after retries fails the invocation (so Lambda redelivers it; idempotency keys are stable, so nothing is billed twice):

```
Batch of N event(s) not delivered (transient failure or Lambda deadline) — the invocation will be redelivered
```

Then confirm the event under the matching customer + metric (`api_calls` unless a mapping matched) in your Aforo usage view.

## Step 6 (optional) — MCP tool-invocation metering

Set `MCP_ENABLED=true` on the function. For POST entries whose logged `requestBody` is JSON-RPC `2.0` with `method: "tools/call"`, the event's metric is the first matching `METRIC_MAPPINGS` rule, else `MCP_METRIC`, else `DEFAULT_METRIC` (up to 2.3.0 it was always `mcp_server.tool_invocations`; set `MCP_METRIC` to that to keep it), carrying `toolName`, `agentId`, and `executionStatus` (from the HTTP status, same table as every other event), with `productType: "MCP_SERVER"` when both `toolName` and `agentId` are known (otherwise it keeps `PRODUCT_TYPE`, default `API`, which every other event carries).

```bash
aws lambda update-function-configuration \
  --function-name aforo-metering \
  --environment "Variables={AFORO_ENDPOINT=https://api.aforo.ai/v1/ingest/batch,AFORO_API_KEY_SECRET_ARN=$AFORO_API_KEY_SECRET_ARN,DEFAULT_METRIC=api_calls,MCP_ENABLED=true}"
```

> ⚠ MCP detection needs the request body in the access log (`requestBody`). API Gateway does not log bodies, so in practice use the metering proxy below, which sees the body itself.
> ⚠ `agentId` comes only from the JSON-RPC payload at `params._meta.agent_id`. There is no header fallback — that path was removed in 2.0.0 as a spoof vector.

## AI Agent and MCP Server (metering proxy)

An access log cannot see a request body or the upstream's response, so it cannot tell which MCP tool was called or how many tokens an agent used. For `AI_AGENT` and `MCP_SERVER` products, put `metering-proxy.js` between API Gateway and your upstream:

```
agent / MCP client ── Bearer <JWT> ──► API Gateway ── aforo-key-authorizer (JWT verified)
                                            │
                                            ▼ Lambda proxy integration (AWS_PROXY)
                                   aforo-metering-proxy ──► your upstream (UPSTREAM_URL or UPSTREAM_FUNCTION)
                                            │ one {"aforoUsage":1,...} line per call
                                            ▼ subscription filter "aforoUsage"
                                      aforo-metering ──► Aforo ingestor
```

### 1. Client credentials

The customer exchanges its client credentials for a 15-minute RS256 JWT and sends it on every call:

```bash
TOKEN=$(curl -s -X POST https://org.aforo.ai/oauth/token \
  -d grant_type=client_credentials -d client_id=$CLIENT_ID -d client_secret=$CLIENT_SECRET | jq -r .access_token)
curl -H "Authorization: Bearer $TOKEN" -H "x-session-id: run-42" https://<api>/prod/v1/messages -d '{...}'
```

Deploy `key-authorizer.js` with `AFORO_TENANT_ID` set to your tenant id (see [AUTHORIZER.md](AUTHORIZER.md#client-credential-jwts-ai-agent-and-mcp-server-customers)). Its context carries `customerId`, `keyId`, `subscriptionId`, `agentId` (the token's `agent_id` claim). That `agentId` is the only agent id `AI_AGENT` billing trusts; client headers such as `X-Agent-Id` are never used.

### 2. The proxy integration

With SAM, set `UpstreamUrl` (or `UpstreamFunction`) and `DeployKeyAuthorizer=true`, `AuthorizerTenantId=<tenant id>`, plus `AforoTenantKeySecretArn=<secret ARN>` to accept `sk_live_`/`sk_test_` customer keys (store the tenant key with `aws secretsmanager create-secret` first; without it the authorizer accepts JWTs only). The stack creates `aforo-metering-proxy`, its log group `/aws/lambda/aforo-metering-proxy`, and a subscription filter from that log group to `aforo-metering`. Then on your REST API, set each metered method (or `ANY /{proxy+}`) to:

- Authorization: `CUSTOM`, the `aforo-key-authorizer` TOKEN authorizer (identity source `method.request.header.Authorization`).
- Integration: Lambda proxy (`AWS_PROXY`) to `aforo-metering-proxy`.

| Variable (proxy) | Default | |
|---|---|---|
| `UPSTREAM_URL` | — | HTTP(S) base URL. The request path (`event.path`) and query are appended; method, headers and body are forwarded. |
| `UPSTREAM_FUNCTION` | — | Lambda name/ARN, used when `UPSTREAM_URL` is empty. Invoked synchronously with the API Gateway proxy event; must return a proxy response (`statusCode`, `headers`, `body`, `isBase64Encoded`). |
| `UPSTREAM_TIMEOUT_MS` | `25000` | Upstream error or timeout → `502` to the client, recorded with status 502. |
| `UPSTREAM_FORWARD_AUTH` | `false` | `true` forwards the client's `Authorization` header. By default it is removed: it is an Aforo credential. |

The upstream receives `X-Aforo-Customer-Id` and `X-Aforo-Agent-Id` from the authorizer context; any `X-Aforo-*` header the client sent is removed first. The response (status, headers, body, `isBase64Encoded`) goes back to the client unchanged. Binary responses are returned base64-encoded, so add their media types to the API's `binaryMediaTypes`.

Do not also subscribe an access log of the same stage to `aforo-metering`: both carry the same `requestId`, so the ingestor would keep whichever arrived first.

### 3. The metering function

| Variable (aforo-metering) | |
|---|---|
| `PRODUCT_TYPE` | `AI_AGENT` for agent products. MCP tool calls become `MCP_SERVER` automatically when both `toolName` and `agentId` are known. |
| `DEFAULT_METRIC` / `METRIC_MAPPINGS` | The per-call metric (quantity 1). |
| `MCP_METRIC` | Metric for MCP tool calls no mapping names (default `DEFAULT_METRIC`). |
| `TOKEN_METRIC` | `AI_AGENT`: metric of the token event (default `Tokens Consumed`; empty turns it off). |

Per record, `aforo-metering` emits:

- **AI_AGENT**: one call event (`agentId` from the record, `sessionId` = record `sessionId` else `requestId`, `traceId` when present, `sessionBoundary: SESSION_END` when signalled, key `<requestId>`), plus, when the record has tokens, a token event: `metricName` = `TOKEN_METRIC`, `quantity` = input + output tokens, `metadata.input_tokens / output_tokens / model_name / model_provider`, key `<requestId>:tokens`. A record without an `agentId` is skipped (`productType AI_AGENT missing agentId`).
- **MCP**: one event per `tools/call` (a JSON-RPC batch gives several), key `<requestId>:mcp:<index>`, `toolName`, `agentId` (authorizer first, else `params._meta.agent_id`).
- An `x-trace-id` in AWS X-Ray form (`Root=1-…;Parent=…`) is reduced to the root id.

### Usage record format

One line of JSON per call on the proxy's stdout (no Lambda prefix; a prefixed line is also accepted):

```json
{"aforoUsage":1,"requestId":"c0ffee-…","httpMethod":"POST","resourcePath":"/{proxy+}","path":"/v1/messages",
 "status":200,"responseLatency":412,"responseLength":1834,"stage":"prod",
 "customerId":"cust_1","keyId":"key_1","subscriptionId":"sub_1","agentId":"agent_7",
 "requestHeaders":{"traceparent":"00-…-01","x-session-id":"run-42"},
 "sessionId":"run-42","sessionBoundary":"SESSION_END",
 "mcp":[{"toolName":"search","agentId":"agent_7"}],
 "tokens":{"input":250,"output":60,"model":"claude-sonnet-4-6","provider":"anthropic"}}
```

`customerId`, `keyId`, `subscriptionId`, `agentId` come only from `event.requestContext.authorizer`. `requestHeaders` holds only `traceparent`, `tracestate`, `x-trace-id`, `x-request-id`, `x-session-id` (lower-cased). `sessionId`, `sessionBoundary`, `mcp`, `tokens` appear only when known. Request and response bodies and the `Authorization` header are never logged; a body that cannot be parsed changes nothing for the client.

### Upstream contract

To bill tokens, the upstream reports usage in either form (headers win):

- Response headers `x-aforo-input-tokens`, `x-aforo-output-tokens`, and optionally `x-aforo-model`, `x-aforo-model-provider`; or
- A JSON response body with `usage.input_tokens` / `usage.output_tokens` (Anthropic shape) or `usage.prompt_tokens` / `usage.completion_tokens` (OpenAI shape), and `model`. Bodies over 1 MB and streamed (SSE) responses are not inspected.

Sessions: the client's `x-session-id` request header names the session; when it sends none, the upstream may return `x-aforo-session-id`. `x-aforo-session-end: true` on the response, or `x-session-end: true` on the request, marks the call as `SESSION_END`.

MCP: send JSON-RPC 2.0 `tools/call` requests (single or batch) as the POST body; `params.name` is the tool.

## Configuration reference

Full env-var / SAM-parameter table is in [README.md](README.md#configuration). You must set `AforoApiKeySecretArn` (`AforoEndpoint` defaults to `https://api.aforo.ai/v1/ingest/batch`), and make sure `DefaultMetric` (and every `MetricMappings` metric) exists in your catalog.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Lambda never invokes | Subscription filter on the wrong log group, or access logging disabled | Enable JSON access logging on the stage; confirm `ApiGatewayLogGroupName` matches and the filter exists (`aws logs describe-subscription-filters`). |
| `No usage events after filtering` every run | All entries hit the exclude list, or the parser couldn't read them | Check the access-log format is JSON; confirm the calls aren't `/health`-style paths or a status in `EXCLUDE_STATUS_CODES` (default `401,403,429`). |
| `Skipped: {"no customerId":N}` | Access-log format lacks `customerId`, or the route is not behind the Aforo authorizer. After upgrading from a pre-2.1.0 build: the format still relies on `apiKey`, which is no longer read | Add `"customerId":"$context.authorizer.customerId"` to the format (Step 1) and attach the authorizer; for IAM routes log `"caller":"$context.identity.caller"`. |
| `Aforo rejected the batch with 401` | Wrong key in the secret, or something added an `Authorization` header | The key is sent only as `X-API-Key`; check the secret's value and that the key has scope `usage:ingest`. |
| `could not read AFORO_API_KEY_SECRET_ARN from Secrets Manager: … AccessDeniedException` | The function's role cannot read the secret, or a customer-managed KMS key is not passed | Deploy with the template (it grants `secretsmanager:GetSecretValue` on that ARN), and pass `SecretsKmsKeyArn` when the secret uses your own KMS key. |
| `could not read … from Secrets Manager` on every invocation for a few seconds after a first failure | After a failed first read the function fails fast for 5 s (doubling to 60 s) rather than calling Secrets Manager each time | Fix the permission or the endpoint; the next attempt after the backoff picks it up. |
| `authorizer.js` denies every call with `TENANT_NOT_CONFIGURED`, or `TENANT_MISMATCH` in the log | `AFORO_TENANT_ID` is unset, or the token was issued for another Aforo workspace | Set `AFORO_TENANT_ID` to your workspace id; tokens must be issued for that workspace. |
| `Parameters: [AforoApiKeySecretArn] must have values` or the `NoPlaintextAforoKeys` rule fails | Upgrading a stack deployed before 2.4.0 | Create the secret and redeploy with `AforoApiKeySecretArn=<arn> AforoApiKey=''` (CHANGELOG 2.4.0, "Upgrade"). |
| `Aforo rejected the batch with 400` | A malformed batch | The response body in the log names the field. The batch is dropped, not retried. |
| `Aforo accepted the batch but rejected N event(s)` | An unregistered metric name, or a `customerId` that is not an Aforo customer | Register the metric / fix `METRIC_MAPPINGS` / `DEFAULT_METRIC`; check the JWT's `customer_id` claim. The log line lists each rejected event's reason. |
| Events named `GET /v1/...` are rejected | `METRIC_NAME_PATTERN` is set (Aforo's one-click deploy sets it from the connection's metric pattern) | Clear it and use `METRIC_MAPPINGS` + `DEFAULT_METRIC`. |
| A status you expected is missing | It is in `EXCLUDE_STATUS_CODES` | Set the list you want, or `none` to meter every status. |
| `... not delivered (transient failure or Lambda deadline)` | Ingestor unreachable, 5xx/408/429 for the whole retry window | The invocation fails and Lambda retries it twice; after that the record is in the `aforo-metering-failures` SQS queue for 14 days (SAM deploy) — replay it as shown in the README. |
| `MCP_ENABLED=true` but no MCP events | Request body not present in the access log | API Gateway doesn't log bodies; use the metering proxy (AI Agent and MCP Server section). |
| `Skipped: {"productType AI_AGENT missing agentId …":N}` | The authorizer context has no `agentId` | The client-credential JWT carries no `agent_id` claim, or the route uses a customer key. Client headers are never used as the agent id. |
| Proxy calls answered but no events | Proxy log group not subscribed, or the subscription filter pattern is a JSON pattern | The SAM stack subscribes `/aws/lambda/aforo-metering-proxy` with the term pattern `"aforoUsage"`; check `aws logs describe-subscription-filters`. |
| Margin-guard env vars set but nothing blocks | This Lambda is async and informational for margin guard | Deploy the Lambda Authorizer (`AUTHORIZER.md`) for real-time enforcement; the metering function can't block live calls. |

## What this guide does NOT cover

- **The Lambda Authorizer** (`authorizer.js` + `AUTHORIZER.md` in this folder) — that's the real-time JWT validation + L2/L3 enforcement path, deployed separately as an API Gateway authorizer. This guide covers metering only.
- **Access-log format design** beyond the minimum fields — your full `$context` format is your stage configuration.
- **Delivery past the retry window.** 3 in-invocation attempts, then Lambda's async retry, then the SQS failure queue the SAM template creates (14 days). Aforo's one-click deploy has no failure queue. Alarms and replay are in the README.
- **Live verification of the failure paths.** The 2.3.0 changelog records one live production run on 2026-10-16 of the happy path (REST stage → `key-authorizer.js` → access log → this function → ingestor). Retries, the async-retry window and the failure queue have not been exercised on a real stage; see the README's "What this doesn't cover".
