# Aforo for Apigee X: user guide

**Version:** 3.1.0 · **Updated:** 2026-10-28 · **Audience:** engineers running Apigee X or hybrid who want their API metered and quota-enforced by Aforo without changing their API.

Aforo's organization service normally does every step below when you connect your Apigee org in Aforo and deploy a product to it. This guide does it by hand: for a test org, for troubleshooting, or to see exactly what Aforo changes. The [README](README.md) is the reference for every setting.

## What you'll build

- `aforo-access` on the **PreProxyFlowHook** and `aforo-metering` on the **PostProxyFlowHook** of one environment.
- The KVM `aforo-metering-config` that marks which proxies Aforo manages and how each API product bills.
- A developer and a developer app for one end customer, holding their Aforo key.

## Prerequisites

- An Apigee X org and environment, with `gcloud` and [`apigeecli`](https://github.com/apigee/apigeecli) logged in as an org admin (attaching flow hooks needs one).
- An API proxy in that environment, for example `payments-proxy`, and an API product that includes it, for example `payments-product`.
- From Aforo:
  - your tenant id
  - an Aforo API key with scope `usage:ingest`
  - the product's metric name
  - an end customer id and that customer's `sk_live_…` key (or, for AI_AGENT and MCP products, an agent credential's client secret)

```bash
export ORG=my-org ENV=test TOKEN="$(gcloud auth print-access-token)"
```

## Step 1: import and deploy both shared flows

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/apigee

apigeecli sharedflows create bundle --name aforo-access   --folder aforo-access/sharedflowbundle --org "$ORG" --token "$TOKEN"
apigeecli sharedflows create bundle --name aforo-metering --folder sharedflowbundle              --org "$ORG" --token "$TOKEN"
apigeecli sharedflows deploy --name aforo-access   --rev 1 --env "$ENV" --org "$ORG" --token "$TOKEN"
apigeecli sharedflows deploy --name aforo-metering --rev 1 --env "$ENV" --org "$ORG" --token "$TOKEN"
```

The metering bundle stays at `sharedflowbundle/`, its 2.x path. The access bundle is in `aforo-access/sharedflowbundle/`. Each folder is a bundle root: its manifest XML, `policies/`, `resources/` and `sharedflows/`.

## Step 2: create the KVM

The KVM is **organization**-scoped, so don't pass `--env`. Values are strings.

```bash
apigeecli kvms create --name aforo-metering-config --org "$ORG" --token "$TOKEN"
kv() { apigeecli kvms entries create --map aforo-metering-config --org "$ORG" --key "$1" --value "$2" --token "$TOKEN"; }

# global
kv aforo_endpoint      https://api.aforo.ai/v1/ingest/batch
kv api_key             "$AFORO_API_KEY"          # scope usage:ingest
kv tenant_id           "$AFORO_TENANT_ID"
kv quota_fail_open     true
kv quota_cache_ttl_ms  1000
kv delivery_mode       sync                      # while testing: failures show in Debug; async in production

# this proxy is Aforo's
kv managed_proxy__payments-proxy true

# this API product
kv product_type__payments-product   API
kv default_metric__payments-product api_calls_metric
kv enforce_quota__payments-product  true
kv metric_mappings__payments-product '[{"pathPattern":"^/payments/v1/charge","method":"POST","metricName":"charges"}]'
```

For the other product types, set `product_type__{p}` to `AGENTIC_API`, `AI_AGENT` (optionally `agent_id__{p}`) or `MCP_SERVER` (set `default_metric__{p}` to the tool-call metric). The README lists every key.

## Step 3: attach the flow hooks

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://apigee.googleapis.com/v1/organizations/$ORG/environments/$ENV/flowhooks/PreProxyFlowHook" \
  -d '{"sharedFlow":"aforo-access","continueOnError":false}'
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://apigee.googleapis.com/v1/organizations/$ORG/environments/$ENV/flowhooks/PostProxyFlowHook" \
  -d '{"sharedFlow":"aforo-metering","continueOnError":true}'
```

- `aforo-access` must be able to refuse a call (401, 429), so attach it with `continueOnError: false`. Its own steps already fail open on an Aforo outage.
- Each hook takes one shared flow. If your environment already uses one of these hooks, call the Aforo flow from your shared flow with a FlowCallout instead.
- These hooks cover every proxy in the environment. Proxies without `managed_proxy__{proxy} = true` are untouched.

## Step 4: add the end customer

```bash
CUST=<aforo customer id>
apigeecli developers create --email "aforo-$CUST@customers.aforo.invalid" --first Aforo --last "$CUST" \
  --user "aforo-$CUST" --attrs "aforo_customer_id=$CUST" --org "$ORG" --token "$TOKEN"
apigeecli apps create --name "aforo-$CUST" --email "aforo-$CUST@customers.aforo.invalid" \
  --prods payments-product --attrs "aforo_customer_id=$CUST" --org "$ORG" --token "$TOKEN"
# import the customer's Aforo key as the app's consumerKey (consumerSecret: random)
apigeecli apps keys create --name "aforo-$CUST" --dev "aforo-$CUST@customers.aforo.invalid" \
  --key "$CUSTOMER_SK_LIVE_KEY" --secret "$(openssl rand -hex 32)" --prods payments-product \
  --org "$ORG" --token "$TOKEN"
```

Check the `apigeecli` flag names against `apigeecli <command> --help` for your version; the Apigee API equivalents are `POST /developers`, `POST /developers/{email}/apps` and `POST /developers/{email}/apps/{app}/keys/create`.

The customer is taken **only** from the `aforo_customer_id` attribute: on the app, else on the developer. The app name and the email are labels and are never billed.

## Step 5: check it

```bash
HOST=<your environment group host>
curl -i "https://$HOST/payments/v1/accounts"                                  # 401: no key
curl -i -H "x-api-key: wrong" "https://$HOST/payments/v1/accounts"            # 401
curl -i -H "x-api-key: $CUSTOMER_SK_LIVE_KEY" "https://$HOST/payments/v1/accounts"   # your API's answer
```

Then look for the event under the customer and metric in Aforo. In an Apigee **Debug** session on the proxy, check these variables:

- `aforo.verified.customerId`: the customer the call billed to.
- `aforo.access.quotaDecision`: ALLOW, WARN, DENY or UNAVAILABLE.
- `aforo.skipReason`: why a call was not metered.
- With `delivery_mode = sync`: `aforo.meteringFirstAttempt`, `aforo.meteringDroppedEvents`, and the `print` lines starting `[aforo-metering]`.

Your upstream should not see an `x-api-key` header: the access flow strips the key once it is verified.

To see the 429, use up the customer's hard limit in Aforo. The next call answers `429` with `Retry-After` and `{"message":…,"retryAfter":…}`, and your upstream is not called.

## Metering upstream errors

Apigee sends a target's 4xx/5xx to the error flow, which skips the PostProxyFlowHook, so such calls are not metered by the hook. To bill them (as `ERROR`, `TIMEOUT` and so on), add a FlowCallout to the proxy's `DefaultFaultRule`. This is proxy configuration, not code:

```xml
<!-- apiproxy/policies/FC-aforo-metering.xml -->
<FlowCallout name="FC-aforo-metering" continueOnError="true">
    <SharedFlowBundle>aforo-metering</SharedFlowBundle>
</FlowCallout>

<!-- in apiproxy/proxies/default.xml -->
<DefaultFaultRule name="aforo">
    <AlwaysEnforce>true</AlwaysEnforce>
    <Step><Name>FC-aforo-metering</Name></Step>
</DefaultFaultRule>
```

- **No double billing.** A call that reached the PostProxyFlowHook did not fault, so the fault rule never runs for it. A call `aforo-access` refused (401/429/503) is marked refused and never billed.
- **Default exclusions.** Upstream 401, 403 and 429 are still not billed (`exclude_status_codes`).
- **The other option** is `success.codes` on your TargetEndpoint. It changes how your proxy, analytics and fault rules see errors, so the FlowCallout is the smaller change.

## Delivery mode

- **`async`** (the default): the client never waits for Aforo. An event the ingestor does not store is lost without a trace. Use it in production.
- **`sync`**: the client waits for the ingestor's answer, which takes at most about 4 s. A transient failure is re-sent once and every loss is logged. Use it while testing, or where every event matters more than latency.
- **`pubsub`** (Apigee X / hybrid): each call's events go to a Pub/Sub topic (`pubsub_topic`), and the [Pub/Sub forwarder](pubsub-forwarder/README.md) delivers them in batches and acks only after the ingestor accepted them. The client waits for the publish, not for Aforo; an ingest outage loses nothing. Set it up with the forwarder README, then set `pubsub_topic` before `delivery_mode = pubsub`.

See the README for why Apigee forces this choice.

## Token revocation

A revoked Aforo JWT is not checked: with `jwt_validation_enabled`, a valid token is accepted until it expires. Keep JWT lifetimes short. Revoking the end customer's key (the app credential) takes effect on the next call.

## Upgrading from 3.0

Nothing to change: 3.1.0 adds the opt-in `pubsub` delivery mode and the `pubsub_topic` KVM key. Import and deploy both bundles again (aforo-access reads the new key). The flow hooks stay as they are.

## Upgrading from 2.x

3.0.0 is a breaking change:

1. Deploy `aforo-access` and attach it to the PreProxyFlowHook. `aforo-metering` bills nothing without it.
2. Add `managed_proxy__{proxy} = true` for each proxy, and the per-product keys (`product_type__{p}`, `default_metric__{p}`, …) for each API product.
3. Give each app (or developer) the `aforo_customer_id` attribute. `customer_id_source` is gone.
4. Global `product_type`, `default_metric`, `metric_mappings` (EXACT/PREFIX/CONTAINS), `metric_name_pattern`, `mcp_enabled` and `mcp_product_id` are no longer read. `metric_mappings__{p}` uses Lua patterns, as in Kong.
5. Margin guard (`margin_guard_enabled`, `margin_guard_url`) was removed. It ran after the upstream had already served the call and called an internal Aforo endpoint.
6. Move the JWT keys you use (`jwt_validation_enabled`, `aforo_jwks_uri`, `aforo_jwt_issuer`) as they are: they are now read by `aforo-access`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Every call 401 | Is the key the app's **consumerKey**, approved, with an API product that includes this proxy? With JWT on, is there a valid `Authorization: Bearer`? |
| Calls pass but nothing in Aforo | Debug: `aforo.skipReason`. Look for `no verified customer` (attribute missing), `API product … has no Aforo settings`, or `KVM aforo_endpoint or api_key is not set`. In `async` mode, also try `sync` to see the ingestor's answer. |
| Wrong metric | `metric_mappings__{p}` patterns are Lua patterns matched against base path + suffix (`/payments/v1/charge`, not `/v1/charge`). Escape `-` and `.` as `%-` and `%.`. |
| Never 429 | `enforce_quota__{p}` = `true`? `aforo.access.quotaDecision` UNAVAILABLE means no answer within 1500 ms, or a 401 for `api_key` / `tenant_id`. |
| KVM change ignored | Values are cached 60 s. |
