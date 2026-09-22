# aforo-metering-lambda — User Guide

**Version:** 2.0.0 · **Updated:** 2026-09-21 · **Audience:** engineers running AWS API Gateway who want API usage metered into Aforo from CloudWatch access logs.

## What you'll build

A Lambda subscribed to your API Gateway access-log group. Each batch of log entries is parsed into Aforo usage events and POSTed to the ingestor. Because it runs off the log stream, the request path is untouched. By the end you'll see events land in Aforo with method, path, status, and latency.

## Prerequisites

- AWS API Gateway with **access logging enabled** on the stage, emitting **JSON** entries to a CloudWatch log group.
- AWS SAM CLI authenticated to the target account/region.
- An Aforo API key with scope `usage:ingest` (the tenant is derived from the key — there is no tenant id setting). Events go to `https://api.aforo.ai/v1/ingest/batch` (override `AforoEndpoint`).
- Node.js 20 runtime is set in the template (`nodejs20.x`).
- The **Aforo Lambda Authorizer** (`authorizer.js`, see [AUTHORIZER.md](AUTHORIZER.md)) on every route you want metered. It is the only source of `customerId`; routes without it are not metered.
- The metric(s) you will bill against already registered in the Aforo catalog (at minimum the `DefaultMetric`, `api_calls` by default). An unknown metric name fails the whole batch with 400.

## Step 1 — Enable JSON access logging on your API stage

Set your stage's access-log format to JSON with at least these fields:

```json
{"requestId":"$context.requestId","httpMethod":"$context.httpMethod","resourcePath":"$context.resourcePath","status":"$context.status","responseLatency":"$context.responseLatency","responseLength":"$context.responseLength","stage":"$context.stage","customerId":"$context.authorizer.customerId","keyId":"$context.authorizer.keyId"}
```

> ⚠ `customerId` must come from `$context.authorizer.customerId` — the value the Aforo authorizer derives from the verified JWT. Do **not** log `$context.identity.apiKey`: it is the API key itself (a secret), not an Aforo customer id, and this Lambda no longer reads it. Entries without a `customerId` (value missing or `-`) are skipped and counted in the Lambda log as `no customerId`.

## Step 2 — Deploy the function from source

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/aws-lambda

sam build
sam deploy --guided \
  --parameter-overrides \
    AforoEndpoint=https://api.aforo.ai/v1/ingest/batch \
    AforoApiKey="$AFORO_API_KEY" \
    DefaultMetric=api_calls \
    MetricMappings='[{"matchType":"PREFIX","value":"/v1/sms","metricName":"sms_sent"}]' \
    ApiGatewayLogGroupName=/aws/apigateway/aforo-access-logs
```

`--guided` walks you through stack name, region, and saves an `samconfig.toml` so later deploys are just `sam deploy`.

> ⚠ Set `ApiGatewayLogGroupName` to the **exact** log group your stage writes to. The template creates a `SubscriptionFilter` (empty filter pattern = every entry) on that group; if it points at the wrong group, the Lambda never fires.

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

and a batch that still fails transiently after retries fails the invocation (so Lambda retries it):

```
Batch of N event(s) not delivered (transient failure or Lambda deadline)
```

Then confirm the event under the matching customer + metric (`api_calls` unless a mapping matched) in your Aforo usage view.

## Step 6 (optional) — MCP tool-invocation metering

Set `MCP_ENABLED=true` on the function (`mcp_server.tool_invocations` must exist in your catalog). For POST entries whose logged `requestBody` is JSON-RPC `2.0` with `method: "tools/call"`, the event becomes `mcp_server.tool_invocations` carrying `toolName`, `agentId`, and `executionStatus`, with `productType: "MCP_SERVER"` when both `toolName` and `agentId` are known (otherwise it keeps `PRODUCT_TYPE`, default `API`, which every other event carries).

```bash
aws lambda update-function-configuration \
  --function-name aforo-metering \
  --environment "Variables={AFORO_ENDPOINT=https://api.aforo.ai/v1/ingest/batch,AFORO_API_KEY=$AFORO_API_KEY,DEFAULT_METRIC=api_calls,MCP_ENABLED=true}"
```

> ⚠ MCP detection needs the request body in the access log (`requestBody`). API Gateway does not log bodies by default; you'll need a logging integration that captures it, or the MCP branch never triggers.
> ⚠ `agentId` comes only from the JSON-RPC payload at `params._meta.agent_id`. There is no header fallback — that path was removed in 2.0.0 as a spoof vector.

## Configuration reference

Full env-var / SAM-parameter table is in [README.md](README.md#configuration). You must set `AforoEndpoint` and `AforoApiKey`, and make sure `DefaultMetric` (and every `MetricMappings` metric) exists in your catalog.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Lambda never invokes | Subscription filter on the wrong log group, or access logging disabled | Enable JSON access logging on the stage; confirm `ApiGatewayLogGroupName` matches and the filter exists (`aws logs describe-subscription-filters`). |
| `No usage events after filtering` every run | All entries hit the exclude list, or the parser couldn't read them | Check the access-log format is JSON; confirm the calls aren't `/health`-style paths or `401`/`403`/`429`. |
| `Skipped: {"no customerId": N}` | Access-log format lacks `customerId`, or the route is not behind the Aforo authorizer | Add `"customerId":"$context.authorizer.customerId"` to the format (Step 1) and attach the authorizer. |
| `Aforo rejected the batch with 401` | Wrong `AFORO_API_KEY`, or something added an `Authorization` header | The key is sent only as `X-API-Key`; check the key value and that it has scope `usage:ingest`. |
| `Aforo rejected the batch with 400` | An unknown metric name, or a `customerId` that is not an Aforo customer | Register the metric / fix `METRIC_MAPPINGS` / `DEFAULT_METRIC`; check the JWT's `customer_id` claim. The response body in the log names the field. |
| `... not delivered (transient failure or Lambda deadline)` | Ingestor unreachable, 5xx/408/429 for the whole retry window | The invocation fails and Lambda retries it twice; configure an on-failure destination if you need a dead-letter. |
| `MCP_ENABLED=true` but no MCP events | Request body not present in the access log | API Gateway doesn't log bodies by default; capture `requestBody` in the log integration or MCP detection can't run. |
| Margin-guard env vars set but nothing blocks | This Lambda is async and informational for margin guard | Deploy the Lambda Authorizer (`AUTHORIZER.md`) for real-time enforcement; the metering function can't block live calls. |

## What this guide does NOT cover

- **The Lambda Authorizer** (`authorizer.js` + `AUTHORIZER.md` in this folder) — that's the real-time JWT validation + L2/L3 enforcement path, deployed separately as an API Gateway authorizer. This guide covers metering only.
- **Access-log format design** beyond the minimum fields — your full `$context` format is your stage configuration.
- **Guaranteed delivery.** 3x in-invocation retry plus Lambda's async retry; after that a batch is lost unless you add an on-failure destination. Reconcile against your own logs if you need exactly-once accounting.
- **Live verification.** None of this has been run against a real API Gateway stage; see the README's "What this doesn't cover".
