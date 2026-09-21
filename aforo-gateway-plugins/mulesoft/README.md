# Aforo Metering — MuleSoft Anypoint Custom Policy

Anypoint custom policies that meter Standard API requests and MCP Server tool invocations via a DataWeave transformation in the response phase, with JWT validation, margin-guard, pre-flight quota, and compound metering. Bill API traffic from the gateway, with identity taken only from a verified JWT.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

> ## ⛔ NOT PRODUCTION-READY — requires rebuild as a Mule 4 custom policy (mule-policy Maven project) or Flex Gateway PDK policy
>
> Nothing in this folder can be deployed to Anypoint as-is, and nothing here has been run on a gateway:
>
> - The `*.yaml` files are **not a deployable Anypoint policy format**. A Mule 4 custom policy is a Maven project (`mule-policy` packaging) containing a policy definition YAML (`<name>.yaml` with `id`, `configuration`, …) **plus** a `template.xml` that implements it; the definitions here embed DataWeave/pseudo-flows in YAML, which Anypoint does not execute. They also still send `Authorization: Bearer` + `X-Tenant-Id` and route-shaped metric names (`{method} {path}`), both of which the Aforo ingestor rejects.
> - `template.xml` uses elements that do not exist in Mule 4 policies (`<before-call>`, `<after-call>`) and `${...}` placeholders instead of `{{{...}}}`. Only its request contract was corrected (see CHANGELOG); it is a reference, not a policy.
> - `jwt-validation-config.yaml` carries its Mule flow as a comment to paste into an app — that is not how a gateway policy is applied.
>
> **What a real implementation needs** (either path):
>
> 1. **Mule 4 custom policy**: `mvn archetype:generate` from `api-gateway-custom-policy-archetype`; a `template.xml` built on `<http-policy:proxy>` / `<http-policy:source>` with `<http-policy:execute-next/>` and metering after it, `{{{property}}}` placeholders, and an async `<http:request>` sending **only** `X-API-Key` to `…/v1/ingest/batch`; publish to Exchange with `mvn deploy`, then apply in API Manager.
> 2. **Flex Gateway PDK policy** (Rust → WASM): read the verified JWT `customer_id` from the JWT-validation policy's output, resolve the metric from an EXACT/PREFIX/CONTAINS mapping table (or fetch catalog's `/internal/v1/metrics/gateway-mappings`, as Kong does), and dispatch the event asynchronously.
>
> In both: customer from a verified identity only (skip the event when absent or > 64 chars), skip `OPTIONS`, a default metric that exists in the catalog, quantity > 0, ISO-8601 `occurredAt`, a stable `idempotencyKey` (the request/correlation id), and retry only 5xx/408/429 — any other 4xx is permanent and must be dropped, not retried. Then verify on a real gateway with the contract tests in [`tests/policy-contract.md`](tests/policy-contract.md).

## When to reach for this

Reach for the MuleSoft policy when Anypoint API Manager fronts your API and you want metering applied as a policy — no backend change, no client SDK. The metering policy runs `afterResponse` and emits an `events[]` batch to the Aforo ingestor. Customer/tenant identity is read from flow variables that the JWT-validation policy sets from verified claims — never from a request header.

This is a deployment artifact: you upload policy descriptor YAML to Anypoint Exchange / API Manager and apply policies to an API. There is nothing to `npm install`.

> ⚠ **Policy ordering is enforced by Anypoint, and it's a security boundary.** Every metering / margin-guard / quota policy declares `requiredCharacteristics: [aforo-jwt-validated]`; `jwt-validation-config.yaml` declares `providedCharacteristics: [aforo-jwt-validated]`. Anypoint refuses to apply a metering policy to an API that doesn't have JWT validation applied first. The result: `customerId`/`tenantId` always come from a cryptographically verified JWT (`vars.aforo.customerId` / `vars.aforo.tenantId`), and a request that can't be attributed to an authenticated customer **emits an empty `events` array** (fail-closed on metering — the request still proceeds, but nothing is billed).

## Install

These are Anypoint policy descriptor YAML files, not a package — there is no registry coordinate. The repo is **not yet published** publicly; install from source.

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/mulesoft
# Policy descriptors:
#   jwt-validation-config.yaml      → id: aforo-jwt-validation   (apply FIRST on every API)
#   mule-policy.yaml                → id: aforo-metering          (standard + MCP)
#   mcp-mule-policy.yaml            → id: aforo-mcp-metering      (MCP-only alternative)
#   margin-guard-policy.yaml        → id: aforo-margin-guard      (optional)
#   preflight-quota-policy.yaml     → id: aforo-preflight-quota   (optional)
#   compound-metering-policy.yaml   → id: aforo-compound-metering (optional)
```

Publish each policy to your Anypoint organization (Exchange), then apply it to an API in API Manager. `jwt-validation-config.yaml` also needs the Mule JWT Module on the gateway (`com.mulesoft.modules:mule-jwt-module`, classifier `mule-plugin`) and the inline Mule flow XML from that file's comment block placed in your gateway project.

## Quickstart

1. Apply `aforo-jwt-validation` to your API (with `AFORO_JWKS_URI` + `AFORO_JWT_ISSUER` set as Anypoint Runtime Secrets).
2. Apply `aforo-metering` to the same API — Anypoint enforces it goes after JWT validation.
3. Set the metering policy's properties (see Configuration).

The descriptors *intend* this batch in the response phase (they currently send it with `Authorization: Bearer` + `X-Tenant-Id` and a route-shaped metric, which the ingestor rejects — see the notice above; the correct contract is `X-API-Key` only and a catalog metric name):

```json
{
  "events": [
    {
      "customerId": "cust_legit",
      "tenantId": "tenant_acme",
      "metricName": "GET /v1/accounts/123",
      "quantity": 1,
      "idempotencyKey": "<attributes.requestId>",
      "occurredAt": "2026-06-29T10:15:42.318Z",
      "endpointPath": "/v1/accounts/123",
      "httpMethod": "GET",
      "statusCode": 200,
      "responseTimeMs": 42,
      "trace": { "traceparent": "00-...", "tracestate": "...", "xTraceId": null, "xRequestId": null },
      "metadata": { "gateway": "mulesoft", "method": "GET", "path": "/v1/accounts/123", "status": 200 }
    }
  ]
}
```

`customerId` is `vars.aforo.customerId` (the verified JWT `customer_id`/`sub`). With no authenticated identity, `events` is `[]`.

When `mcp-enabled = true` and the body is a JSON-RPC `tools/call`, the event carries `metricName: "mcp_server.tool_invocations"`, `productType: "MCP_SERVER"`, `toolName` (`params.name`), `agentId` (`params._meta.agent_id`), and `sessionId` (`Mcp-Session-Id` header).

## Configuration

Set these as policy properties in Anypoint API Manager for the metering policy (`aforo-api-key` is `sensitive`).

| Property | Used by | Default | What it does |
|---|---|---|---|
| `aforo-endpoint` | metering | — (required) | Aforo ingestor batch URL, e.g. `https://ingest.aforo.ai/v1/ingest/batch`. |
| `aforo-api-key` | metering | — (required, sensitive) | Aforo API key. Must be sent as `X-API-Key` (the descriptors still send it as Bearer — not fixed). |
| `aforo-tenant-id` | metering, margin-guard | — (required) | Admin-pinned tenant; used as the tenant fallback when the JWT carries no `tenant_id`. |
| `mcp-enabled` | metering | `false` | Enable JSON-RPC `tools/call` detection. |
| `mcp-product-id` | metering | — | Aforo product ID stamped into MCP event metadata. |
| `jwks-uri` | jwt-validation | — (required) | Aforo JWKS URL, e.g. `https://auth.aforo.ai/.well-known/jwks.json`. |
| `jwt-issuer` | jwt-validation | `https://auth.aforo.ai` | Expected `iss`; blank skips issuer check. |
| `jwks-cache-ttl-seconds` | jwt-validation | `3600` | JWKS cache lifetime. |
| `org-service-token-check-url` | jwt-validation | — | jti/client revocation check endpoint (fail-open). |
| `enabled` (margin-guard) | margin-guard | `false` | Enable the pre-flight margin check. |
| `marginGuardUrl` | margin-guard | — | pricing-service base URL for `/internal/v1/margin-guard/quick-check`. |
| `tenantId` (margin-guard) | margin-guard | — | Admin-pinned tenant fallback (JWT `tenant_id` preferred). |
| `enabled` (quota) | preflight-quota | `false` | Enable the pre-flight quota check. |
| `preflightUrl` | preflight-quota | — | usage-ingestor quota-check URL. |
| `fallback` | preflight-quota | `ALLOW` | Decision on timeout/error (`ALLOW` or `DENY`). |
| `enabled` (compound) | compound | `false` | Enable compound metric extraction. |
| `extractionPaths` | compound | — | JSON map of DataWeave/JSONPath → metric name. |
| `dimensionPaths` | compound | — | JSON map of path → dimension key. |
| `ingestorUrl` | compound | — | Ingestor base URL for `/api/v1/ingest/compound/batch`. |

For JWT validation, set `AFORO_JWKS_URI` and `AFORO_JWT_ISSUER` as Anypoint Runtime Secrets — see `jwt-validation-config.yaml` for the full property list and the inline Mule flow.

## Walk me through it

Apply JWT validation → apply metering → set properties → forge-header smoke test → confirm the event in Aforo: [USER_GUIDE.md](USER_GUIDE.md). The black-box contract tests live in [`tests/policy-contract.md`](tests/policy-contract.md).

## What this doesn't cover

- **Authorization.** These are metering/QoS policies, not auth. JWT validation rejects bad tokens (401), but a valid token that lacks an `aforo` identity simply means no billing event — the request still proceeds.
- **The Mule flow internals of JWT validation.** `jwt-validation-config.yaml` ships the descriptor plus the flow XML as a comment block to paste into your gateway project; wiring it into your specific Mule app is your build.
- **Guaranteed delivery of the async metering POST.** The DataWeave runs after the response; an ingestor outage drops the event (no on-gateway buffer for the standard metering policy).
