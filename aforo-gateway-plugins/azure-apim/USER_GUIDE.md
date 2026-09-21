# Aforo Metering — Azure APIM Policy — User Guide

**Version:** 2.0.0 (+ unreleased contract fixes) · **Updated:** 2026-09-21 · **Audience:** engineers who own an Azure API Management instance and need gateway-level metering for Aforo billing.

> ⚠ These fragments have not been executed on a live APIM instance. Follow this guide on a non-production instance first and use APIM request tracing to confirm each step.

## What you'll build

An APIM API that fires a non-blocking usage event to Aforo after every response, attributed to an Aforo customer taken from a verified JWT (or from an admin-maintained subscription→customer map), billed against a metric that exists in your Aforo catalog.

## Prerequisites

- An **Azure API Management** instance and an API you can edit policies on.
- Permission to create **Named Values** and **Policy Fragments**.
- An Aforo API key with scope `usage:ingest`. The tenant is derived from the key — there is no tenant setting for metering.
- The metric(s) you will bill against registered in the Aforo catalog (at minimum your default metric, e.g. `api_calls`).
- Either Aforo JWTs on incoming calls (JWKS/discovery URL + issuer), or the list of APIM subscription ids and the Aforo customer id each belongs to.

## Step 1 — Create the Named Values

Every Named Value a fragment references must exist, or APIM rejects the policy. Use `none` for ones you want empty. Values must not contain `"` or `\`.

```bash
RG="<resource-group>"; APIM="<apim-instance>"
nv() { az apim nv create -g "$RG" --service-name "$APIM" --named-value-id "$1" --display-name "$1" --value "$2" ${3:+--secret true}; }

nv aforo-endpoint "https://usage-ingestor.aforo.ai/v1/ingest/batch"
nv aforo-api-key "sk_live_..." secret
nv aforo-default-metric "api_calls"
nv aforo-metric-mappings "PREFIX|/sms/v1/send|sms_sent;EXACT|/otp/v1/verify|otp_verified"   # or none
nv aforo-subscription-customer-map "acme-prod=cust_123;globex=cust_456"                       # or none
nv aforo-mcp-enabled "false"
nv aforo-mcp-product-id "none"
```

Mapping rules are `KIND|value|metricName`, first match wins, `KIND` = `EXACT` / `PREFIX` / `CONTAINS`, matched against the client-facing request path (including the API's URL suffix).

For JWT identity add `aforo-jwks-uri` (an OpenID discovery document URL — see the README caveat), `aforo-jwt-issuer`, and `aforo-org-service-url`.

## Step 2 — Import the fragments

```bash
frag() { az apim policy-fragment create -g "$RG" --service-name "$APIM" --policy-fragment-id "$1" --value @"$2" --format xml; }

frag aforo-context  context-policy-fragment.xml
frag aforo-metering outbound-policy.xml            # or policy-fragment.xml (minimal); not both
frag aforo-jwt-validation jwt-validation-policy.xml  # optional
```

Fragments contain only policies — no `<inbound>`/`<outbound>` wrappers — because Azure does not allow section elements or `<base />` in a fragment, nor one fragment including another. Where each runs is decided by where you include it (Step 3).

## Step 3 — Wire fragments into the API policy

```xml
<policies>
    <inbound>
        <base />
        <include-fragment fragment-id="aforo-jwt-validation" />   <!-- optional; before aforo-context -->
        <include-fragment fragment-id="aforo-context" />          <!-- required -->
        <!-- <include-fragment fragment-id="aforo-preflight" /> -->
        <!-- <include-fragment fragment-id="aforo-margin-guard" /> -->
    </inbound>
    <backend><base /></backend>
    <outbound>
        <base />
        <include-fragment fragment-id="aforo-metering" />
        <!-- <include-fragment fragment-id="aforo-compound-metering" /> -->
    </outbound>
    <on-error><base /></on-error>
</policies>
```

`aforo-context` sets `aforo-customer-id` (JWT `customer_id` claim, else the subscription map) and, when MCP is enabled, captures the request body. Without it every request is skipped as "no customer".

## Step 4 — Send a request and verify it landed

```bash
curl "https://<apim-instance>.azure-api.net/sms/v1/send" -X POST \
  -H "Ocp-Apim-Subscription-Key: <subscription-key>" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
```

In Aforo, confirm one event with `customerId` = the mapped customer (e.g. `cust_123`), `metricName = sms_sent`, `idempotencyKey` = the APIM request id. In the APIM trace for the call, the outbound `send-one-way-request` should carry `X-API-Key` and no `Authorization` header.

Then confirm the negative cases:

- `curl -X OPTIONS …` → no event.
- A subscription not in `aforo-subscription-customer-map`, without an Aforo JWT → no event (trace message `Not metered: no Aforo customer resolved`).
- `-H "X-Customer-Id: someone-else"` → ignored; attribution unchanged.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Policy save fails: named value not found | A referenced Named Value doesn't exist | Create it (use `none` for empty). |
| No events at all | `aforo-context` not included in `<inbound>`, or no customer resolves | Include it; check the JWT `customer_id` claim or add the subscription id to `aforo-subscription-customer-map`. |
| No events, trace shows the send | Ingestor rejected the event: unknown metric (400), unknown customer, or wrong key (401) | `send-one-way-request` discards the response. Check `aforo-default-metric` / mappings exist in the catalog and the key has `usage:ingest`. |
| 401 on every request after adding JWT validation | `aforo-jwks-uri` is a bare JWKS URL (openid-config needs a discovery document), or issuer mismatch | See README "JWKS discovery". |
| MCP requests metered as standard API | `aforo-mcp-enabled` not `true`, or `aforo-context` not in `<inbound>` (the body is captured there) | Fix both. |

## What this guide does NOT cover

- APIM provisioning and networking (reachability of the ingestor, org-service, pricing-service from APIM).
- Retrying or buffering failed sends — `send-one-way-request` is fire-and-forget.
- Fetching metric mappings from catalog automatically.
