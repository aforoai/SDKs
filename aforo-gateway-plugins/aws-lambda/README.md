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
    AforoEndpoint=https://ingest.aforo.ai/v1/ingest/batch \
    AforoApiKey="$AFORO_API_KEY" \
    AforoTenantId="$AFORO_TENANT_ID" \
    ApiGatewayLogGroupName=/aws/apigateway/aforo-access-logs
```

The template creates the function, the `lambda:InvokeFunction` permission for CloudWatch Logs, and a `SubscriptionFilter` (empty filter pattern = all entries) on the named log group.

> ⚠ This Lambda parses **API Gateway access logs**, not the gateway request itself. You must have access logging enabled on your API stage, emitting to the log group you pass as `ApiGatewayLogGroupName`. The parser reads JSON access-log entries best (it also has a CLF fallback) — configure your stage's access-log format as JSON so fields like `requestId`, `status`, `responseLatency`, and `identity.apiKey` are present.

## Quickstart

The three values every Aforo artifact needs map to SAM parameters / Lambda env vars — `AforoEndpoint`, `AforoApiKey`, `AforoTenantId`:

```bash
sam deploy \
  --parameter-overrides \
    AforoEndpoint=https://ingest.aforo.ai/v1/ingest/batch \
    AforoApiKey="$AFORO_API_KEY" \
    AforoTenantId="$AFORO_TENANT_ID" \
    ApiGatewayLogGroupName=/aws/apigateway/aforo-access-logs
```

Send a request through your API Gateway stage, wait for the access log to flush to CloudWatch, then check the Lambda's logs for `Sent N/N events to Aforo`.

## Configuration

The function reads everything from environment variables (set by the SAM template). `AFORO_ENDPOINT` defaults to the real ingestor URL in the template.

| Env var | SAM parameter | Default | What it does |
|---------|---------------|---------|--------------|
| `AFORO_ENDPOINT` | `AforoEndpoint` | `https://ingest.aforo.ai/v1/ingest/batch` | Aforo ingestor batch URL. |
| `AFORO_API_KEY` | `AforoApiKey` | — | Aforo API key. Sent as `Authorization: Bearer <key>` on the POST. |
| `AFORO_TENANT_ID` | `AforoTenantId` | — | Aforo tenant identifier. Sent as the `X-Tenant-Id` header on the POST. |
| `METRIC_NAME_PATTERN` | `MetricNamePattern` | `{method} {path}` | Metric-name template. Variables: `{method}`, `{path}`, `{service}` (stage), `{route}` (resource). |
| `QUANTITY_SOURCE` | `QuantitySource` | `1` | `1` = count, `response_size` = response bytes. SAM allowed values: `['1','response_size']`. |
| `CUSTOMER_ID_SOURCE` | `CustomerIdSource` | `consumer` | Only `consumer` is accepted (sources identity from `$context.identity.apiKey` / `.caller`). SAM allowed values: `[consumer]`. Any other value is ignored. |
| `FLUSH_COUNT` | — (set to `50` in template) | `50` | Max events per POST batch. |
| `INCLUDE_METADATA` | — (set to `true` in template) | `true` | Include request metadata in the event. Set to `"false"` to omit. |
| `MCP_ENABLED` | — | `false` | Detect MCP JSON-RPC `tools/call` in the logged request body and emit `mcp_server.tool_invocations`. |
| `MCP_PRODUCT_ID` | — | — | Aforo product ID for MCP metering. |
| `MARGIN_GUARD_ENABLED` | — | `false` | Margin-guard flag (informational only here — see below). |
| `MARGIN_GUARD_URL` | — | — | Pricing-service base URL for margin-guard (informational only here). |

Excluded by default in code: paths `/health`, `/ready`, `/metrics`, `/favicon.ico`; status codes `401`, `403`, `429`. These are hardcoded constants in `index.js`.

## Walk me through it

Step-by-step from `sam deploy` to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Margin-guard enforcement does not block requests here.** This Lambda processes CloudWatch Logs after the fact and cannot reject a live call. For real-time L2/L3 enforcement, deploy the separate `margin-guard.js` / `authorizer.js` module as an API Gateway Lambda Authorizer (see `AUTHORIZER.md` in this folder). `MARGIN_GUARD_*` env vars on this metering function are informational only.
- **Delivery is best-effort.** The function retries a batch 3x with exponential backoff on 5xx/transport errors, does not retry on 4xx, and drops the batch after the third failure. It is not a guaranteed-delivery queue.
- **It bills from access logs, not the gateway internals.** Anything your access-log format omits (e.g. `identity.apiKey` when the field isn't logged) won't reach the event — customer attribution depends on your stage's access-log configuration.
