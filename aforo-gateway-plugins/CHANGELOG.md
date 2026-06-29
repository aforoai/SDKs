# Aforo Gateway Plugins — Changelog

This monorepo ships five gateway metering plugins (Kong, Apigee, AWS Lambda, Azure APIM, MuleSoft). The whole repo is versioned as one — every plugin ships together on the same tag.

## v2.0.0 — 2026-04-23

**Security release** — tenant-ID IDOR fixes across 4 plugins. **BREAKING** for any deployment that was relying on `X-Customer-Id` / `X-Client-Id` / `X-Agent-Id` / `X-Tenant-Id` request headers or `?customer_id=` query params for billing attribution, rate-limit scope, or margin-guard scope.

Closes all 11 findings from the 2026-04-20 security advisory (`docs/security/2026-04-20-gateway-plugins-idor-advisory.md` in the platform monorepo).

### Severity summary

| Plugin | Severity | Findings fixed |
|---|---|---|
| MuleSoft | 2 CRITICAL + 2 HIGH | billing attribution from `X-Client-Id` header (standard + MCP), margin-guard cache-key from `x-customer-id`, preflight-quota scope-ID from `X-Customer-Id` |
| Azure APIM | 2 HIGH | margin-guard `X-Customer-Id` / `X-Tenant-Id` header reads |
| Kong | 1 HIGH + 3 MEDIUM | rate-limit `PER_CUSTOMER` reads `X-Customer-Id`, `customer_id_source: "header"` / `"query_param"` config options, cache-key poisoning in margin-guard + preflight-quota |
| Apigee | 1 MEDIUM | MCP `agentId` fallback to `X-Agent-Id` header |
| AWS Lambda | None (clean) | Documentation cleanup only — removed dead `CUSTOMER_ID_SOURCE='header'` references to prevent future re-introduction |

### What changed

**All five plugins now source tenant/customer identity EXCLUSIVELY from authenticated sources:**

1. A verified JWT claim (cryptographically validated by the plugin's JWT validation policy / filter).
2. A gateway-managed, credential-bound identity (Kong consumer, Apigee `developer.app.name`, Azure APIM `context.Subscription.Id`, API Gateway `$context.identity.apiKey`).
3. An admin-pinned configuration value (Named Value / KVM / Lambda environment variable — set by platform operators, never by end users).

**None of the five plugins will read** `X-Tenant-Id`, `X-Customer-Id`, `X-Client-Id`, `X-Agent-Id`, or `?customer_id=` from a request. Attempted spoofs are silently ignored; authenticated identity wins unconditionally.

### Per-plugin changes

#### Kong (`kong/`) — v2.0.0

- `schema.lua`: removed `"header"` and `"query_param"` from the `customer_id_source` enum. Only `"consumer"` remains.
- `handler.lua` `resolve_customer_id()`: rewritten to prefer JWT-validated claim → Kong consumer identity. Never reads request headers or query params.
- `rate-limit-enforce.lua` line 99: `PER_CUSTOMER` scope now sources customer ID from `kong.ctx.shared.aforo_jwt_claims`, not `X-Customer-Id` request header. Falls back to `key_hash` (per-key scope) when no JWT claim is available — never to an unauthenticated source.
- `margin-guard.lua` + `preflight-quota.lua`: cache keys automatically hardened because the callers now pass JWT-validated customer IDs.
- `spec/handler_spec.lua`: +5 security regression tests covering the IDOR scenarios (requires busted to run).

#### Apigee (`apigee/`) — bundled

- `sharedflowbundle/resources/jsc/aforo-metering.js` line 68: removed the `request.header.X-Agent-Id` fallback. `agentId` is sourced exclusively from the JSON-RPC payload's `params._meta.agent_id`.
- `sharedflowbundle/resources/jsc/aforo-mcp-metering.js` line 57: same fix for the MCP-only variant.
- `tests/unit-tests.cjs`: rewrote the test harness (was broken under ESM-module workspace root) and added 2 security regression tests. All 15 tests pass.

#### AWS Lambda (`aws-lambda/`) — v2.0.0

- `index.js` lines 14, 37, 87: documented that `CUSTOMER_ID_SOURCE='header'` is no longer accepted; the legacy branch was already dead code but is now explicitly called out to prevent future re-introduction.
- `template.yaml`: CloudFormation parameter `CustomerIdSource` allowed values narrowed to `[consumer]` (was `[consumer, header]`).
- `package.json`: bumped to `2.0.0`.
- All 14 existing tests still pass.

#### Azure APIM (`azure-apim/`) — bundled

- `margin-guard-policy-fragment.xml` lines 21-22: rewrote identity sourcing.
  - `mgCustomerId`: primary = JWT `customer_id` claim (from `aforo-jwt-payload` variable set by `jwt-validation-policy.xml`), fallback = `context.Subscription.Id`. Never reads `X-Customer-Id` request header.
  - `mgTenantId`: primary = JWT `tenant_id` claim, fallback = admin-pinned `aforo-tenant-id` Named Value. Never reads `X-Tenant-Id` request header.
- Documentation updated to require `jwt-validation-policy.xml` be applied before any Aforo metering / margin-guard policy.

#### MuleSoft (`mulesoft/`) — bundled

- `jwt-validation-config.yaml`: declares `providedCharacteristics: [aforo-jwt-validated]` — Anypoint API Manager capability token that downstream policies consume.
- `mule-policy.yaml`, `mcp-mule-policy.yaml`, `margin-guard-policy.yaml`, `preflight-quota-policy.yaml`: all declare `requiredCharacteristics: [aforo-jwt-validated]`. Anypoint now enforces policy ordering — metering cannot be applied to an API without JWT validation being applied first.
- `mule-policy.yaml` + `mcp-mule-policy.yaml` DataWeave transformations: `customerId` sourced from `vars.aforo.customerId` (set by JWT validation). If the authenticated identity is missing, the transformation emits an empty `events` array (fail-closed on metering — the upstream request proceeds but no billing event is written).
- `margin-guard-policy.yaml` lines 67-73: `mgCustomerId` from `vars.aforo.customerId`; `mgTenantId` prefers JWT-validated var, falls back to admin-pinned configuration.
- `preflight-quota-policy.yaml`: documentation rewritten to instruct implementers to use `vars.aforo.customerId` as the quota scope-ID.
- New `tests/policy-contract.md`: 6 black-box HTTP contract tests for fork maintainers to run.

### Upgrading from v1.x

**Before upgrading**, audit every deployment for:

1. Kong plugin configs with `customer_id_source: "header"` or `"query_param"` — change to `"consumer"` (or enable `jwt_validation_enabled`).
2. AWS Lambda deployments with `CUSTOMER_ID_SOURCE=header` environment variable — remove it.
3. Client applications that send `X-Client-Id` / `X-Customer-Id` headers for identity attribution — switch to `Authorization: Bearer <jwt>`.
4. MuleSoft API gateway configurations — apply `aforo-jwt-validation` on every API before the metering / margin-guard / quota policies. Anypoint will reject the configuration if the order is wrong.
5. Azure APIM — include `jwt-validation-policy.xml` in `<inbound>` before `margin-guard-policy-fragment.xml`.

After upgrade, verify with a forged-header smoke test:

```bash
# Request with valid JWT for customerA but spoofed X-Client-Id: customerB
curl -X GET "$GATEWAY/api/endpoint" \
  -H "Authorization: Bearer $JWT_FOR_customerA" \
  -H "X-Client-Id: customerB"
```

Expected: ingestor event attributes the usage to `customerA` (JWT-validated), not `customerB` (header spoof).

### Pre-launch note

Aforo has no deployed customers on v1.x at the time of this release (pre-launch status as of 2026-04). There is no deprecation window: v1.x is not receiving security fixes. All deployments should go directly to v2.0.0.

---

## v1.1.0 — 2026-04-16

- Lambda authorizer: RESP TCP accumulation + negative JWKS caching (commit `d00dd86`)

## v1.0.0 — 2026-04-01

- Initial release: JWT/JWKS validation across all 5 gateway plugins
- Kong rate-limit enforcement plugin (sliding-window, Redis)
