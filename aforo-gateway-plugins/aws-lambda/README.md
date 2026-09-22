# aforo-metering-lambda

An AWS Lambda function that subscribes to API Gateway CloudWatch access logs, parses each entry, and batch-POSTs usage events to Aforo. It runs off the log stream asynchronously, so it adds nothing to your request path.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

> Version lives in [`package.json`](package.json) (`"version": "2.0.0"`). It matches the version stated here and in the changelog.

## Install

When you front your APIs with AWS API Gateway and want usage metered into Aforo without touching your integrations, deploy this Lambda and subscribe it to the API Gateway access-log group.

Intended deployment (this is a private, SAM-deployed function — there is no public registry package):

```bash
sam deploy --guided
```

> **Not a public release — deploy from source.** `package.json` is `"private": true`; the function is distributed as the SAM template + `index.js` in this folder, not as an npm package.

From source:

```bash
# 1. Clone the distribution repo
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/aws-lambda

# 2. Build and deploy with SAM (template.yaml is in this folder)
sam build
sam deploy --guided \
  --parameter-overrides \
    AforoEndpoint=https://api.aforo.ai/v1/ingest/batch \
    AforoApiKey="$AFORO_API_KEY" \
    DefaultMetric=api_calls \
    ApiGatewayLogGroupName=/aws/apigateway/aforo-access-logs
```

The template creates the function, the `lambda:InvokeFunction` permission for CloudWatch Logs, and a `SubscriptionFilter` (empty filter pattern = all entries) on the named log group.

> ⚠ This Lambda parses **API Gateway access logs**, not the gateway request itself. You must have access logging enabled on your API stage, emitting **JSON** to the log group you pass as `ApiGatewayLogGroupName`, in the format below.

### Access-log format (required)

Customer identity comes **only** from the Aforo Lambda Authorizer's context (`authorizer.js` sets `customerId` from the verified JWT's `customer_id` claim — see [AUTHORIZER.md](AUTHORIZER.md)). Routes that are not behind that authorizer produce no `customerId` and are **not metered** (the entry is skipped and counted in the Lambda log). The raw API key (`$context.identity.apiKey`) is a secret and is never used or logged; the client IP is never used either.

```json
{"requestId":"$context.requestId","httpMethod":"$context.httpMethod","resourcePath":"$context.resourcePath","status":"$context.status","responseLatency":"$context.responseLatency","responseLength":"$context.responseLength","stage":"$context.stage","customerId":"$context.authorizer.customerId","keyId":"$context.authorizer.keyId"}
```

- REST APIs and HTTP APIs with a Lambda authorizer: `$context.authorizer.customerId` as above.
- HTTP APIs with a native JWT authorizer instead: use `"customerId":"$context.authorizer.claims.customer_id"` (unverified here — test against your stage).
- The CLF fallback parser still parses entries but CLF carries no customer, so CLF entries are never metered.

Metric mappings match against the logged `resourcePath` (for REST APIs this is the resource template, e.g. `/v1/users/{id}`); log `$context.path` as `path` and drop `resourcePath` if you want to match concrete paths.

## Quickstart

The values every deployment needs map to SAM parameters / Lambda env vars — `AforoEndpoint`, `AforoApiKey` (the tenant is derived from the key; there is no tenant id setting), and a `DefaultMetric` that exists in your Aforo catalog:

```bash
sam deploy \
  --parameter-overrides \
    AforoEndpoint=https://api.aforo.ai/v1/ingest/batch \
    AforoApiKey="$AFORO_API_KEY" \
    DefaultMetric=api_calls \
    MetricMappings='[{"matchType":"PREFIX","value":"/v1/sms","metricName":"sms_sent"}]' \
    ApiGatewayLogGroupName=/aws/apigateway/aforo-access-logs
```

Send a request through your API Gateway stage, wait for the access log to flush to CloudWatch, then check the Lambda's logs for `Sent N/N events to Aforo`.

## Configuration

The function reads everything from environment variables (set by the SAM template). `AFORO_ENDPOINT` defaults to the real ingestor URL in the template.

| Env var | SAM parameter | Default | What it does |
|---------|---------------|---------|--------------|
| `AFORO_ENDPOINT` | `AforoEndpoint` | `https://api.aforo.ai/v1/ingest/batch` | Aforo ingestor batch URL. |
| `AFORO_API_KEY` | `AforoApiKey` | — | Aforo API key, scope `usage:ingest`. Sent as `X-API-Key` (alone — an `Authorization: Bearer` header makes the ingestor answer 401). The tenant is derived from the key. |
| `METRIC_MAPPINGS` | `MetricMappings` | `[]` | JSON array of `{matchType, value, metricName}` rules, first match wins. `matchType` is `EXACT`, `PREFIX` or `CONTAINS` (plain string comparison — same semantics as catalog's `/internal/v1/metrics/gateway-mappings`, which Kong fetches; this Lambda takes the table as config). Invalid JSON is logged and ignored. |
| `DEFAULT_METRIC` | `DefaultMetric` | `api_calls` | Metric for requests no mapping matches. **Must be registered in the Aforo catalog** — an unknown metric fails the whole batch with 400. |
| `METRIC_NAME_PATTERN` | `MetricNamePattern` | *(empty)* | Legacy route-shaped template (`{method}`, `{path}`, `{service}`=stage, `{route}`=resource). Used only when set; every resulting name must be a catalog metric, which route-shaped names almost never are. |
| `QUANTITY_SOURCE` | `QuantitySource` | `1` | `1` = count, `response_size` = response bytes. Entries whose quantity is 0 (e.g. an empty 204) are skipped — the ingestor requires quantity > 0. |
| `FLUSH_COUNT` | — (set to `50` in template) | `50` | Max events per POST batch. Capped at 1000: the ingestor rejects a larger batch with 400. |
| `INCLUDE_METADATA` | — (set to `true` in template) | `true` | Include request metadata in the event. Set to `"false"` to omit. |
| `PRODUCT_TYPE` | `ProductType` | `API` | `productType` sent on every event (trimmed, upper-cased; unknown values passed through) — required by the ingestor. MCP `tools/call` with both `toolName` and `agentId` is sent as `MCP_SERVER`, otherwise keeps this value. Entries missing the fields their type requires are skipped: `AI_AGENT`/`GRPC_API`/`GRAPHQL_API`/`WEBSOCKET_API`/`MQTT_BROKER` need fields an access log does not carry or that cannot be trusted (an agentId from `x-agent-id` is client-settable). |
| `MCP_ENABLED` | — | `false` | Detect MCP JSON-RPC `tools/call` in the logged request body and emit `mcp_server.tool_invocations`. |

Removed: `AFORO_TENANT_ID` / `AforoTenantId` (the ingestor ignores tenant headers; the tenant comes from the key) and `CUSTOMER_ID_SOURCE` / `CustomerIdSource` (identity now comes only from the authorizer context). `MCP_PRODUCT_ID` and `MARGIN_GUARD_*` were never read by `index.js` and are no longer documented here.

Never metered: `OPTIONS` (CORS preflights); entries with no `customerId` or one longer than 64 characters; quantity ≤ 0; paths `/health`, `/ready`, `/metrics`, `/favicon.ico`; status codes `401`, `403`, `429` (hardcoded in `index.js`).

## Walk me through it

Step-by-step from `sam deploy` to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Margin-guard enforcement does not block requests here.** This Lambda processes CloudWatch Logs after the fact and cannot reject a live call. For real-time L2/L3 enforcement, deploy the separate `margin-guard.js` / `authorizer.js` module as an API Gateway Lambda Authorizer (see `AUTHORIZER.md` in this folder). `MARGIN_GUARD_*` env vars on this metering function are informational only.
- **Delivery.** Batches are sent concurrently under one deadline derived from the Lambda's remaining time. Each is retried up to 3x with exponential backoff on 5xx, 408, 429 and transport errors; on 429 the `Retry-After` header is honoured (a wait over 30 s ends the attempts and the batch fails transiently). Any other 4xx is a permanent rejection: the batch is dropped and the response body logged (retrying would send identical bytes to the same judgement). If a batch still fails transiently, the handler **throws**, so Lambda's async-invocation retry (`MaximumRetryAttempts: 2` in the template) re-delivers the whole log batch; stable `idempotencyKey`s (API Gateway `requestId`) let already-delivered events deduplicate. After Lambda's retries are exhausted the batch is lost unless you configure an on-failure destination/DLQ.
- **It bills from access logs, not the gateway internals.** Customer attribution depends entirely on the access-log format above and on the route using the Aforo authorizer.
- **Not verified against a live API Gateway.** The unit/handler tests run against a local HTTP server; the access-log `$context` variables and the async-retry behaviour have not been exercised on a real stage.
