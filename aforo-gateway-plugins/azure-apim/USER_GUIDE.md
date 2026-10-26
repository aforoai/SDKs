# Aforo Metering — Azure APIM Policy — User Guide

**Version:** 2.2.0 · **Updated:** 2026-10-02 · **Audience:** engineers who own an Azure API Management instance and need gateway-level metering for Aforo billing.

> These fragments have not been executed on a live APIM instance in this repository. Follow this guide on a non-production instance first and use APIM request tracing to confirm each step. `scripts/verify-on-apim.sh` automates that for the metering fragment.

## What you'll build

An APIM API that sends one usage event to Aforo after every response, without delaying the response, attributed to an Aforo customer and billed against a metric that exists in your Aforo catalog.

There are two ways to configure it. Pick one.

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

For JWT identity add `aforo-jwks-uri` (an OpenID discovery document URL — see the README), `aforo-jwt-issuer` and `aforo-org-service-url`.

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
frag aforo-context context-policy-fragment.xml          # path B
frag aforo-jwt-validation jwt-validation-policy.xml     # optional
```

In the portal: **APIs → Policy fragments → Create**, paste from `<fragment>` on.

## Step 3 — Wire the fragments into the API policy

Path A:

```xml
<policies>
    <inbound><base /></inbound>
    <backend><base /></backend>
    <outbound>
        <base />
        <set-variable name="aforo-default-metric" value="api_calls" />
        <set-variable name="aforo-metric-mappings" value="PREFIX|/sms/v1/send|sms_sent" />
        <include-fragment fragment-id="aforo-metering" />
    </outbound>
    <on-error><base /></on-error>
</policies>
```

Path B:

```xml
<policies>
    <inbound>
        <base />
        <include-fragment fragment-id="aforo-jwt-validation" />   <!-- optional; before aforo-context -->
        <include-fragment fragment-id="aforo-context" />
    </inbound>
    <backend><base /></backend>
    <outbound>
        <base />
        <include-fragment fragment-id="aforo-metering" />
    </outbound>
    <on-error><base /></on-error>
</policies>
```

A fragment holds statements only, so where it runs is decided by where you include it.

## Step 4 — Send a request and check the event

```bash
curl "https://<apim-instance>.azure-api.net/sms/v1/send" -X POST \
  -H "Ocp-Apim-Subscription-Key: <subscription-key>"
```

In Aforo, confirm one event with the expected `customerId`, `metricName = sms_sent`, `productType = API`, `executionStatus = SUCCESS` and `idempotencyKey` = the APIM request id. In the APIM trace, the outbound `send-one-way-request` carries `X-API-Key` and no `Authorization` or `X-Tenant-Id` header.

Then the negative cases:

- `curl -X OPTIONS …` → no event (trace: `Not metered: OPTIONS preflight`).
- A call that returns 401, 403 or 429, or a call to `/health` → no event (default exclusions).
- Path B: a subscription that is not in `aforo-subscription-customer-map`, without an Aforo JWT → no event (trace: `Not metered: no Aforo customer`).
- `-H "X-Customer-Id: someone-else"` → ignored; attribution does not change.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Policy save fails: named value not found | A referenced Named Value doesn't exist. | `aforo-metering` needs four, `aforo-context` five, `aforo-jwt-validation` three. Create the missing one (`none` for empty). |
| Fragment upload fails with an XML parse error | Uploaded with format `xml`. | Use `rawxml`. |
| No events at all | No customer resolves. | Path A: the request needs an APIM subscription, or set `aforo-customer-id`. Path B: check the JWT `customer_id` claim or add the subscription id to the map. |
| The trace shows the send, Aforo shows nothing | The ingestor rejected the event: unknown metric, unknown customer, or a key without `usage:ingest`. `send-one-way-request` discards the response. | Set `aforo-default-metric` to a catalog metric; check the customer exists. |
| 401 on every request after adding JWT validation | `aforo-jwks-uri` is a bare JWKS URL (`openid-config` needs a discovery document), or the issuer does not match. | See the README, "What this does not cover". |
| MCP requests metered as standard API | `aforo-mcp-enabled` is not `true`, or the request body was not captured in inbound. | Include `aforo-context`, or add the `aforo-mcp-body` line from the README. |

## What this guide does NOT cover

- APIM provisioning and networking (reachability of the ingestor, org-service and pricing-service from APIM).
- Retrying or buffering failed sends — `send-one-way-request` is fire-and-forget.
- Fetching metric mappings from the catalog automatically.
- The optional preflight, margin-guard and compound fragments: see the README, "Optional fragments", and the CHANGELOG for the lines a 2.1.0 install needs.
