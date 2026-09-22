# Aforo Metering — Azure API Management Policy

Azure APIM policy fragments that meter Standard API requests and MCP Server tool invocations from the gateway's outbound phase, plus optional inbound JWT validation, margin-guard, pre-flight quota, and compound metering. Bill API traffic without changing your backend.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## When to reach for this

Reach for the APIM policy when Azure API Management already fronts your API and you want metering at the gateway — no backend code, no client SDK. The metering fragment fires a `send-one-way-request` in `<outbound>` *after* the response is already on its way to the client, so it adds no latency and never fails a request. If the ingestor is unreachable, the event is silently dropped (that's the trade for zero-latency, non-blocking metering).

This is a deployment artifact: you install policy fragments into your APIM instance and set Named Values. There is nothing to `npm install`.

> ⚠ **Identity comes from authenticated sources only.** `customerId` is the verified Aforo JWT's `customer_id` claim, or — for callers without an Aforo JWT — an admin-maintained map from APIM subscription id to Aforo customer id (`aforo-subscription-customer-map`). It is never the subscription **key** (a credential), never a request header, and never a placeholder: a request with no resolvable customer is **not metered**.

> ⚠ **Not verified on a live APIM instance.** The fragments are well-formed XML and follow Microsoft's documented fragment rules, but the C# policy expressions have not been compiled or executed by an APIM gateway here. Import them into a non-production instance and use request tracing before relying on them.

## Install

These are XML policy fragments, not a package. Install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/azure-apim
```

| File | Fragment id | Include in | Required? |
|---|---|---|---|
| `jwt-validation-policy.xml` | `aforo-jwt-validation` | `<inbound>`, first | Optional (needed for JWT identity) |
| `context-policy-fragment.xml` | `aforo-context` | `<inbound>`, after jwt-validation | **Required** by every other fragment |
| `preflight-quota-policy-fragment.xml` | `aforo-preflight` | `<inbound>`, after aforo-context | Optional |
| `margin-guard-policy-fragment.xml` | `aforo-margin-guard` | `<inbound>`, after aforo-context | Optional |
| `outbound-policy.xml` | `aforo-metering` | `<outbound>` | **Required** (full: MCP + trace) |
| `policy-fragment.xml` | `aforo-metering` | `<outbound>` | Alternative minimal variant — import one of the two, not both |
| `compound-metering-policy-fragment.xml` | `aforo-compound-metering` | `<outbound>` | Optional |

Per [Microsoft's policy-fragment rules](https://learn.microsoft.com/azure/api-management/policy-fragments), a fragment **cannot contain section elements** (`<inbound>`, `<outbound>`, …) or `<base />`, and **cannot include another fragment**. Five of these files previously wrapped their policies in `<inbound>`/`<outbound>`, and `mcp-policy-fragment.xml` included another fragment; the former are fixed and the latter is removed (MCP detection lives in `outbound-policy.xml`). The section each fragment belongs in is now decided by where you include it, per the table above.

```bash
az apim policy-fragment create \
  --resource-group "<rg>" --service-name "<apim-instance>" \
  --policy-fragment-id "aforo-metering" \
  --value @outbound-policy.xml --format xml
```

## Quickstart

1. Create the Named Values (see Configuration). **Every Named Value a fragment references must exist** — APIM rejects a policy that references an undefined one. Use the value `none` for ones you want empty.
2. Import `context-policy-fragment.xml` as `aforo-context` and `outbound-policy.xml` as `aforo-metering` (plus `aforo-jwt-validation` if callers present Aforo JWTs).
3. Reference them in the API's policy:

```xml
<policies>
    <inbound>
        <base />
        <include-fragment fragment-id="aforo-jwt-validation" />  <!-- optional -->
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

Each metered call POSTs to `{{aforo-endpoint}}` with the header `X-API-Key: {{aforo-api-key}}` only (no `Authorization`, no `X-Tenant-Id` — the ingestor derives the tenant from the key, and answers 401 if an `Authorization: Bearer` header is present):

```json
{
  "events": [
    {
      "customerId": "cust_123",
      "metricName": "api_calls",
      "quantity": 1,
      "idempotencyKey": "<context.RequestId>",
      "occurredAt": "2026-06-29T10:15:42.3180000Z",
      "endpointPath": "/accounts/v1/accounts/123",
      "httpMethod": "GET",
      "statusCode": 200,
      "responseTimeMs": 42,
      "trace": { "traceparent": "00-...", "tracestate": "...", "xTraceId": null, "xRequestId": null },
      "metadata": { "gateway": "azure-apim", "method": "GET", "path": "/accounts/v1/accounts/123", "status": 200, "latency": 42, "subscription": "acme-prod", "operation": "get-account" }
    }
  ]
}
```

Not metered: `OPTIONS` (CORS preflights) and requests with no resolvable customer (or one longer than 64 characters).

When `aforo-mcp-enabled` is `true` and the POST body (captured in `<inbound>` by `aforo-context`) is a JSON-RPC `tools/call`, the event instead carries `metricName: "mcp_server.tool_invocations"`, `toolName`, `agentId` (from `params._meta.agent_id`), and `sessionId` (from `Mcp-Session-Id`), with `productType: "MCP_SERVER"` when `params._meta.agent_id` is present (the ingestor requires it for `MCP_SERVER`); without one the event keeps the configured `aforo-product-type`.

Every event carries `productType`, which the ingestor requires: the Named Value `aforo-product-type` (default `API`; `none` = `API`), trimmed and upper-cased. A per-API override is a `<set-variable name="aforo-product-type" value="AGENTIC_API" />` placed before `aforo-context` in that API's `<inbound>`. Configured types whose required fields a gateway cannot supply (`AI_AGENT`, `MCP_SERVER`, `GRPC_API`, `GRAPHQL_API`, `WEBSOCKET_API`, `MQTT_BROKER`) are not metered (a trace records why), because one invalid event fails the batch; detected MCP tool calls are still sent as `MCP_SERVER`.

## Configuration

Create these as APIM **Named Values** (mark `aforo-api-key` Secret). The fragments reference them with double-brace syntax (`{{name}}`); Named Values are not `context.Variables`, so the previous `context.Variables.GetValueOrDefault("aforo-…")` lookups never resolved. Values are substituted into C# string literals, so they must not contain `"` or `\`.

| Named Value | Used by | What it does |
|---|---|---|
| `aforo-endpoint` | metering | Aforo ingestor batch URL, e.g. `https://api.aforo.ai/v1/ingest/batch`. |
| `aforo-api-key` | metering, compound, quota | Aforo API key, scope `usage:ingest`. Sent as `X-API-Key`. Mark Secret. |
| `aforo-default-metric` | metering | Metric for requests no mapping matches, e.g. `api_calls`. **Must be registered in the Aforo catalog** — an unknown metric fails the batch with 400. |
| `aforo-metric-mappings` | metering | Endpoint→metric rules, first match wins: `KIND\|value\|metricName` separated by `;`, `KIND` = `EXACT`, `PREFIX` or `CONTAINS`, matched against the client-facing path (`context.Request.OriginalUrl.Path`, which includes the API URL suffix). E.g. `PREFIX\|/sms/v1/send\|sms_sent;EXACT\|/otp/v1/verify\|otp_verified`. `none` = no mappings. Same semantics as catalog's `/internal/v1/metrics/gateway-mappings`, supplied as config because these fragments do not fetch it. |
| `aforo-subscription-customer-map` | context | `subscriptionId=customerId` pairs separated by `;` — the Aforo customer for callers without an Aforo JWT. `none` if every caller presents one. Max 4096 characters (a Named Value limit). |
| `aforo-product-type` | context | `productType` on every event, e.g. `API` (`none` = `API`). Overridable per API with a `set-variable` of the same name before `aforo-context`. |
| `aforo-mcp-enabled` | context, metering | `true` to detect JSON-RPC `tools/call` and emit MCP events; otherwise `false`. |
| `aforo-mcp-product-id` | metering | Aforo product ID stamped into MCP event metadata; `none` if unused. |
| `aforo-jwks-uri` | jwt-validation | URL given to `<openid-config>`. That element expects an **OpenID discovery document** (`…/.well-known/openid-configuration`), not a bare JWKS URL — see "What this doesn't cover". |
| `aforo-jwt-issuer` | jwt-validation | Expected `iss` claim, e.g. `https://auth.aforo.ai`. |
| `aforo-org-service-url` | jwt-validation | org-service base URL reachable from APIM, for the jti revocation check (was hardcoded to `http://org-service:8086`). |
| `aforo-margin-guard-enabled` | margin-guard | `true` to enable the pre-flight margin check. |
| `aforo-margin-guard-url` | margin-guard | pricing-service base URL for `/internal/v1/margin-guard/quick-check`. |
| `aforo-tenant-id` | margin-guard only | Tenant for the margin-guard query when the JWT has no `tenant_id`. Not sent to the ingestor. |
| `aforo-preflight-enabled` | quota | `true` to enable the pre-flight quota check. |
| `aforo-preflight-url` | quota | usage-ingestor quota-check URL (`…/api/v1/quota/check`). |
| `aforo-preflight-fallback` | quota | `ALLOW` or `DENY` when the check times out/errors. |
| `aforo-ingestor-url` | compound | Ingestor origin; the fragment appends `/api/v1/ingest/compound`. |
| `aforo-compound-enabled` | compound | `true` to extract multiple metrics from the response body. |
| `aforo-compound-extraction-paths` | compound | `jsonPath=metricName` pairs separated by `;` (was JSON, which cannot be embedded in a C# string literal). |
| `aforo-compound-dimension-paths` | compound | `jsonPath=dimensionKey` pairs, or `none`. |

## Walk me through it

Named Values → import fragments → wire them into an API → forge-header smoke test → confirm the event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Guaranteed delivery.** `send-one-way-request` is fire-and-forget; if `{{aforo-endpoint}}` is down, or the ingestor rejects the event (unknown metric, unknown customer), the event is lost and APIM does not log the response. There is no on-gateway retry/buffer.
- **Live verification.** None of these fragments has been imported into or executed on a real APIM instance. In particular unverified: C# expression compilation (allowed types such as `StringSplitOptions`), `context.Request.OriginalUrl.Path` matching your mapping values, and request-body capture for MCP.
- **JWKS discovery.** `<openid-config>` needs an OpenID Connect discovery document. If Aforo only serves a bare JWKS, `validate-jwt` will not load keys; you would need `<issuer-signing-keys>` with the keys inlined, or a discovery document. Confirm before enabling JWT validation.
- **Central metric mappings.** Kong fetches mappings from catalog; these fragments use the `aforo-metric-mappings` Named Value. Keep it in sync with your catalog by hand (or by automation that updates the Named Value).
- **jti revocation in real time** requires `aforo-org-service-url` to be reachable from APIM; the check is fail-open.
