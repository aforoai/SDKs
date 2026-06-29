# aforo-metering (Apigee shared flow) — User Guide

**Version:** 2.0.0 · **Updated:** 2026-06-29 · **Audience:** engineers running Apigee X / hybrid who want API usage metered into Aforo without changing their proxies' business logic.

## What you'll build

An `aforo-metering` shared flow deployed to your Apigee environment and attached to your API proxies via a Flow Hook. After each call returns, the shared flow builds a usage event and POSTs it to Aforo in `PostClientFlow`, so the response is never delayed.

## Prerequisites

- An Apigee X (or hybrid) org + environment you can deploy to, with `apigeecli` and `gcloud` authenticated.
- Permission to create an org-scoped KVM and attach a Flow Hook.
- An Aforo API key and tenant id. Events go to `https://ingest.aforo.ai/v1/ingest/batch` (set per environment in the KVM).

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

The bundle reads everything from the org-scoped KVM `aforo-metering-config`. Create it and add the three required keys:

```bash
apigeecli kvms create --name aforo-metering-config \
  --org "$APIGEE_ORG" --env "$APIGEE_ENV" \
  --token "$(gcloud auth print-access-token)"

for kv in \
  "aforo_endpoint=https://ingest.aforo.ai/v1/ingest/batch" \
  "api_key=$AFORO_API_KEY" \
  "tenant_id=$AFORO_TENANT_ID"; do
  apigeecli kvms entries create --map aforo-metering-config \
    --org "$APIGEE_ORG" --env "$APIGEE_ENV" \
    --key "${kv%%=*}" --value "${kv#*=}" \
    --token "$(gcloud auth print-access-token)"
done
```

> ⚠ `api_key` and `tenant_id` are read from the KVM and sent on the callout to Aforo (`Authorization: Bearer` + `X-Tenant-Id`). They are never read from inbound request headers. The KVM is org-scoped, so one config serves all proxies in the org — scope per-environment by deploying the KVM per env.

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

> ⚠ Customer identity is `developer.app.name` (falling back to `developer.email`). That means the proxy must run a `VerifyAPIKey` or OAuth policy so Apigee populates `developer.app.name` from the verified credential. Without it, `customerId` is empty and Aforo's ingestor rejects the event.

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

Then confirm the event under the matching customer (the developer app name) and metric (default `GET /your-proxy/anything`) in your Aforo usage view.

## Step 7 (optional) — MCP tool-invocation metering

Set the flow variable `aforo.mcpEnabled = "true"` (and `aforo.mcpProductId`) for proxies fronting an MCP server. For POST requests, the JS parses `request.content`; any JSON-RPC `2.0` body with `method: "tools/call"` emits an `mcp_server.tool_invocations` event with `toolName`, `sessionId` (from `Mcp-Session-Id`), and `executionStatus`.

> ⚠ `agentId` is read only from the JSON-RPC payload at `params._meta.agent_id`. The `X-Agent-Id` request-header fallback was removed in 2.0.0 — it's client-settable and was a billing-attribution spoof vector.

## Configuration reference

Full KVM key tables (metering + JWT) are in [README.md](README.md#configuration). The three you must set: `aforo_endpoint`, `api_key`, `tenant_id`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Event reaches Aforo with empty `customerId` | No `VerifyAPIKey`/OAuth policy, so `developer.app.name` is unset | Add credential verification to the proxy before the metering flow hook runs. |
| No callout at all in the trace | Shared flow not attached, or attached on the wrong Flow Hook | Confirm the `post-proxy-flow-hook` attachment, or add a `FlowCallout` step in `PostClientFlow`. |
| `aforo.endpoint` resolves empty | KVM key missing or KVM not in the deployed environment | Create the `aforo-metering-config` KVM in the same env and add `aforo_endpoint`. KVM reads are cached 300 s — wait or re-deploy. |
| Callout returns 401 | Wrong `api_key`/`tenant_id` in the KVM | Re-set the KVM entries; both are sent on the callout. |
| Quantity is always 1 even with `quantity_source` set | `aforo-metering.js` emits `quantity: 1` per event | Expected — `quantity_source` is read into a variable but the JS fixes quantity at 1. Bill by size downstream or extend the JS. |
| JWT requests pass with no revocation check | `aforo_redis_host`/`aforo_redis_port` KVM keys unset | Add the Redis KVM keys; without them only `exp`/`iss`/signature run, not the jti blocklist. |

## What this guide does NOT cover

- **The margin-guard and preflight-quota policies** (`AforoMarginGuardCheck`, `aforo-margin-guard.js`, `aforo-preflight-quota.js`) ship in the bundle and run before metering, but their pricing-service quick-check contract is documented with the Aforo platform, not here.
- **Flow Hook precedence with your existing shared flows** — if you already use the `PostProxyFlowHook`, you'll wire `aforo-metering` as a `FlowCallout` instead; that ordering is your proxy design, not the bundle's.
- **Guaranteed delivery.** `continueOnError="true"` means a failed ingestor callout is dropped silently in favor of returning the API response. Reconcile against your own access logs if you need exactly-once accounting.
