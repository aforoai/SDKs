# Aforo Metering — Azure APIM Policy — User Guide

**Version:** 2.4.0 · **Updated:** 2026-11-25 · **Audience:** engineers who own an Azure API Management instance and need gateway-level metering for Aforo billing.

> These fragments have not been executed on a live APIM instance in this repository. Follow this guide on a non-production instance first and use APIM request tracing to confirm each step. `scripts/verify-on-apim.sh` automates that for the metering fragment.

## What you'll build

An APIM API that sends one usage event to Aforo after every response, without delaying the response, attributed to an Aforo customer and billed against a metric that exists in your Aforo catalog.

**Delivery.** This guide installs Event Hub delivery, the default since 2.4.0: the policy writes each event to Azure Event Hubs and a small Azure Function (`eventhub-forwarder/`) sends it to Aforo with retries, so an ingest outage, a 5xx or a 429 delays usage instead of losing it. Direct delivery (the policy posts each event itself with `send-one-way-request`, no retry, the event is lost on any ingest failure) is the opt-in; the steps marked *Event Hub* are then left out and `aforo-delivery-mode` is not set to `eventhub`. Aforo's one-click deploy installs direct delivery today.

There are two ways to configure the settings. Pick one.

| | A. Context variables | B. Named Values + `aforo-context` |
|---|---|---|
| Settings live in | `set-variable` lines in your policy (or the `aforo-metering-config` fragment Aforo's one-click deploy creates) | APIM Named Values |
| Customer | the APIM subscription id, or `aforo-customer-id` | verified JWT `customer_id` claim, else a subscription-to-customer map |
| Fragments | `aforo-metering` | `aforo-context` + `aforo-metering` |
| Use it when | your subscriptions are named after Aforo customer ids, or you set the customer yourself | callers present Aforo JWTs, or subscription ids differ from Aforo customer ids; this is what release 2.1.0 installed |

## Prerequisites

- An Azure API Management instance and an API you can edit policies on.
- Permission to create Named Values and policy fragments.
- An Aforo API key with scope `usage:ingest`. The tenant comes from the key.
- *Event Hub*: rights to create an Event Hubs namespace, a storage account, a Function app and two role assignments in the APIM instance's resource group (Owner, or Contributor plus User Access Administrator), and the instance's system-assigned managed identity turned on.
- The metrics you bill against registered in the Aforo catalog (at least your default metric, e.g. `api_calls`).

## Step 1 — Create the Named Values

```bash
RG="<resource-group>"; APIM="<apim-instance>"
nv() { az apim nv create -g "$RG" --service-name "$APIM" --named-value-id "$1" --display-name "$1" --value "$2" ${3:+--secret true}; }

nv aforo-endpoint "https://api.aforo.ai/v1/ingest/batch"
nv aforo-api-key "sk_live_..." secret
nv aforo-mcp-enabled "false"
nv aforo-mcp-product-id "none"
```

Path B only — `aforo-context` references these five (the first four plus `aforo-mcp-enabled` above). All must exist; use `none` to leave one empty. Values must not contain `"` or `\`.

```bash
nv aforo-default-metric "api_calls"
nv aforo-metric-mappings "PREFIX|/sms/v1/send|sms_sent;EXACT|/otp/v1/verify|otp_verified"   # or none
nv aforo-subscription-customer-map "acme-prod=cust_123;globex=cust_456"                       # or none
nv aforo-product-type "API"
```

For JWT identity add these (and `aforo-api-key`, above):

```bash
nv aforo-openid-config-url "https://org.aforo.ai/.well-known/openid-configuration"   # discovery document, not the JWKS
nv aforo-jwt-issuer "https://auth.aforo.ai"
nv aforo-org-service-url "https://org.aforo.ai"
nv aforo-tenant-id "<your Aforo tenant id>"   # a token for any other tenant gets 401 TENANT_MISMATCH
```

`aforo-openid-config-url` replaced `aforo-jwks-uri` in 2.4.0: `validate-jwt` needs the discovery document, which names the keys (`jwks_uri`), and finds no keys in a bare JWKS URL.

## Step 1b — *Event Hub*: deploy the forwarder

Follow `eventhub-forwarder/README.md`, "Install", steps 1 to 3: turn on the instance's managed identity, deploy `eventhub-forwarder/deploy/aforo-eventhub-forwarder.json` into the instance's resource group (Event Hubs namespace and hub, the APIM logger `aforo-metering-logger`, the Function app, both role assignments), and publish the forwarder code. A first deployment can stop on the logger while a new role assignment takes effect; run it again after a few minutes.

## Step 2 — Import the fragments

Upload each file **from its `<fragment>` line on**, with format `rawxml`. The expressions contain raw `"` and `<`, which format `xml` rejects.

```bash
SUB="$(az account show --query id -o tsv)"
frag() { # id file
  awk 'f || /^<fragment>/ { f = 1; print }' "$2" > /tmp/aforo-frag.xml
  jq -n --rawfile v /tmp/aforo-frag.xml '{properties: {format: "rawxml", value: $v}}' > /tmp/aforo-frag.json
  az rest --method PUT --body @/tmp/aforo-frag.json --headers Content-Type=application/json \
    --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.ApiManagement/service/$APIM/policyFragments/$1?api-version=2022-08-01"
}

frag aforo-metering outbound-policy.xml
frag aforo-metering-eventhub eventhub-delivery-policy-fragment.xml   # Event Hub; needs the logger from step 1b
frag aforo-context context-policy-fragment.xml          # path B
frag aforo-jwt-validation jwt-validation-policy.xml     # optional
```

In the portal: **APIs → Policy fragments → Create**, paste from `<fragment>` on.

## Step 3 — Wire the fragments into the API policy

Path A:

```xml
<policies>
    <inbound>
        <base />
        <set-variable name="aforo-delivery-mode" value="eventhub" />   <!-- Event Hub; "direct" for direct delivery -->
    </inbound>
    <backend><base /></backend>
    <outbound>
        <base />
        <set-variable name="aforo-default-metric" value="api_calls" />
        <set-variable name="aforo-metric-mappings" value="PREFIX|/sms/v1/send|sms_sent" />
        <include-fragment fragment-id="aforo-metering" />
        <include-fragment fragment-id="aforo-metering-eventhub" />    <!-- Event Hub -->
    </outbound>
    <on-error><base /></on-error>
</policies>
```

Path B:

```xml
<policies>
    <inbound>
        <base />
        <set-variable name="aforo-delivery-mode" value="eventhub" />   <!-- Event Hub; "direct" for direct delivery -->
        <include-fragment fragment-id="aforo-jwt-validation" />   <!-- optional; before aforo-context -->
        <include-fragment fragment-id="aforo-context" />
    </inbound>
    <backend><base /></backend>
    <outbound>
        <base />
        <include-fragment fragment-id="aforo-metering" />
        <include-fragment fragment-id="aforo-metering-eventhub" />    <!-- Event Hub -->
    </outbound>
    <on-error><base /></on-error>
</policies>
```

A fragment holds statements only, so where it runs is decided by where you include it. The `aforo-delivery-mode` line and the `aforo-metering-eventhub` include go together: with the first and not the second, nothing is sent.

## Step 4 — Send a request and check the event

```bash
curl "https://<apim-instance>.azure-api.net/sms/v1/send" -X POST \
  -H "Ocp-Apim-Subscription-Key: <subscription-key>"
```

In Aforo, confirm one event with the expected `customerId`, `metricName = sms_sent`, `productType = API`, `executionStatus = SUCCESS` and `idempotencyKey` = the APIM request id. *Event Hub*: the APIM trace shows `log-to-eventhub` and no `send-one-way-request`, and the Function's logs show `aforo-forwarder: accepted=1`. Direct: the outbound `send-one-way-request` carries `X-API-Key` and no `Authorization` or `X-Tenant-Id` header.

Then the negative cases:

- `curl -X OPTIONS …` → no event (trace: `Not metered: OPTIONS preflight`).
- A call that returns 401, 403 or 429, or a call to `/health` → no event (default exclusions).
- Path B: a subscription that is not in `aforo-subscription-customer-map`, without an Aforo JWT → no event (trace: `Not metered: no Aforo customer`).
- `-H "X-Customer-Id: someone-else"` → ignored; attribution does not change.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Policy save fails: named value not found | A referenced Named Value doesn't exist. | `aforo-metering` needs four, `aforo-context` five, `aforo-jwt-validation` five (2.3.0 adds `aforo-api-key` and `aforo-tenant-id`), `aforo-margin-guard` one (`aforo-api-key`). Create the missing one (`none` for empty). |
| Fragment upload fails with an XML parse error | Uploaded with format `xml`. | Use `rawxml`. |
| No events at all | No customer resolves. | Path A: the request needs an APIM subscription, or set `aforo-customer-id`. Path B: check the JWT `customer_id` claim or add the subscription id to the map. |
| The trace shows the send, Aforo shows nothing | The ingestor rejected the event: unknown metric, unknown customer, or a key without `usage:ingest`. `send-one-way-request` discards the response. | Set `aforo-default-metric` to a catalog metric; check the customer exists. |
| 401 `TENANT_MISMATCH` | The token's `tenant_id` claim is missing or is not `aforo-tenant-id`. | Set `aforo-tenant-id` to your Aforo tenant id; tokens for another tenant are refused on purpose. |
| 401 on every request after adding JWT validation | `aforo-openid-config-url` is a bare JWKS URL (`openid-config` needs a discovery document), organization-service does not serve `/.well-known/openid-configuration` yet, or `aforo-jwt-issuer` is not the tokens' `iss`. | `curl -s https://org.aforo.ai/.well-known/openid-configuration` must return JSON with `"issuer": "https://auth.aforo.ai"`. See the README, "What this does not cover". |
| Fragment `aforo-metering-eventhub` is refused: logger not found | The forwarder template (step 1b) has not created `aforo-metering-logger`. | Deploy it, then import the fragment. |
| *Event Hub*: no events in Aforo, the hub has messages | The Function is not running, cannot read the hub, or its `AFORO_API_KEY` is wrong. | Check the Function's logs; see `eventhub-forwarder/README.md`, "Troubleshooting". |
| MCP requests metered as standard API | `aforo-mcp-enabled` is not `true`, or the request body was not captured in inbound. | Include `aforo-context`, or add the `aforo-mcp-body` line from the README. |

## What this guide does NOT cover

- APIM provisioning and networking (reachability of the ingestor, org-service and pricing-service from APIM).
- A run on Azure. Neither delivery mode has run on a live APIM instance in this repository; the forwarder is tested against a mock ingestor.
- Fetching metric mappings from the catalog automatically.
- The optional preflight, margin-guard and compound fragments: see the README, "Optional fragments", and the CHANGELOG for the lines a 2.1.0 install needs.
