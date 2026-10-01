# aforo-metering (Apigee shared flow) — User Guide

**Version:** 2.2.0 · **Updated:** 2026-10-02 · **Audience:** engineers running Apigee X or hybrid who want API usage metered into Aforo without changing their proxies.

## What you'll build

An `aforo-metering` shared flow deployed to your Apigee environment and attached to `PostProxyFlowHook`. For each call it builds one usage event from the request and response and posts it to Aforo before the response goes back to the client. A healthy ingestor answers in tens of milliseconds; a broken one adds at most about 4 seconds and never fails the call.

If you connect Apigee from the Aforo console, the one-click deploy does steps 1 to 4 for you. This guide is the manual path.

## Prerequisites

- An Apigee X (or hybrid) org and environment you can deploy to, with `apigeecli` and `gcloud` authenticated.
- Permission to create an organization-scoped KVM and attach a flow hook.
- An Aforo API key with scope `usage:ingest`. The tenant comes from the key.
- The metric you bill on (default `api_calls`) registered in your Aforo catalog.
- A policy in your proxies that identifies the caller: `VerifyAPIKey`, `OAuthV2`, or Aforo JWTs.

## Step 1 — Import the shared flow

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/apigee

apigeecli sharedflows create bundle \
  --name aforo-metering \
  --folder sharedflowbundle \
  --org "$APIGEE_ORG" \
  --token "$(gcloud auth print-access-token)"
```

`--folder sharedflowbundle` is the bundle root: the folder that holds `aforo-metering.xml`, `policies/`, `resources/` and `sharedflows/`. The command prints the revision it created.

## Step 2 — Deploy it to your environment

```bash
apigeecli sharedflows deploy \
  --name aforo-metering \
  --rev "$REV" \
  --env "$APIGEE_ENV" \
  --org "$APIGEE_ORG" \
  --token "$(gcloud auth print-access-token)"
```

`$REV` is the revision from step 1 (`1` on a first import).

## Step 3 — Create the config KVM

The flow reads the **organization-scoped** KVM `aforo-metering-config`, so create it without `--env`.

```bash
TOKEN="$(gcloud auth print-access-token)"
apigeecli kvms create --name aforo-metering-config --org "$APIGEE_ORG" --token "$TOKEN"
kv() { apigeecli kvms entries create --map aforo-metering-config --org "$APIGEE_ORG" --key "$1" --value "$2" --token "$TOKEN"; }

kv aforo_endpoint https://api.aforo.ai/v1/ingest/batch
kv api_key        "$AFORO_API_KEY"
kv default_metric api_calls
kv metric_mappings '[{"matchType":"PREFIX","value":"/sms/v1/send","metricName":"sms_sent"}]'
```

`metric_mappings` is optional. Rules match the proxy base path plus the path suffix; the first match wins; anything unmatched is billed on `default_metric`.

Then decide how a caller becomes an Aforo customer. Without one of these, nothing is metered:

- **Developer apps (default).** With `VerifyAPIKey` or `OAuthV2` in the proxy, the customer is `developer.app.name`. Name the app after the Aforo customer id, or use the next option.
- **A custom attribute.** Store the Aforo customer id on each developer app (for example `aforo_customer_id`) and set
  `kv customer_id_source flow_variable:verifyapikey.<YourVerifyAPIKeyPolicy>.app.aforo_customer_id`.
  Check the exact variable name in a debug session.
- **Aforo JWTs.** `kv jwt_validation_enabled true`, plus `aforo_jwks_uri` and `aforo_jwt_issuer`. The customer is the token's `customer_id` claim.

> ⚠ With JWT validation on, a request without a valid Aforo JWT gets 401. Turn it on only where every caller carries one, and attach the flow on the request path for those proxies (see the README, "JWT validation").

> ⚠ The API key, a client id and the client IP are never used as the customer. A `customer_id_source` that points at one is ignored.

## Step 4 — Attach the shared flow

For every proxy in the environment:

```bash
apigeecli flowhooks attach \
  --name PostProxyFlowHook \
  --sharedflow aforo-metering \
  --org "$APIGEE_ORG" --env "$APIGEE_ENV" \
  --token "$(gcloud auth print-access-token)"
```

For one proxy, add a `FlowCallout` to `aforo-metering` in that proxy's response PostFlow instead.

> ⚠ Not `PostClientFlow`. On Apigee X and hybrid that flow accepts only FlowCallout, MessageLogging and ServiceCallout, and a shared flow called from it may contain only those. This one reads a KVM and runs JavaScript.

## Step 5 — Call an attached API

```bash
curl "https://$APIGEE_HOST/your-proxy/anything?apikey=$APP_KEY"
```

The steps, in order: `AforoMeteringReadConfig` loads the KVM, `AforoMeteringBuildEvent` (`aforo-metering.js`) builds the event, `AforoMeteringSendEvent` posts `{ "events": [ ... ] }` to `aforo_endpoint` with the `X-API-Key` header. If that send fails to connect or gets a 5xx or 408 within 1.2 s, `AforoMeteringSendEventRetry1` sends the same payload once more.

## Step 6 — Verify it landed in Aforo

1. Start a debug session on the proxy in the Apigee console.
2. Send the request from step 5.
3. Open the `AforoMeteringSendEvent` step. `aforo.calloutResponse.status.code` is `200` or `202` when the ingestor took the event.

If `AforoMeteringSendEvent` did not run, read `aforo.skipReason` on the `AforoMeteringBuildEvent` step: `OPTIONS`, `excluded status code`, `excluded path`, `no customerId`, `quantity <= 0`, …

If it ran and the event was refused, the `AforoMeteringLogDeliveryFailure` step prints `USAGE EVENT DROPPED` with the status and the ingestor's message.

Then find the event in Aforo under the customer and the metric.

## Step 7 (optional) — MCP tool calls

For proxies in front of an MCP server set `mcp_enabled` to `true` (and `mcp_product_id`). A POST whose body is a JSON-RPC 2.0 `tools/call` produces an `mcp_server.tool_invocations` event with `toolName`, `sessionId` (from `Mcp-Session-Id`) and `executionStatus`. A JSON-RPC `error` inside a 2xx response is reported as `ERROR`.

`productType` is `MCP_SERVER` when the payload has `params._meta.agent_id`. Without it the event keeps the KVM `product_type` (default `API`), because the ingestor rejects an `MCP_SERVER` event with no agent.

> ⚠ `agentId` is read only from `params._meta.agent_id`. The `X-Agent-Id` request header is not read: a client can set it.

## Configuration reference

Every KVM key, its default and its effect: [README.md](README.md#configuration).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No event; `aforo.skipReason` is `no customerId` | No verified identity for the call. | Put `VerifyAPIKey` before the flow, set `customer_id_source`, or turn on JWT validation. |
| Dropped with status 400 | The metric is not in the Aforo catalog, or the customer id is not an Aforo customer. | The dropped-event line carries the ingestor's message. Register the metric, fix the mapping, or fix the customer id. |
| Dropped with status 401 | Wrong `api_key`, or it lacks scope `usage:ingest`. | Replace the KVM entry. |
| Every request gets 401 from the proxy | JWT validation is on for callers without Aforo JWTs. | Set `jwt_validation_enabled` to `false` or remove `aforo_jwks_uri`. |
| No send step in the trace | The flow is not attached, `aforo_endpoint` is missing, or the request was skipped. | Check the flow hook, the KVM, and `aforo.skipReason`. |
| 401/403/429 responses are not metered | Excluded by default. | Set `exclude_status_codes` to `none` or to your own list. |
| A KVM change has no effect | KVM reads are cached for 300 s. | Wait five minutes or redeploy. |
| Calls slow down during an Aforo outage | Each call waits for the send to time out, about 2 s. | Set `max_retries` to `0`. |

## What this guide does NOT cover

- **Margin guard** (`AforoMarginGuardCheck`). It is off unless `margin_guard_enabled` is `true`; its pricing-service contract is documented with the Aforo platform.
- **Compound metering, pre-flight quota and the jti blocklist.** `aforo-compound-metering.js`, `aforo-preflight-quota.js` and `aforo-jwt-jti-check.js` sit in the bundle but no policy runs them.
- **Guaranteed delivery.** An event that fails after the one retry is logged and dropped. Reconcile against your own access logs if you need exact accounting.
- **A flow hook that is already taken.** If another shared flow holds `PostProxyFlowHook`, call `aforo-metering` from it with a FlowCallout.
