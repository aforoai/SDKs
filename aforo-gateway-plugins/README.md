# Aforo Gateway Metering Plugins

**Current version**: 2.2.0 for all five plugins (2026-10-02). Each plugin directory has its own `VERSION` / `CHANGELOG.md` / `USER_GUIDE.md`; `CHANGELOG.md` here is the cross-plugin history. 2.2.0 merges the public 2.1.0 release (Gowtham, Eswar) with this repository's line.

Gateway plugins that capture API usage events at the edge and forward them to the Aforo usage ingestor service. Each plugin supports Standard API metering, MCP Server tool invocation detection, and W3C Trace Context capture.

## Security model

All five plugins source tenant/customer identity from **authenticated sources only**: a verified JWT claim, a gateway-managed credential-bound identity, or an admin-pinned configuration value. **No plugin reads `X-Tenant-Id`, `X-Customer-Id`, `X-Client-Id`, or `X-Agent-Id` from request headers** — those are client-settable and therefore spoofable. See `CHANGELOG.md` for the IDOR fixes shipped in v2.0.0.

### Customer identity, per gateway

A request with no verified customer produces no event, on every plugin. None of them uses an API key value, a subscription key or a client IP as `customerId`, and an id longer than 64 characters is not used.

| Gateway | `customerId` comes from |
|---|---|
| Kong | `customer_id_jwt_claim` (claim of the JWT Kong's `jwt` plugin verified; exclusive when set), else the `customer_id` claim of the Aforo JWT the plugin verified itself (`jwt_validation_enabled` + `jwt_public_key`), else the Kong consumer. See `kong/README.md` "Customer identity". |
| AWS Lambda | `$context.authorizer.customerId` in the access log (set by `authorizer.js` from the verified JWT), else the IAM caller. |
| Apigee | The verified JWT claim, else a configured `flow_variable:<name>`, else `developer.app.name` / `developer.email`. |
| Azure APIM | Context variable `aforo-customer-id` (set by the `aforo-context` fragment from the validated JWT or the subscription→customer map), else the subscription id. |
| MuleSoft | `authentication.properties.claims` (MuleSoft's JWT Validation policy), claim named by `customer-id-claim`. |

## Plugins

| Plugin | Directory | Gateway | Phase | Tests |
|--------|-----------|---------|-------|-------|
| **Kong** | `kong/` | Kong Gateway | access (optional checks) + log (metering) | `cd kong && busted spec/` |
| **Apigee** | `apigee/` | Google Apigee | PostClientFlow (JavaScript callout) | `node tests/unit-tests.cjs` |
| **AWS** | `aws-lambda/` | AWS API Gateway | CloudWatch Logs (Lambda subscriber) | `cd aws-lambda && npm test` |
| **Azure APIM** | `azure-apim/` | Azure API Management | Outbound policy fragment | `node azure-apim/tests/policy.test.cjs` (runs the policy expressions against a mock context; no APIM runtime) |
| **MuleSoft** | `mulesoft/aforo-metering/` (Mule 4 custom policy, `mvn clean package`) | MuleSoft Anypoint, Mule 4.4+ runtime | After the flow, async (DataWeave) | `node mulesoft/tests/policy.test.cjs` (structure only; DataWeave is not executed) + `mvn clean package` + `tests/policy-contract.md` |

## Where events go

Every plugin POSTs batches to the endpoint you configure, with two headers:

| | Value |
|---|---|
| Endpoint | `https://api.aforo.ai/v1/ingest/batch` |
| `X-API-Key` | Your Aforo API key (`sk_live_…` / `sk_test_…`) |
| `X-Tenant-Id` | Sent by Kong only. The workspace always comes from the key. |

The setting names differ per gateway (Kong `aforo_endpoint` / `api_key`, AWS `AFORO_ENDPOINT` / `AFORO_API_KEY`, Apigee KVM `aforo_endpoint` / `api_key`, Azure Named Values `aforo-endpoint` / `aforo-api-key`, MuleSoft `aforo-endpoint` / `aforo-api-key`). An endpoint you have already configured is used unchanged. The ingestor also accepts the key as `Authorization: Bearer <key>`, which is what these plugins sent before; `tests/ingest-auth-standard.test.cjs` keeps them on `X-API-Key`.

## W3C Trace Context Headers

All 5 plugins extract these headers from inbound requests and include them in the `trace` object of the emitted event payload:

| Header | Event Field | Description |
|--------|------------|-------------|
| `traceparent` | `trace.traceparent` | W3C Trace Context parent (version-traceId-spanId-flags) |
| `tracestate` | `trace.tracestate` | W3C Trace Context vendor state |
| `x-trace-id` | `trace.xTraceId` | Legacy trace ID header |
| `x-request-id` | `trace.xRequestId` | Legacy request ID header |

**Absent headers are emitted as `null`** — no synthetic values are generated.

## Event Payload Shape (v1.1)

```json
{
  "customerId": "cust_abc123",
  "metricName": "GET /v1/accounts/{id}",
  "quantity": 1,
  "idempotencyKey": "req-001",
  "occurredAt": "2026-04-14T10:30:00Z",
  "productType": "API",
  "endpointPath": "/v1/accounts/123",
  "httpMethod": "GET",
  "statusCode": 200,
  "responseTimeMs": 47,
  "executionStatus": "SUCCESS",
  "trace": {
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "tracestate": "congo=t61rcWkgMzE",
    "xTraceId": null,
    "xRequestId": "req-456"
  },
  "metadata": {
    "gateway": "kong",
    "method": "GET",
    "path": "/v1/accounts/123",
    "status": 200
  }
}
```

The 4 HTTP fields (`endpointPath`, `httpMethod`, `statusCode`, `responseTimeMs`) are emitted as **top-level fields** for fast ClickHouse queries, and also duplicated in `metadata` for backward compatibility with older ingestor builds.

## Execution status mapping

Every standard API, AGENTIC_API, and MCP tool-call event (and, in Kong, every gRPC and GraphQL event) carries a top-level `executionStatus` derived from the upstream response. It drives `OUTCOME_BASED` pricing, where each event is billed at a per-status weight; every other pricing model ignores the field. All five plugins apply the same default table (`outcome_from_status` in Kong, `outcomeFromStatus` in AWS Lambda / Apigee / MuleSoft, the `aforo-execution-status` policy variable in Azure APIM):

| Upstream status | `executionStatus` |
|---|---|
| 2xx, 3xx | `SUCCESS` |
| 408, 504 | `TIMEOUT` |
| 499 (client closed request, where the gateway reports it) | `CANCELLED` |
| 400, 422 | `VALIDATION_FAILED` |
| 401, 403, 429 | `BLOCKED` |
| every other 4xx and 5xx (404 included) | `ERROR` |
| missing, 0, 1xx, non-numeric | field omitted (billed at full weight) |

The field is never sent as `null` or `""`. Apigee also reports `ERROR` for an MCP call whose 2xx body is a JSON-RPC `error` object; the other gateways don't buffer the response body, so they classify on status alone. Compound-metering events are unchanged: their request shape has no `executionStatus` field.

**Why this table (decided 2026-09-30, don't re-litigate without a product decision).** Rate plans commonly weight `VALIDATION_FAILED` at 0, since the customer sent a bad request. Until 2026-09-30 every non-408 4xx mapped there. That made an unauthenticated call, a forbidden call, a 404 and a rate-limited call all free, and a customer's own bad keys cost the provider nothing to reject. Now only 400 and 422 (real request-validation failures) are `VALIDATION_FAILED`. Auth and rate-limit rejections are `BLOCKED`, so a plan can price them on their own. 404 and the remaining 4xx are `ERROR`. 3xx stays `SUCCESS`, because the gateway served the redirect.

**Overrides.** Each plugin accepts an exact-code override list. It wins over the table, and invalid entries are ignored:

| Gateway | Setting | Format |
|---|---|---|
| Kong | `status_outcomes` (plugin config) | map, e.g. `{"404": "VALIDATION_FAILED", "429": "ERROR"}` |
| AWS Lambda | `STATUS_OUTCOMES` env / `StatusOutcomes` SAM parameter | `404=VALIDATION_FAILED,429=ERROR` |
| Apigee | KVM `aforo-metering-config` key `status_outcomes` | same CSV |
| Azure APIM | context variable `aforo-status-outcomes`, set before the fragment | same CSV |
| MuleSoft | policy property `status-outcomes` | same CSV |

Keys are HTTP codes 200-599. Values are one of the 11 canonical statuses (`SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`). An override can't make an undeterminable status billable. If a code is listed twice, the last valid entry wins.

**Requests that aren't metered at all.** All five plugins skip 401, 403 and 429 and the paths `/health`, `/ready` and `/metrics` by default. A skipped request produces no event and no call to Aforo. A path is skipped when it equals an entry or starts with it. A configured list replaces the default; it does not add to it.

| Gateway | Status codes | Paths | To exclude nothing |
|---|---|---|---|
| Kong | `exclude_status_codes` (array) | `exclude_paths` (array) | empty array `[]` |
| AWS Lambda | `EXCLUDE_STATUS_CODES` (env, CSV) | not configurable: `/health`, `/ready`, `/metrics`, `/favicon.ico` | empty value (status codes only) |
| Apigee | KVM `exclude_status_codes` (CSV) | KVM `exclude_paths` (CSV) | `none` |
| Azure APIM | context variable `aforo-exclude-status-codes` (CSV) | context variable `aforo-exclude-paths` (CSV) | `none` |
| MuleSoft | policy property `exclude-status-codes` (CSV) | policy property `exclude-paths` (CSV) | `none` |

On Apigee, Azure APIM and MuleSoft an absent or blank setting means "use the default", so those three take the word `none` to meter everything. A 401, 403 or 429 that you choose to meter bills as `BLOCKED` unless overridden. Entries that aren't whole numbers 100-599 are ignored.

**gRPC (Kong).** gRPC returns HTTP 200 for most failures; the real result is `grpc-status`, usually an HTTP/2 trailer. Kong reads it from the response header (trailers-only responses), then `$upstream_trailer_grpc_status`, then `$sent_trailer_grpc_status`. It maps each code to an equivalent HTTP status, so gRPC follows the same table and the same overrides. `exclude_status_codes` applies to the equivalent code too: by default an UNAUTHENTICATED, PERMISSION_DENIED or RESOURCE_EXHAUSTED call produces no event, exactly like a 401, 403 or 429.

| `grpc-status` | Treated as | Default `executionStatus` |
|---|---|---|
| 0 OK | 200 | `SUCCESS` |
| 1 CANCELLED | 499 | `CANCELLED` |
| 3 INVALID_ARGUMENT, 9 FAILED_PRECONDITION, 11 OUT_OF_RANGE | 400 | `VALIDATION_FAILED` |
| 4 DEADLINE_EXCEEDED | 504 | `TIMEOUT` |
| 16 UNAUTHENTICATED | 401 | `BLOCKED` |
| 7 PERMISSION_DENIED | 403 | `BLOCKED` |
| 8 RESOURCE_EXHAUSTED | 429 | `BLOCKED` |
| 5 NOT_FOUND | 404 | `ERROR` |
| 6 ALREADY_EXISTS, 10 ABORTED | 409 | `ERROR` |
| 12 UNIMPLEMENTED | 501 | `ERROR` |
| 14 UNAVAILABLE | 503 | `ERROR` |
| 2 UNKNOWN, 13 INTERNAL, 15 DATA_LOSS, any code above 16 | 500 | `ERROR` |
| not readable | the HTTP status | per the HTTP table |

What doesn't work: a gRPC-Web upstream that encodes the status in the body frame. Kong can't read it there, so those calls fall back to the HTTP status. The other four gateways don't meter gRPC.

## Product type and metric name

Every event carries `productType` (default `API`, trimmed and upper-cased), which the ingestor requires in production. An MCP `tools/call` is `MCP_SERVER` when the tool name and agent id are known, a request with a trace id is `AGENTIC_API`, and Kong's gRPC / GraphQL / WebSocket detection sets its own type.

The metric of a plain HTTP event is the first of: an endpoint-to-metric mapping, the plugin's metric pattern when one is configured, the default metric (`api_calls`). The plugins cannot see your catalog: a name that is blank or longer than 255 characters is dropped at the gateway with a warning; a well-formed name the catalog does not know is refused by the ingestor for that event and reported in the batch response (Kong and AWS Lambda count these; see their READMEs).

| Gateway | Product type | Mappings | Default metric |
|---|---|---|---|
| Kong | `product_type` | `metric_mappings` (Lua patterns), `mappings_url` (EXACT / PREFIX / CONTAINS from the catalog), `metric_header` | `default_metric` |
| AWS Lambda | `PRODUCT_TYPE` / `ProductType` | `METRIC_MAPPINGS` / `MetricMappings` | `DEFAULT_METRIC` / `DefaultMetric` |
| Apigee | KVM `product_type` | KVM `metric_mappings` | KVM `default_metric` |
| Azure APIM | context variable `aforo-product-type` | context variable `aforo-metric-mappings` (`KIND\|value\|metric;…`) | context variable `aforo-default-metric` |
| MuleSoft | `product-type` | `metric-mappings` (`KIND\|value\|metric;…`) | `default-metric` |

On Azure the 2.1.0 Named Values of the same names are read by the `aforo-context` fragment; on MuleSoft the 2.1.0 underscore names are aliases.

## Install Instructions

See the `README.md` in each plugin directory for gateway-specific setup.
