# MuleSoft Aforo Policy — Security Contract Tests

These are the acceptance tests that MUST pass on every v2.x+ release. They lock in the fix for the 2026-04-23 CRITICAL IDOR (advisory `docs/security/2026-04-20-gateway-plugins-idor-advisory.md` findings 1–4).

MuleSoft Anypoint does not ship a lightweight unit-test harness for custom policies, so these are executed as black-box HTTP tests against a deployed API with the policies applied. Wire them into your own CI if you maintain a fork.

## Prerequisites

- An Anypoint API with the following policies applied in order:
  1. `aforo-jwt-validation`
  2. `aforo-metering` (or `aforo-mcp-metering`)
  3. `aforo-margin-guard` (optional)
  4. `aforo-preflight-quota` (optional)
- `AFORO_JWKS_URI` configured to a JWKS endpoint controlled by the test.
- Two test JWTs signed by that JWKS with different `customer_id` claims:
  - `JWT_LEGIT` — `customer_id=cust_legit`, `tenant_id=tenant_test`
  - `JWT_VICTIM` — `customer_id=cust_victim`, `tenant_id=tenant_test`
- Access to the Aforo usage ingestor's DLQ / event log for the target tenant.

## Test matrix

### TEST 1 — Header spoof is ignored

```bash
curl -X GET "$API_URL/v1/hello" \
  -H "Authorization: Bearer $JWT_LEGIT" \
  -H "X-Client-Id: cust_victim"
```

**Expected**: ingestor receives one event with `customerId=cust_legit`. The `cust_victim` value in the header is ignored.

**Regression signal**: if the ingestor event carries `customerId=cust_victim`, the IDOR has regressed.

### TEST 2 — No JWT → no metering

```bash
curl -X GET "$API_URL/v1/hello" \
  -H "X-Client-Id: cust_anything"
```

**Expected**: gateway returns HTTP 401 from `aforo-jwt-validation`. Zero events reach the ingestor. The metering policy is never invoked.

### TEST 3 — JWT with no customer_id claim → metering drops the event

A JWT signed by the valid JWKS but missing both `customer_id` and `sub` claims (edge case; should not happen in Aforo-issued JWTs, but exists defensively).

```bash
curl -X GET "$API_URL/v1/hello" \
  -H "Authorization: Bearer $JWT_NO_CUSTOMER_CLAIM"
```

**Expected**: upstream request proceeds (gateway returns the upstream response), but no metering event is written. The DataWeave transformation emits an empty `events` array.

### TEST 4 — MCP tool call identity is JWT-sourced

```bash
curl -X POST "$API_URL/v1/mcp" \
  -H "Authorization: Bearer $JWT_LEGIT" \
  -H "Content-Type: application/json" \
  -H "X-Client-Id: cust_victim" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_docs","_meta":{"agent_id":"agent_01"}}}'
```

**Expected**: ingestor event with `customerId=cust_legit`, `toolName=search_docs`, `agentId=agent_01`, `productType=MCP_SERVER`. `X-Client-Id` is ignored.

### TEST 5 — Margin-guard cache key is per-authenticated-customer

1. First request (JWT_LEGIT, no X-Client-Id) → margin-guard calls pricing-service; result cached under key `mg:tenant_test:cust_legit`.
2. Second request (JWT_VICTIM, `X-Client-Id: cust_legit` spoof attempt) → margin-guard MUST NOT reuse the cust_legit cache entry; MUST call pricing-service scoped to cust_victim.

**Expected**: two distinct pricing-service calls, two distinct cache entries. Header spoof does not poison the cache across customers.

### TEST 6 — Preflight-quota scope-ID is per-authenticated-customer

Same pattern as TEST 5 — spoofing `X-Customer-Id` must not cause the preflight-quota policy to check against a different customer's quota.

## CI integration

Suggested implementation:

- `tests/run-contract-tests.sh` (not yet authored): shell script that parameterizes `$API_URL`, issues each cURL, pulls ingestor events via the Aforo internal API, and asserts the expected `customerId` values.
- Wire into customer's Anypoint CI (e.g. MUnit) or run standalone pre-release.

If you maintain a fork: do not ship a v2.x+ release without at least TESTs 1, 2, and 5 passing.
