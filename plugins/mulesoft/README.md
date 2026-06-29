# Aforo Metering — MuleSoft Custom Policy

Meters Standard API requests and MCP Server tool invocations via MuleSoft Anypoint custom policy.

**Current version**: v2.0.0 (security release — see CHANGELOG.md at repo root for the 2026-04-23 entry).

## Files

| File | Purpose |
|------|---------|
| `jwt-validation-config.yaml` | JWT (RS256) validation policy — MUST be applied on every API before any other Aforo policy |
| `mule-policy.yaml` | Standard metering — handles Standard API + MCP Server detection with W3C trace capture |
| `mcp-mule-policy.yaml` | Optional MCP-only metering (alternative deployment shape) |
| `margin-guard-policy.yaml` | Pre-flight margin guard (L2 throttle / L3 block) |
| `preflight-quota-policy.yaml` | Pre-flight quota check |
| `compound-metering-policy.yaml` | Compound metering (bytes in/out + unit cost) |

## Policy ordering is enforced

All metering / margin-guard / quota policies declare `requiredCharacteristics: [aforo-jwt-validated]`. The JWT validation policy declares `providedCharacteristics: [aforo-jwt-validated]`. Anypoint API Manager enforces this — you cannot apply the metering policy to an API without first applying JWT validation. **This is a security boundary**: tenant/customer identity is always sourced from the verified JWT claims, never from a client-settable request header.

## Identity sourcing

| Field | Source | Why |
|-------|--------|-----|
| `customerId` | `vars.aforo.customerId` set by `aforo-jwt-validation` from the JWT `customer_id` / `sub` claim | JWT is cryptographically verified (RS256 + JWKS) |
| `tenantId` | `vars.aforo.tenantId` set by `aforo-jwt-validation` from the JWT `tenant_id` claim; falls back to admin-pinned `configuration.tenantId` (margin-guard only) | JWT primary; admin config is never client-settable |
| `agentId` (MCP) | JSON-RPC `params._meta.agent_id` from the request body | Payload comes after JWT has been verified |
| `tenantId` (admin config) | `configuration.aforo-tenant-id` property set in Anypoint API Manager UI | Admin-pinned, not client-settable |

**Never read** `X-Client-Id`, `X-Customer-Id`, `X-Tenant-Id`, `X-Agent-Id`, or `?customer_id=` from the request for any billing / quota / margin-guard decision. These are client-settable and therefore spoofable.

## Configuration

Set these properties in Anypoint API Manager for the metering policy:

| Property | Description | Required |
|----------|-------------|----------|
| `aforo-endpoint` | Aforo usage ingestor batch URL | Yes |
| `aforo-api-key` | Aforo API key (sensitive) | Yes |
| `aforo-tenant-id` | Your Aforo tenant ID (admin-pinned fallback) | Yes |
| `mcp-enabled` | Enable MCP JSON-RPC detection | No (default: false) |
| `mcp-product-id` | Aforo product ID for MCP server | No |

For JWT validation, set `AFORO_JWKS_URI` and `AFORO_JWT_ISSUER` as Anypoint Runtime Secrets — see `jwt-validation-config.yaml` for the full list.

## Fail-closed behavior

If a request somehow reaches a metering policy without JWT validation having populated `vars.aforo.customerId` + `vars.aforo.tenantId` (which should be impossible given `requiredCharacteristics` enforcement), the DataWeave transformation emits an empty `events` array. **The upstream request still proceeds** — this is a metering-only policy, not an authorization policy — but no billing event is written. A request that cannot be attributed to an authenticated customer must never be billed.

Margin-guard and preflight-quota policies skip their check when `vars.aforo.customerId` is empty. Anonymous / public endpoints legitimately hit this branch.

## W3C Trace Context

The metering policy captures these headers from inbound requests:
- `traceparent` — W3C trace parent header
- `tracestate` — W3C trace state header
- `x-trace-id` — Legacy trace ID header
- `x-request-id` — Legacy request ID header

Absent headers are emitted as `null` (no synthetic values).

## Manual verification

```bash
# 1. Standard API request with a valid JWT — metering event attributed to JWT customer_id
curl -X GET "https://your-mulesoft-app.cloudhub.io/v1/accounts/123" \
  -H "Authorization: Bearer <VALID_JWT>" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
  -H "tracestate: congo=t61rcWkgMzE"

# 2. Security regression test — forged X-Client-Id header must be IGNORED
#    (metering event should still attribute to the JWT's customer_id, not
#    the value of X-Client-Id).
curl -X GET "https://your-mulesoft-app.cloudhub.io/v1/accounts/123" \
  -H "Authorization: Bearer <VALID_JWT_FOR_cust_legit>" \
  -H "X-Client-Id: cust_victim"
# Expected: ingestor event carries customerId=cust_legit (the JWT value),
# NOT cust_victim (the header value).

# 3. Request with no JWT — gateway returns 401 (JWT validation policy fails),
#    never reaches the metering policy.
curl -X GET "https://your-mulesoft-app.cloudhub.io/v1/accounts/123"
# Expected: 401 invalid_token.

# 4. MCP tools/call request with valid JWT
curl -X POST "https://your-mulesoft-app.cloudhub.io/v1/mcp" \
  -H "Authorization: Bearer <VALID_JWT>" \
  -H "Content-Type: application/json" \
  -H "traceparent: 00-abc123-def456-01" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_docs"}}'
```

See `tests/policy-contract.md` for the full contract test matrix.

## Upgrading from v1.x

v2.0.0 removes all support for sourcing tenant/customer identity from request headers. If your deployment was relying on `X-Client-Id` or `X-Customer-Id` for billing attribution (which was the documented-but-insecure default in v1.x), switch to JWT-based authentication:

1. Apply the `aforo-jwt-validation` policy to every API that has an Aforo metering / margin-guard / quota policy.
2. Configure `AFORO_JWKS_URI` to point at your Aforo org's JWKS endpoint.
3. Re-deploy — Anypoint will reject the API configuration if the ordering is wrong.
4. Any client that was sending `X-Client-Id: cust_abc` must switch to `Authorization: Bearer <jwt>`.

The metering payload field name is unchanged (`customerId`), so the ingestor / downstream reporting contract is unchanged.
