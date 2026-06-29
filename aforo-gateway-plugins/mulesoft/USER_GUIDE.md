# Aforo Metering — MuleSoft Anypoint Custom Policy — User Guide

**Version:** 2.0.0 · **Updated:** 2026-06-29 · **Audience:** engineers who own a MuleSoft Anypoint API and need gateway-level metering for Aforo billing.

## What you'll build

A MuleSoft API in Anypoint API Manager with JWT validation + Aforo metering applied, emitting a usage event after every response with customer/tenant identity taken from the verified JWT. By the end you'll have called the API and confirmed the event landed in Aforo — plus a forged-header check proving a spoofed `X-Client-Id` is ignored.

## Prerequisites

- An **Anypoint Platform** org with API Manager, and an API you can apply policies to.
- The **Mule JWT Module** available to your gateway (`com.mulesoft.modules:mule-jwt-module`, classifier `mule-plugin`).
- Aforo `ingestor_url`, `api_key`, `tenant_id`, and your Aforo **JWKS URI** + **issuer**.
- Two test JWTs signed by that JWKS with different `customer_id` claims (for the security check in Step 6).
- Optional: pricing-service URL (margin-guard), usage-ingestor quota URL (pre-flight quota).

## Step 1 — Publish the policy descriptors to your org

Publish each YAML to Anypoint Exchange so it appears in API Manager's policy list. At minimum you need `jwt-validation-config.yaml` and `mule-policy.yaml`.

```bash
cd SDKs/aforo-gateway-plugins/mulesoft
# Publish via the Anypoint CLI or Exchange UI. Policy ids are declared in each file:
#   aforo-jwt-validation, aforo-metering, aforo-mcp-metering,
#   aforo-margin-guard, aforo-preflight-quota, aforo-compound-metering
```

> ⚠ `jwt-validation-config.yaml` is a descriptor *plus* an inline Mule flow (in its comment block). Paste that flow into your gateway project (`src/main/mule/aforo-jwt-validation.xml`) and add the Mule JWT Module dependency — the descriptor alone doesn't validate tokens.

## Step 2 — Set JWT validation secrets

In Anypoint Runtime Secrets Manager (or secure properties), set:

```
AFORO_JWKS_URI   = https://auth.aforo.ai/.well-known/jwks.json
AFORO_JWT_ISSUER = https://auth.aforo.ai
```

## Step 3 — Apply JWT validation to the API

In API Manager → your API → Policies → Apply, select **Aforo JWT Validation**. This declares the `aforo-jwt-validated` capability that the metering policy requires.

## Step 4 — Apply the metering policy

Apply **Aforo Metering Policy** to the same API.

> ⚠ Anypoint enforces ordering via `requiredCharacteristics`. If JWT validation isn't applied first, Anypoint **rejects** the metering policy configuration — that's the security boundary working, not a bug. Apply JWT validation, then metering.

Set the metering policy properties:

| Property | Value |
|---|---|
| `aforo-endpoint` | `https://ingest.aforo.ai/v1/ingest/batch` |
| `aforo-api-key` | your Aforo API key (sensitive) |
| `aforo-tenant-id` | `tenant_acme` (admin-pinned tenant fallback) |
| `mcp-enabled` | `false` (set `true` only if fronting an MCP server) |

## Step 5 — Enable MCP metering (only if fronting an MCP server)

Either set `mcp-enabled = true` on the standard `aforo-metering` policy, or apply the dedicated `aforo-mcp-metering` policy. Both branch on a JSON-RPC `tools/call` body and emit `mcp_server.tool_invocations`.

> ⚠ `agentId` is read only from the request body's `params._meta.agent_id` — the `X-Agent-Id` header fallback was removed in v2.0.0. If your clients don't put the agent in `_meta`, `agentId` is empty.

## Step 6 — Call the API and verify it landed

Call through the gateway with a valid JWT and trace headers:

```bash
curl -X GET "https://<your-app>.cloudhub.io/v1/accounts/123" \
  -H "Authorization: Bearer <JWT_FOR_cust_legit>" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
  -H "tracestate: congo=t61rcWkgMzE"
```

In Aforo's usage view, filter to your tenant and confirm one event with `customerId = cust_legit` (the JWT value), `metricName = "GET /v1/accounts/123"`, `statusCode = 200`, `trace.traceparent = 00-4bf9...`.

Now the security check and the no-JWT check:

```bash
# Forged X-Client-Id must be IGNORED — event still attributes to the JWT customer.
curl -X GET "https://<your-app>.cloudhub.io/v1/accounts/123" \
  -H "Authorization: Bearer <JWT_FOR_cust_legit>" \
  -H "X-Client-Id: cust_victim"
# Expected: ingestor event carries customerId=cust_legit, NOT cust_victim.

# No JWT → 401 at the validation policy, request never reaches metering.
curl -X GET "https://<your-app>.cloudhub.io/v1/accounts/123"
# Expected: 401 invalid_token.
```

> ⚠ If the forged-header request produces `customerId=cust_victim`, the IDOR has regressed — you're running a pre-v2.0.0 policy. Re-publish `mule-policy.yaml`.

This is exactly TEST 1–2 from [`tests/policy-contract.md`](tests/policy-contract.md); run the full matrix there before shipping a fork.

## Configuration reference

See the README's Configuration table for every property. Core: `aforo-endpoint`, `aforo-api-key`, `aforo-tenant-id`. JWT: `jwks-uri`/`AFORO_JWKS_URI`, `jwt-issuer`/`AFORO_JWT_ISSUER`, `jwks-cache-ttl-seconds`, `org-service-token-check-url`. MCP: `mcp-enabled`, `mcp-product-id`. Margin-guard: `enabled`, `marginGuardUrl`, `tenantId`. Quota: `enabled`, `preflightUrl`, `fallback`. Compound: `enabled`, `extractionPaths`, `dimensionPaths`, `ingestorUrl`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Anypoint won't let me apply the metering policy | The API has no `aforo-jwt-validation` policy, so the `aforo-jwt-validated` capability the metering policy requires is missing. | Apply JWT validation first (Step 3), then metering. |
| Event lands but `events` array is empty / no event at all | `vars.aforo.customerId` or `vars.aforo.tenantId` is empty — the metering policy fails closed and writes no event. | Confirm the JWT validation flow actually sets those vars (the inline flow's Step 3). A valid token with no `customer_id`/`sub` and `tenant_id` won't be metered. |
| Forged `X-Client-Id` shows up as the customer | You're running a pre-v2.0.0 policy that trusted the header. | Re-publish `mule-policy.yaml` / `mcp-mule-policy.yaml`. v2.0.0 reads only `vars.aforo.*`. |
| 401 on every request after applying JWT validation | Wrong `AFORO_JWKS_URI`/`AFORO_JWT_ISSUER`, expired token, or the Mule JWT Module flow isn't wired. | Verify the secrets and that the inline JWT flow + `mule-jwt-module` dependency are in the gateway project. |
| No event reaches the ingestor, request succeeded | The metering POST runs `afterResponse` and is best-effort; `aforo-endpoint` unreachable or `aforo-api-key` wrong. | Check gateway logs for the HTTP requester error. There's no on-gateway buffer for standard metering. |
| Margin-guard returns 429 unexpectedly | The quick-check resolved a customer + tenant and blocked (L3) or throttled (L2). | Confirm the endpoint should be guarded; public endpoints with no resolved `vars.aforo.customerId` skip the check by design. |
| MCP requests metered as standard API | `mcp-enabled` is `false`, or the body isn't a JSON-RPC `tools/call` (must be `jsonrpc: "2.0"`, `method: "tools/call"`). | Set `mcp-enabled = true` and confirm the request body shape. |

## What this guide does NOT cover

- **Building/deploying the Mule gateway app itself** (CloudHub/RTF, the JWT-module wiring beyond the supplied inline flow). That's your Anypoint deployment.
- **The Aforo product/rate-plan configuration** that consumes these events — set that up in the Aforo console.
- **Compound-metering path design** — the policy runs whatever `extractionPaths` map you supply against your response body; designing it for your payload is on you.
