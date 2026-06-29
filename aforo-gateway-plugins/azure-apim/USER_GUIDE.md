# Aforo Metering — Azure APIM Policy — User Guide

**Version:** 2.0.0 · **Updated:** 2026-06-29 · **Audience:** engineers who own an Azure API Management instance and need gateway-level metering for Aforo billing.

## What you'll build

An APIM API that fires a non-blocking usage event to Aforo after every response, with customer/tenant identity taken from a verified JWT (or the APIM subscription). By the end you'll have made one request through the gateway and confirmed the event landed in Aforo with the correct customer attribution — including a forged-header check proving a spoofed `X-Customer-Id` is ignored.

## Prerequisites

- An **Azure API Management** instance and an API you can edit policies on.
- Permission to create **Named Values** and **Policy Fragments** (portal or `az apim`).
- Aforo `ingestor_url`, `api_key`, `tenant_id`, and (for JWT identity) your Aforo JWKS URI + issuer.
- Optional: a pricing-service URL (margin-guard) and usage-ingestor quota URL (pre-flight quota).

## Step 1 — Create the Named Values

Set the three core values. Mark the API key Secret.

```bash
RG="<resource-group>"; APIM="<apim-instance>"

az apim nv create -g "$RG" --service-name "$APIM" \
  --named-value-id aforo-endpoint --display-name aforo-endpoint \
  --value "https://ingest.aforo.ai/v1/ingest/batch"

az apim nv create -g "$RG" --service-name "$APIM" \
  --named-value-id aforo-api-key --display-name aforo-api-key \
  --secret true --value "sk_live_..."

az apim nv create -g "$RG" --service-name "$APIM" \
  --named-value-id aforo-tenant-id --display-name aforo-tenant-id \
  --value "tenant_acme"
```

If you'll use JWT-based identity, add `aforo-jwks-uri` and `aforo-jwt-issuer` too.

## Step 2 — Import the metering fragment

```bash
az apim policy-fragment create -g "$RG" --service-name "$APIM" \
  --policy-fragment-id aforo-metering \
  --value @outbound-policy.xml --format xml
```

> ⚠ The fragment id MUST be `aforo-metering` — `mcp-policy-fragment.xml` and any inline reference `<include-fragment fragment-id="aforo-metering" />` resolve to that id. Use a different id and the include won't resolve.

## Step 3 — Add JWT validation (required for JWT-based identity)

Without this, `customerId` falls back to the APIM subscription ID and `tenantId` to the `aforo-tenant-id` Named Value — workable, but per-customer attribution and margin-guard/quota scoping need the JWT.

```bash
az apim policy-fragment create -g "$RG" --service-name "$APIM" \
  --policy-fragment-id aforo-jwt-validation \
  --value @jwt-validation-policy.xml --format xml
```

The fragment runs `validate-jwt` (RS256 via JWKS), returns 401 on failure, and sets `context.Variables["aforo-jwt-payload"]` for downstream policies to read verified claims.

> ⚠ `jwt-validation-policy.xml` ships with a synchronous `send-request` jti-blocklist check against `org-service` (Option A — real-time revocation, ~5–10ms). If org-service isn't reachable from APIM, comment that block out to use Option B (accept the validate-jwt cache TTL window). It is `ignore-error="true"` and fail-open, so a timeout won't 401 a valid token.

## Step 4 — Wire fragments into the API policy

Edit the API's policy. Order matters: JWT validation in `<inbound>` runs before anything that reads identity; metering runs in `<outbound>`.

```xml
<policies>
    <inbound>
        <base />
        <include-fragment fragment-id="aforo-jwt-validation" />
        <!-- optional pre-flight gates (each gated by its *-enabled Named Value): -->
        <!-- <include-fragment fragment-id="aforo-margin-guard" /> -->
        <!-- <include-fragment fragment-id="aforo-preflight" /> -->
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

> ⚠ Margin-guard reads its identity from `context.Variables["aforo-jwt-payload"]`. If you include `aforo-margin-guard` but NOT `aforo-jwt-validation` before it, it has no JWT payload, `mgCustomerId` falls back to the subscription ID, and if that's also empty the check is skipped (treated as anonymous) — it never reads a request header.

## Step 5 — Enable MCP metering (only if you front an MCP server)

Set the optional Named Values, then the same `aforo-metering` fragment branches on the JSON-RPC body automatically:

```bash
az apim nv create -g "$RG" --service-name "$APIM" \
  --named-value-id aforo-mcp-enabled --display-name aforo-mcp-enabled --value "true"
az apim nv create -g "$RG" --service-name "$APIM" \
  --named-value-id aforo-mcp-product-id --display-name aforo-mcp-product-id --value "prod_mcp_search"
```

A POST whose body contains `tools/call` now emits `metricName: "mcp_server.tool_invocations"` with `toolName`, `agentId`, and `sessionId`.

> ⚠ `agentId` comes only from the request body's `params._meta.agent_id` — never from an `X-Agent-Id` header (that fallback was removed in v2.0.0). If your clients don't put the agent in `_meta`, `agentId` is empty.

## Step 6 — Send a request and verify it landed

Make a normal request through the gateway, including W3C trace headers so you can confirm capture:

```bash
curl -X GET "https://<apim-instance>.azure-api.net/v1/accounts/123" \
  -H "Ocp-Apim-Subscription-Key: <subscription-key>" \
  -H "Authorization: Bearer <valid-aforo-jwt>" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
  -H "tracestate: congo=t61rcWkgMzE"
```

In Aforo's usage/ingestion view, filter to your tenant and confirm one event with:
`metricName = "GET /v1/accounts/123"`, `httpMethod = GET`, `statusCode = 200`, `trace.traceparent = 00-4bf9...`, and `customerId` equal to the JWT's `customer_id` (or the subscription ID if you skipped Step 3).

Now the security check — a forged identity header MUST be ignored:

```bash
curl -X GET "https://<apim-instance>.azure-api.net/v1/accounts/123" \
  -H "Ocp-Apim-Subscription-Key: <subscription-key>" \
  -H "Authorization: Bearer <jwt-for-customerA>" \
  -H "X-Customer-Id: customerB"
```

> ⚠ Expected: the event attributes usage to **customerA** (the JWT value), not customerB (the header). If you see customerB, JWT validation didn't run before metering — recheck Step 4 ordering.

## Configuration reference

See the README's Configuration table for the full Named Value list. Core (always needed): `aforo-endpoint`, `aforo-api-key`, `aforo-tenant-id`. JWT identity: `aforo-jwks-uri`, `aforo-jwt-issuer`. MCP: `aforo-mcp-enabled`, `aforo-mcp-product-id`. Margin-guard: `aforo-margin-guard-enabled`, `aforo-margin-guard-url`. Quota: `aforo-preflight-enabled`, `aforo-preflight-url`, `aforo-preflight-fallback`. Compound: `aforo-ingestor-url`, `aforo-compound-enabled`, `aforo-compound-extraction-paths`, `aforo-compound-dimension-paths`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No event in Aforo, request succeeded | `send-one-way-request` is fire-and-forget; `aforo-endpoint` unreachable from APIM, or wrong URL/key. | Verify `aforo-endpoint` + `aforo-api-key` Named Values. There's no retry on the gateway — confirm APIM's outbound network reaches the ingestor. |
| Event lands but `customerId` is the subscription ID, not the JWT customer | `aforo-jwt-validation` isn't running before metering, so there's no `aforo-jwt-payload`. | Include `aforo-jwt-validation` in `<inbound>` before the API resolves identity (Step 4). |
| Forged `X-Customer-Id` shows up as the customer | Same as above — without the JWT payload, attribution falls back to the subscription, but a header should never win. If a header value appears, you're running a pre-v2.0.0 fragment. | Re-import the current `outbound-policy.xml` / `margin-guard-policy-fragment.xml`. v2.0.0 never reads identity headers. |
| 401 on every request after adding JWT validation | Wrong `aforo-jwks-uri`/`aforo-jwt-issuer`, or the token isn't RS256/expired. | Confirm the JWKS URL serves your Aforo org's keys and `aforo-jwt-issuer` matches the token's `iss`. |
| MCP requests metered as standard API | `aforo-mcp-enabled` not `"true"`, or the body doesn't contain `tools/call` / isn't reachable (`preserveContent`). | Set `aforo-mcp-enabled = "true"` and confirm the request is a POST with a JSON-RPC `tools/call` body. |
| Margin-guard returns 429 on a public endpoint | The endpoint resolved a customer + tenant and the quick-check blocked it. | Public/anonymous endpoints should not carry a JWT or subscription that resolves an identity; if `mgCustomerId`/`mgTenantId` are empty the check is skipped by design. |
| jti revocation not taking effect | You're on Option B (cache-window) or the org-service blocklist call is failing fail-open. | Keep the synchronous `send-request` block (Option A) and ensure org-service `/internal/v1/auth/token-check` is reachable from APIM. |

## What this guide does NOT cover

- **APIM provisioning and networking** (VNet integration, the route from APIM to your ingestor/pricing-service). That's your Azure setup.
- **Writing the Aforo product / rate plan** that consumes these events — configure that in the Aforo console.
- **Compound-metering extraction-path design.** The fragment runs whatever JSONPath→metric map you put in `aforo-compound-extraction-paths`; designing that map for your response shape is on you.
