# aforo-metering-lambda — User Guide

**Version:** 2.0.0 · **Updated:** 2026-06-29 · **Audience:** engineers running AWS API Gateway who want API usage metered into Aforo from CloudWatch access logs.

## What you'll build

A Lambda subscribed to your API Gateway access-log group. Each batch of log entries is parsed into Aforo usage events and POSTed to the ingestor. Because it runs off the log stream, the request path is untouched. By the end you'll see events land in Aforo with method, path, status, and latency.

## Prerequisites

- AWS API Gateway with **access logging enabled** on the stage, emitting **JSON** entries to a CloudWatch log group.
- AWS SAM CLI authenticated to the target account/region.
- An Aforo API key and tenant id. Events go to `https://ingest.aforo.ai/v1/ingest/batch` (override `AforoEndpoint`).
- Node.js 20 runtime is set in the template (`nodejs20.x`).

## Step 1 — Enable JSON access logging on your API stage

The parser reads JSON access-log entries (it has a CLF fallback, but JSON carries the fields you need). Set your stage's access-log format to include at least `requestId`, `httpMethod`/`method`, `resourcePath`/`path`, `status`, `responseLatency`, `responseLength`, and `identity.apiKey`. A minimal JSON format string:

```json
{"requestId":"$context.requestId","httpMethod":"$context.httpMethod","resourcePath":"$context.resourcePath","status":"$context.status","responseLatency":"$context.responseLatency","responseLength":"$context.responseLength","stage":"$context.stage","identity.apiKey":"$context.identity.apiKey","caller":"$context.identity.caller"}
```

> ⚠ Customer attribution comes from `$context.identity.apiKey` (falling back to `$context.identity.caller`). If your access-log format doesn't include the identity fields, the event's `customerId` is `null` and Aforo's ingestor rejects it. These are API-Gateway-populated, verified values — not client-settable headers.

## Step 2 — Deploy the function from source

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/aws-lambda

sam build
sam deploy --guided \
  --parameter-overrides \
    AforoEndpoint=https://ingest.aforo.ai/v1/ingest/batch \
    AforoApiKey="$AFORO_API_KEY" \
    AforoTenantId="$AFORO_TENANT_ID" \
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
curl -H "x-api-key: $YOUR_GATEWAY_API_KEY" \
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

A skipped/filtered run logs `No usage events after filtering` (e.g. the request was a `/health` call or a `401`/`403`/`429`). A failed send logs:

```
Aforo returned 401 (client error) — not retrying
```

or, after the retry window:

```
All 3 attempts failed — events dropped
```

Then confirm the event under the matching customer + metric (default `GET /anything`) in your Aforo usage view.

## Step 6 (optional) — MCP tool-invocation metering

Set `MCP_ENABLED=true` (and `MCP_PRODUCT_ID`) on the function. For POST entries whose logged `requestBody` is JSON-RPC `2.0` with `method: "tools/call"`, the event becomes `mcp_server.tool_invocations` carrying `toolName`, `agentId`, and `executionStatus`.

```bash
aws lambda update-function-configuration \
  --function-name aforo-metering \
  --environment "Variables={AFORO_ENDPOINT=https://ingest.aforo.ai/v1/ingest/batch,AFORO_API_KEY=$AFORO_API_KEY,AFORO_TENANT_ID=$AFORO_TENANT_ID,MCP_ENABLED=true,MCP_PRODUCT_ID=$AFORO_MCP_PRODUCT_ID}"
```

> ⚠ MCP detection needs the request body in the access log (`requestBody`). API Gateway does not log bodies by default; you'll need a logging integration that captures it, or the MCP branch never triggers.
> ⚠ `agentId` comes only from the JSON-RPC payload at `params._meta.agent_id`. There is no header fallback — that path was removed in 2.0.0 as a spoof vector.

## Configuration reference

Full env-var / SAM-parameter table is in [README.md](README.md#configuration). The three you must set: `AforoEndpoint`, `AforoApiKey`, `AforoTenantId`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Lambda never invokes | Subscription filter on the wrong log group, or access logging disabled | Enable JSON access logging on the stage; confirm `ApiGatewayLogGroupName` matches and the filter exists (`aws logs describe-subscription-filters`). |
| `No usage events after filtering` every run | All entries hit the exclude list, or the parser couldn't read them | Check the access-log format is JSON; confirm the calls aren't `/health`-style paths or `401`/`403`/`429`. |
| Events land with `customerId: null` | Access-log format omits `identity.apiKey` / `caller` | Add the identity fields to the stage's access-log format (Step 1). |
| `Aforo returned 401 (client error) — not retrying` | Wrong `AFORO_API_KEY` / `AFORO_TENANT_ID` | Update the function env vars; both are sent on the POST (`Authorization` + `X-Tenant-Id`). |
| `All 3 attempts failed — events dropped` | Ingestor unreachable or 5xx for the whole retry window | Check `AFORO_ENDPOINT` reachability and Aforo status; this Lambda does not re-queue dropped batches. |
| `MCP_ENABLED=true` but no MCP events | Request body not present in the access log | API Gateway doesn't log bodies by default; capture `requestBody` in the log integration or MCP detection can't run. |
| Margin-guard env vars set but nothing blocks | This Lambda is async and informational for margin guard | Deploy the Lambda Authorizer (`AUTHORIZER.md`) for real-time enforcement; the metering function can't block live calls. |

## What this guide does NOT cover

- **The Lambda Authorizer** (`authorizer.js` + `AUTHORIZER.md` in this folder) — that's the real-time JWT validation + L2/L3 enforcement path, deployed separately as an API Gateway authorizer. This guide covers metering only.
- **Access-log format design** beyond the minimum fields — your full `$context` format is your stage configuration.
- **Guaranteed delivery.** Best-effort with 3x retry; batches are dropped after the third failure. Reconcile against your own logs if you need exactly-once accounting.
