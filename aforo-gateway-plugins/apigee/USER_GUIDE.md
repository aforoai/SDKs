# aforo-metering (Apigee shared flow) — User Guide

**Version:** 2.0.0 · **Updated:** 2026-09-21 · **Audience:** engineers running Apigee X / hybrid who want API usage metered into Aforo without changing their proxies' business logic.

## What you'll build

An `aforo-metering` shared flow deployed to your Apigee environment and attached to your API proxies via a Flow Hook. After each call returns, the shared flow builds a usage event and POSTs it to Aforo in `PostClientFlow`, so the response is never delayed.

## Prerequisites

- An Apigee X (or hybrid) org + environment you can deploy to, with `apigeecli` and `gcloud` authenticated.
- Permission to create an org-scoped KVM and attach a Flow Hook.
- An Aforo API key with scope `usage:ingest` (the tenant comes from the key). The metric you bill against (default `api_calls`) registered in your Aforo catalog. Events go to `https://api.aforo.ai/v1/ingest/batch` (set per environment in the KVM).

## Step 1 — Import the shared flow from source

Not a registry release, so deploy the bundle in this folder:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/apigee

apigeecli sharedflows create bundle \
  --name aforo-metering \
  --folder sharedflowbundle \
  --org "$APIGEE_ORG" \
  --token "$(gcloud auth print-access-token)"
```

`--folder sharedflowbundle` points at the bundle root (the folder containing `aforo-metering.xml`, `policies/`, `resources/`, and `sharedflows/`).

## Step 2 — Deploy it to your environment

```bash
apigeecli sharedflows deploy \
  --name aforo-metering \
  --rev 1 \
  --env "$APIGEE_ENV" \
  --org "$APIGEE_ORG" \
  --token "$(gcloud auth print-access-token)"
```

## Step 3 — Create the config KVM

The bundle reads the **organization-scoped** KVM `aforo-metering-config` (no `--env`). See the README Configuration table for every key.

```bash
TOKEN="$(gcloud auth print-access-token)"
apigeecli kvms create --name aforo-metering-config --org "$APIGEE_ORG" --token "$TOKEN"
kv() { apigeecli kvms entries create --map aforo-metering-config --org "$APIGEE_ORG" --key "$1" --value "$2" --token "$TOKEN"; }
kv aforo_endpoint https://api.aforo.ai/v1/ingest/batch
kv api_key "$AFORO_API_KEY"
kv default_metric api_calls
kv metric_mappings '[{"matchType":"PREFIX","value":"/sms/v1/send","metricName":"sms_sent"}]'
```

Then choose how callers are identified as Aforo customers — at least one is required, or nothing is metered:

- **Aforo JWTs**: `kv jwt_validation_enabled true`, plus `aforo_jwks_uri` and `aforo_jwt_issuer`. With this on, requests without a valid Aforo JWT get 401 — only enable it on proxies whose callers all carry one.
- **API keys / developer apps**: store each app's Aforo customer id in a custom attribute (e.g. `aforo_customer_id`) and set `kv customer_id_source flow_variable:verifyapikey.<YourVerifyAPIKeyPolicy>.app.aforo_customer_id`. Confirm the variable name in a Debug session.

> ⚠ `api_key` is sent only as `X-API-Key`; `tenant_id` is never sent to the ingestor.

## Step 4 — Attach the shared flow to your proxies

Attach `aforo-metering` with a Flow Hook so it runs for every proxy in the environment:

```bash
apigeecli flowhooks attach \
  --name post-proxy-flow-hook \
  --sharedflow aforo-metering \
  --org "$APIGEE_ORG" --env "$APIGEE_ENV" \
  --token "$(gcloud auth print-access-token)"
```

Or, for per-proxy control, add a `FlowCallout` step referencing `aforo-metering` in the proxy's `PostClientFlow`.

> ⚠ The flow mixes request-phase steps (JWT, margin guard) and the response-phase metering step — see the README's "Phase mixing" note before choosing the hook.

## Step 5 — Call an attached API

```bash
curl "https://$APIGEE_HOST/your-proxy/anything?apikey=$APP_KEY"
```

The shared flow runs after the response: `AforoMeteringReadConfig` loads the KVM, `AforoMeteringBuildEvent` (the `aforo-metering.js` resource) builds the event, and `AforoMeteringSendEvent` POSTs `{ "events": [ ... ] }` to your `aforo_endpoint`.

## Step 6 — Verify it landed in Aforo

The send uses a `ServiceCallout` with `continueOnError="true"`, so the response is returned regardless of the callout result. To confirm delivery, inspect the callout response in Apigee's Debug (Trace) tool:

1. Start a Trace session on the proxy in the Apigee console.
2. Send the request from Step 5.
3. In the trace, open the `AforoMeteringSendEvent` step and check the `aforo.calloutResponse` status code — `2xx` means accepted.

If `AforoMeteringSendEvent` did not run, check `aforo.skipReason` on the `AforoMeteringBuildEvent` step (`OPTIONS`, `no customerId`, `excluded path`, …). Then confirm the event under the Aforo customer and metric (`api_calls` unless a mapping matched) in your Aforo usage view.

## Step 7 (optional) — MCP tool-invocation metering

Set the KVM keys `mcp_enabled = true` (and `mcp_product_id`) for proxies fronting an MCP server. For POST requests, the JS parses `request.content`; any JSON-RPC `2.0` body with `method: "tools/call"` emits an `mcp_server.tool_invocations` event with `toolName`, `sessionId` (from `Mcp-Session-Id`), and `executionStatus`.

> ⚠ `agentId` is read only from the JSON-RPC payload at `params._meta.agent_id`. The `X-Agent-Id` request-header fallback was removed in 2.0.0 — it's client-settable and was a billing-attribution spoof vector.

## Configuration reference

Full KVM key tables (metering + JWT) are in [README.md](README.md#configuration). You must set `aforo_endpoint`, `api_key`, `default_metric`, and one customer-identity source.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No event; `aforo.skipReason = no customerId` | Neither a verified Aforo JWT nor `customer_id_source` produced a customer | Enable `jwt_validation_enabled` for JWT callers, or configure `customer_id_source` to your verified app attribute. |
| Every request 401s | `jwt_validation_enabled = true` on a proxy whose callers don't send Aforo JWTs | Turn it off for that proxy's traffic and use `customer_id_source`. |
| Callout returns 400 | `default_metric` / a mapped metric is not in the catalog, or the customer id is not an Aforo customer | Register the metric / fix the mapping; the callout response body names the field. |
| No callout at all in the trace | Shared flow not attached, or attached on the wrong Flow Hook | Confirm the `post-proxy-flow-hook` attachment, or add a `FlowCallout` step in `PostClientFlow`. |
| `aforo.endpoint` resolves empty | KVM key missing or KVM not in the deployed environment | Create the `aforo-metering-config` KVM in the same env and add `aforo_endpoint`. KVM reads are cached 300 s — wait or re-deploy. |
| Callout returns 401 | Wrong `api_key`, or an `Authorization` header on the callout | The key is sent only as `X-API-Key`; check the key has scope `usage:ingest`. |
| JWT requests pass with no revocation check | `aforo_redis_host`/`aforo_redis_port` KVM keys unset | Add the Redis KVM keys; without them only `exp`/`iss`/signature run, not the jti blocklist. |

## What this guide does NOT cover

- **The margin-guard and preflight-quota policies** (`AforoMarginGuardCheck`, `aforo-margin-guard.js`, `aforo-preflight-quota.js`) ship in the bundle and run before metering, but their pricing-service quick-check contract is documented with the Aforo platform, not here.
- **Flow Hook precedence with your existing shared flows** — if you already use the `PostProxyFlowHook`, you'll wire `aforo-metering` as a `FlowCallout` instead; that ordering is your proxy design, not the bundle's.
- **Guaranteed delivery.** `continueOnError="true"` means a failed ingestor callout is dropped silently in favor of returning the API response. Reconcile against your own access logs if you need exactly-once accounting.
