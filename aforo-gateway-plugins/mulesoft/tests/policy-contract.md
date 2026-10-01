# MuleSoft Aforo Policy — Security Contract Tests

These are the acceptance tests that MUST pass on every v2.x+ release. They lock in the fix for the 2026-04-23 CRITICAL IDOR (advisory `docs/security/2026-04-20-gateway-plugins-idor-advisory.md` findings 1–4).

MuleSoft Anypoint does not ship a lightweight unit-test harness for custom policies, so these are executed as black-box HTTP tests against a deployed API with the policies applied. Wire them into your own CI if you maintain a fork.

## Prerequisites

- An Anypoint API (Mule 4 runtime) with the following policies applied in order:
  1. MuleSoft's **JWT Validation** policy, pointed at a JWKS endpoint controlled by the test. It puts the verified claims in `authentication.properties.claims`, which is where `aforo-metering` reads the customer id.
  2. `aforo-metering` — the package in `mulesoft/aforo-metering/`, published to the org's Exchange.
  3. `aforo-margin-guard` (optional; specification only, not packaged)
  4. `aforo-preflight-quota` (optional; specification only, not packaged)
- `aforo-tenant-id` set to `tenant_test`; `customer-id-claim` and `tenant-id-claim` left empty unless a test says otherwise.
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

**Expected**: gateway returns HTTP 401 from the JWT Validation policy. Zero events reach the ingestor. The metering policy is never invoked.

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

### TEST 7 — AGENTIC_API classification from W3C traceparent header

Locks the P0-5 fix (docs/final/111 Session 4). Per the AGENTIC_API descriptor's `eventSchema.inferenceRule = HAS_TRACE`, a non-MCP request with a resolvable trace id classifies as `productType: AGENTIC_API`.

```bash
curl -X POST "$API_URL/v1/orchestrate" \
  -H "Authorization: Bearer $JWT_LEGIT" \
  -H "Content-Type: application/json" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
  -d '{"task": "summarize"}'
```

**Expected**: ingestor event carries `productType=AGENTIC_API` and `traceId=4bf92f3577b34da6a3ce929d0e0e4736` at top level (the descriptor's four required fields — `endpoint`, `method`, `status_code`, `trace_id` — are all top-level, not in metadata).

### TEST 8 — MCP wins when both signals present

```bash
curl -X POST "$API_URL/v1/mcp" \
  -H "Authorization: Bearer $JWT_LEGIT" \
  -H "Content-Type: application/json" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_docs","_meta":{"agent_id":"agent_01"}}}'
```

**Expected**: ingestor event carries `productType=MCP_SERVER` (MCP branch wins), NOT `AGENTIC_API`. Without `_meta.agent_id` the same call carries the configured `product-type` (default `API`), still not `AGENTIC_API`: the ingestor rejects `MCP_SERVER` without an `agentId`. The trace context is still surfaced under the `trace` sub-object for observability, but `traceId` is NOT stamped at top level (the MCP path never claims AGENTIC_API classification).

### TEST 9 — Malformed traceparent falls through

Any of: `traceparent` with fewer/more than four `-`-separated fields, version=`ff`, all-zero trace_id, all-zero parent_id, non-hex fields — the policy MUST fall through cleanly and send the configured `product-type` (default `API`), never `AGENTIC_API`.

```bash
curl -X GET "$API_URL/v1/hello" \
  -H "Authorization: Bearer $JWT_LEGIT" \
  -H "traceparent: not-a-real-header"
```

**Expected**: ingestor event has `productType=API` and NO `traceId` field. Never claim AGENTIC_API from an unparseable header.

### TEST 10 — x-trace-id fallback for non-OTel callers

Per descriptor `tracing.allowFallback = true`, a non-OTel client that sends `x-trace-id` (but no `traceparent`) still classifies as AGENTIC_API. Descriptor types `trace_id` as String, so the fallback header value is used verbatim (trimmed).

```bash
curl -X GET "$API_URL/v1/hello" \
  -H "Authorization: Bearer $JWT_LEGIT" \
  -H "x-trace-id: legacy-agent-run-42"
```

**Expected**: ingestor event carries `productType=AGENTIC_API` and `traceId=legacy-agent-run-42`. When BOTH `traceparent` (valid) and `x-trace-id` are sent, the W3C traceparent wins.

### TEST 11 — executionStatus on standard API events (OUTCOME_BASED pricing)

Locks the shared status → `executionStatus` table (see the repo README, "Execution status mapping"). Point `$API_URL` at a test upstream that returns the status named in the path (any echo/mock service works).

| Upstream status | Expected `executionStatus` |
|---|---|
| 200, 204, 301, 304 | `SUCCESS` |
| 408, 504 | `TIMEOUT` |
| 499 (only if the runtime surfaces it) | `CANCELLED` |
| 400, 422 | `VALIDATION_FAILED` |
| 401, 403, 429 | `BLOCKED` |
| 404, 409, 500, 502, 503 | `ERROR` |

```bash
for code in 200 204 301 408 504 400 422 401 403 429 404 409 500 502 503; do
  curl -s -o /dev/null -X GET "$API_URL/status/$code" -H "Authorization: Bearer $JWT_LEGIT"
done
```

**Expected**: one ingestor event per request, each with the top-level `executionStatus` from the table. **Regression signal**: a 504 recorded as `ERROR`, a 401/403/429 recorded as anything but `BLOCKED`, a 404 recorded as `VALIDATION_FAILED` (the pre-2026-09-30 table), or any event carrying `executionStatus: null` / `""`.

### TEST 11b — `status-outcomes` overrides

Apply the policy with `status-outcomes: "404=VALIDATION_FAILED, 429=error, 202=PENDING, bogus, 700=ERROR"` and repeat TEST 11 for 404, 429, 202 and 403.

**Expected**: 404 → `VALIDATION_FAILED`, 429 → `ERROR` (value is case-insensitive), 202 → `PENDING`, 403 → `BLOCKED` (not overridden). The `bogus` and `700=ERROR` entries are ignored, and the policy still applies (no DataWeave error in the runtime log). **Regression signal**: any invalid entry breaking the transform, or an override not taking effect.

### TEST 11c — duplicate code: last valid entry wins

Apply the policy with `status-outcomes: "404=SUCCESS, 404=ERROR, 429=PENDING, 429=bogus"` and repeat TEST 11 for 404 and 429.

**Expected**: 404 → `ERROR` (the later entry wins), 429 → `PENDING` (the later entry is invalid, so the earlier valid one stays). Same rule as Kong, AWS, Apigee and Azure. **Regression signal**: 404 → `SUCCESS` means the reduce went back to `acc ++ {(code): outcome}` without removing the earlier key.

### TEST 12 — executionStatus on AGENTIC_API events

```bash
curl -X POST "$API_URL/status/504" \
  -H "Authorization: Bearer $JWT_LEGIT" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
```

**Expected**: ingestor event carries `productType=AGENTIC_API` and `executionStatus=TIMEOUT`.

### TEST 13 — MCP tool call: 504 is TIMEOUT, not ERROR

Send the TEST 8 MCP body (without the traceparent) to an upstream that returns 200, then 504, then 500 — against both `aforo-metering` and `aforo-mcp-metering`.

**Expected**: `executionStatus` is `SUCCESS`, `TIMEOUT`, `ERROR` respectively. Before this change a 504 was `ERROR`. A 2xx response whose body is a JSON-RPC `error` object is still `SUCCESS` on MuleSoft — the policy does not read the (streamed) response payload.

### TEST 14 — Undeterminable status omits the field

If the runtime ever surfaces a missing or non-numeric `attributes.statusCode` (or a 1xx), the event MUST NOT carry an `executionStatus` key at all. This is a code-review check on the DataWeave (`(executionStatus: executionStatus) if executionStatus != null`) rather than a reproducible HTTP test.

### TEST 15 — Default exclusions: 401, 403, 429 produce no event

Apply the policy with `exclude-status-codes` and `exclude-paths` left empty. Use the TEST 11 upstream.

```bash
for code in 401 403 429 404 500; do
  curl -s -o /dev/null -X GET "$API_URL/status/$code" -H "Authorization: Bearer $JWT_LEGIT"
done
```

**Expected**: two events (404 and 500). No event for 401, 403 or 429, and no request from the gateway to the ingestor for those three — check the ingestor access log, not only the event store. **Regression signal**: a POST to `/v1/ingest/batch` with `{"events": []}` means the send is no longer gated on a non-empty array in `aforo-metering/src/main/mule/template.xml`.

### TEST 16 — Default exclusions: health paths produce no event

```bash
for p in /health /health/live /healthz /ready /metrics /metrics/prometheus /v1/health /readiness; do
  curl -s -o /dev/null -X GET "$API_URL$p" -H "Authorization: Bearer $JWT_LEGIT"
done
```

**Expected**: events for `/v1/health` and `/readiness` only. A path is excluded when it equals a default entry (`/health`, `/ready`, `/metrics`) or starts with it.

### TEST 17 — A configured list replaces the default

Apply the policy with `exclude-status-codes: "404, 500"` and `exclude-paths: "/internal"`.

**Expected**: 404 and 500 produce no event; 401, 403 and 429 now DO (each with `executionStatus: BLOCKED`). `/internal/jobs` produces no event; `/health` now does.

### TEST 18 — `none` excludes nothing

Apply the policy with `exclude-status-codes: "none"` and `exclude-paths: "NONE"` (case-insensitive).

**Expected**: an event for every status in TEST 15 and every path in TEST 16.

### TEST 19 — Malformed values are ignored, never an error

Apply the policy with each of these in turn and send a 401 and a 404:

| `exclude-status-codes` | 401 | 404 |
|---|---|---|
| `abc` | metered | metered |
| `abc,404,,9999,40x` | metered | not metered |
| `none,404` | metered | not metered |
| ` , ` | not metered (default) | metered |

**Expected**: the outcomes in the table, the API response unaffected, and no DataWeave error in the runtime log.

### TEST 20 — Exclusions on MCP and AGENTIC_API requests

Repeat TEST 15 with the TEST 8 MCP body (`mcp-enabled: true`) and with the TEST 7 `traceparent` header, against both `aforo-metering` and `aforo-mcp-metering`.

**Expected**: no event for 401, 403 or 429 on either path. An excluded request is not classified at all — no `MCP_SERVER` and no `AGENTIC_API` event.

### TEST 21 — The package installs and applies

1. `mvn clean deploy -Danypoint.org.id=<org id>` in `mulesoft/aforo-metering/`.
2. In API Manager, open a Mule 4 API instance → Policies → Add policy. `Aforo Usage Metering` is listed under Custom.
3. Apply it with `aforo-endpoint`, `aforo-api-key` and `aforo-tenant-id` only.

**Expected**: the policy shows as applied, the runtime log has no template or DataWeave error for the policy, and one request with `JWT_LEGIT` produces one event. **Regression signal**: "policy template could not be rendered" (a Handlebars name the definition does not declare) or a DataWeave compile error naming `try`, `attributes` or `configuration`.

### TEST 22 — Tenant and customer claims

1. With `tenant-id-claim` empty: the event carries `tenantId=tenant_test` (the configured id), whatever the token says.
2. With `tenant-id-claim: tenant_id`: the event carries the token's `tenant_id`; a token without that claim produces no event.
3. With `customer-id-claim: account`: the event carries the token's `account` claim; without it, the `sub` claim.

### TEST 23 — The API call is never affected

Point `aforo-endpoint` at a host that refuses connections and send ten requests.

**Expected**: all ten API responses are unchanged in status, headers, body and latency. The runtime log has one `[aforo-metering] usage event not delivered` WARN per request, after three attempts about one second apart.

### TEST 24 — One request, one idempotency key

Point `aforo-endpoint` at a mock that answers 503 twice, then 200, and send one request.

**Expected**: three POSTs with byte-identical bodies, including the same `idempotencyKey`. Sending the same client request again (same `X-Correlation-Id` header) produces a different key: the key is minted by the policy, not read from a header.

### TEST 25 — Metric name: default, mapping, route-shaped

1. No metric properties set, `GET /v1/hello` → `metricName=api_calls`.
2. `metric-mappings: PREFIX|/v1/search|search_calls;EXACT|/v1/export|exports` → `GET /v1/search/x` sends `search_calls`, `GET /v1/export` sends `exports`, `GET /v1/export/1` and `GET /v1/hello` send `api_calls`.
3. `default-metric: {method} {path}` → `GET /v1/hello` sends `GET /v1/hello`.
4. `default_metric: legacy_calls` with `default-metric` empty → `legacy_calls`. With `default-metric: api_requests` also set → `api_requests` (the hyphenated property wins).
5. `metric-mappings: EXACT|/v1/hello|` (empty metric) → no POST; one WARN `usage event dropped: the metric name is empty or longer than 255 characters`.
6. `default-metric: not_in_catalog` → one POST, the ingestor answers 4xx, no second attempt, one WARN `usage event rejected by the ingestor, not retried` carrying the response body.

### TEST 26 — productType on every event

1. Nothing set → `productType=API`.
2. `product-type: " graphql_api "` → `GRAPHQL_API`.
3. `product_type: grpc_api` with `product-type` empty → `GRPC_API`; with both set, `product-type` wins.
4. A request with a valid `traceparent` → `AGENTIC_API` whatever is configured.

### TEST 27 — Requests that never produce an event

| Request | Expected |
|---|---|
| `OPTIONS /v1/hello` (with or without a JWT) | no POST |
| JWT whose `customer_id` is 65 characters long | no POST |
| `quantity-source: response_size`, response without `Content-Length` | no POST |
| `quantity-source: response_size`, response with `Content-Length: 512` | one event, `quantity=512` |

With DEBUG logging on, each skipped request logs `[aforo-metering] not metered: <reason>`.

### TEST 28 — Ingestor request headers and retried statuses

Point `aforo-endpoint` at a mock that records headers.

1. The POST carries `X-API-Key` and `Content-Type` and neither `Authorization` nor `X-Tenant-Id`.
2. Mock answers 408, then 200 → two POSTs, byte-identical bodies. Same for 429 and 503.
3. Mock answers 400 → one POST, one WARN with the response body.

### TEST 29 — occurredAt is UTC

Run the runtime with `-Duser.timezone=Asia/Kolkata` and send one request.

**Expected**: `occurredAt` is within a few seconds of the current UTC time (not 5 h 30 min ahead) and ends in `Z`.

### TEST 30 — include-metadata

`include-metadata: false` → the event has no `metadata` key; every other field is unchanged. Empty or `true` → `metadata` is present.

## CI integration

Suggested implementation:

- `node mulesoft/tests/policy.test.cjs` runs anywhere and checks structure only (package files present, template and definition agree on every property, the send is gated, idempotency keys untouched, metric / product type / skip / alias rules present). It does not evaluate the DataWeave.
- `mvn clean package` in `mulesoft/aforo-metering/` proves the package assembles. It does not start a Mule runtime.
- `tests/run-contract-tests.sh` (not yet authored): shell script that parameterizes `$API_URL`, issues each cURL, pulls ingestor events via the Aforo internal API, and asserts the expected `customerId` values.
- Wire into customer's Anypoint CI (e.g. MUnit) or run standalone pre-release.

If you maintain a fork: do not ship a v2.x+ release without at least TESTs 1, 2, and 5 passing.
