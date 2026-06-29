# Aforo Metering — Azure API Management Policy

Azure APIM policy fragments that meter Standard API requests and MCP Server tool invocations from the gateway's outbound phase, plus optional inbound JWT validation, margin-guard, pre-flight quota, and compound metering. Bill API traffic without changing your backend.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## When to reach for this

Reach for the APIM policy when Azure API Management already fronts your API and you want metering at the gateway — no backend code, no client SDK. The metering fragment fires a `send-one-way-request` in `<outbound>` *after* the response is already on its way to the client, so it adds no latency and never fails a request. If the ingestor is unreachable, the event is silently dropped (that's the trade for zero-latency, non-blocking metering).

This is a deployment artifact: you install policy fragments into your APIM instance and set Named Values. There is nothing to `npm install`.

> ⚠ **Identity comes from authenticated sources only.** As of v2.0.0 (the 2026-04-23 security release), none of these policies read `X-Customer-Id` / `X-Tenant-Id` from a request. Customer identity is the JWT `customer_id`/`sub` claim (when `jwt-validation-policy.xml` runs in `<inbound>`) or the APIM subscription ID; tenant is the JWT `tenant_id` claim or the admin-pinned `aforo-tenant-id` Named Value. Forged headers are ignored.

## Install

These are XML policy fragments, not a package — there is no registry coordinate. The repo is **not yet published** publicly; install from source.

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/azure-apim
# Files to import as APIM policy fragments:
#   outbound-policy.xml                   → fragment id: aforo-metering
#   jwt-validation-policy.xml             → fragment id: aforo-jwt-validation
#   margin-guard-policy-fragment.xml      → fragment id: aforo-margin-guard
#   preflight-quota-policy-fragment.xml   → fragment id: aforo-preflight
#   compound-metering-policy-fragment.xml → fragment id: aforo-compound-metering
```

Create the fragment via Azure CLI (repeat per file, matching the fragment id):

```bash
az apim policy-fragment create \
  --resource-group "<rg>" \
  --service-name "<apim-instance>" \
  --policy-fragment-id "aforo-metering" \
  --value @outbound-policy.xml \
  --format xml
```

Or import each file under **APIM → Policy fragments → + Add** in the portal.

## Quickstart

1. Create the required Named Values (see Configuration).
2. Import `outbound-policy.xml` as fragment `aforo-metering`.
3. Reference it in the API's policy:

```xml
<policies>
    <inbound>
        <base />
        <!-- optional, but required for JWT-based identity + margin-guard/quota -->
        <include-fragment fragment-id="aforo-jwt-validation" />
    </inbound>
    <outbound>
        <base />
        <include-fragment fragment-id="aforo-metering" />
    </outbound>
</policies>
```

Each metered call POSTs an `events[]` batch to `{{aforo-endpoint}}` with `Authorization: Bearer {{aforo-api-key}}` and `X-Tenant-Id: {{aforo-tenant-id}}`:

```json
{
  "events": [
    {
      "customerId": "<apim-subscription-id-or-jwt-customer_id>",
      "metricName": "GET /v1/accounts/123",
      "quantity": 1,
      "idempotencyKey": "<context.RequestId>:<ticks>",
      "occurredAt": "2026-06-29T10:15:42.318Z",
      "endpointPath": "/v1/accounts/123",
      "httpMethod": "GET",
      "statusCode": 200,
      "responseTimeMs": 42,
      "trace": { "traceparent": "00-...", "tracestate": "...", "xTraceId": null, "xRequestId": null },
      "metadata": { "gateway": "azure-apim", "method": "GET", "path": "/v1/accounts/123", "status": 200, "latency": 42 }
    }
  ]
}
```

When `aforo-mcp-enabled = "true"` and the request body contains a JSON-RPC `tools/call`, the event instead carries `metricName: "mcp_server.tool_invocations"`, `productType: "MCP_SERVER"`, `toolName`, `agentId` (from `params._meta.agent_id`), and `sessionId` (from the `Mcp-Session-Id` header).

## Configuration

Create these as APIM **Named Values** (mark `aforo-api-key` as Secret). The policies read them as `{{name}}`.

| Named Value | Used by | What it does |
|---|---|---|
| `aforo-endpoint` | metering | Aforo ingestor batch URL, e.g. `https://ingest.aforo.ai/v1/ingest/batch`. |
| `aforo-api-key` | metering, quota | Bearer token for the ingestor. Mark Secret. |
| `aforo-tenant-id` | metering, margin-guard, quota | Your Aforo tenant. Sent as `X-Tenant-Id`; admin-pinned tenant fallback for margin-guard. |
| `aforo-mcp-enabled` | metering | `"true"` to detect JSON-RPC `tools/call` and emit MCP events. Optional. |
| `aforo-mcp-product-id` | metering | Aforo product ID stamped into MCP event metadata. Optional. |
| `aforo-jwks-uri` | jwt-validation | Aforo JWKS endpoint, e.g. `https://auth.aforo.ai/.well-known/jwks.json`. |
| `aforo-jwt-issuer` | jwt-validation | Expected `iss` claim, e.g. `https://auth.aforo.ai`. |
| `aforo-margin-guard-enabled` | margin-guard | `"true"` to enable the pre-flight margin check. |
| `aforo-margin-guard-url` | margin-guard | pricing-service base URL for `/internal/v1/margin-guard/quick-check`. |
| `aforo-preflight-enabled` | quota | `"true"` to enable the pre-flight quota check. |
| `aforo-preflight-url` | quota | usage-ingestor quota-check URL. |
| `aforo-preflight-fallback` | quota | `"ALLOW"` (default) or `"DENY"` when the check times out/errors. |
| `aforo-ingestor-url` | compound | Ingestor base URL for `/api/v1/ingest/compound`. |
| `aforo-compound-enabled` | compound | `"true"` to extract multiple metrics from the response body. |
| `aforo-compound-extraction-paths` | compound | JSON map of JSONPath → metric name. |
| `aforo-compound-dimension-paths` | compound | JSON map of JSONPath → dimension key. |

## Walk me through it

Named Values → import fragments → wire them into an API → forge-header smoke test → confirm the event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Guaranteed delivery.** `send-one-way-request` is fire-and-forget; if `{{aforo-endpoint}}` is down, the event is lost. There is no on-gateway retry/buffer (unlike the client SDKs).
- **Identity without JWT validation.** Without `jwt-validation-policy.xml` in `<inbound>`, `customerId` falls back to the APIM subscription ID. Margin-guard and quota then scope to that subscription, not a JWT customer.
- **jti revocation in real time** unless you keep the synchronous `send-request` blocklist check in `jwt-validation-policy.xml` (it adds ~5–10ms; the commented Option B accepts the validate-jwt cache TTL window instead).
