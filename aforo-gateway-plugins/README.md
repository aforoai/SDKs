# Aforo Gateway Metering Plugins

**Current version**: v2.0.0 — see `CHANGELOG.md` for the 2026-04-23 security release.

Gateway plugins that capture API usage events at the edge and forward them to the Aforo usage ingestor service. Each plugin supports Standard API metering, MCP Server tool invocation detection, and W3C Trace Context capture.

## Security model

All five plugins source tenant/customer identity from **authenticated sources only**: a verified JWT claim, a gateway-managed credential-bound identity, or an admin-pinned configuration value. **No plugin reads `X-Tenant-Id`, `X-Customer-Id`, `X-Client-Id`, or `X-Agent-Id` from request headers** — those are client-settable and therefore spoofable. See `CHANGELOG.md` for the IDOR fixes shipped in v2.0.0.

## Plugins

| Plugin | Directory | Gateway | Phase | Tests |
|--------|-----------|---------|-------|-------|
| **Kong** | `kong-plugin-aforo-metering/` | Kong Gateway | access (trace stash) + log (metering) | `busted spec/` |
| **Apigee** | `apigee-shared-flow-aforo-metering/` | Google Apigee | PostClientFlow (JavaScript callout) | `node tests/unit-tests.js` |
| **AWS** | `aws-lambda-aforo-metering/` | AWS API Gateway | CloudWatch Logs (Lambda subscriber) | `npm test` |
| **Azure APIM** | `azure-apim-policy-aforo-metering/` | Azure API Management | Outbound policy fragment | Manual (see README) |
| **MuleSoft** | `mulesoft-policy-aforo-metering/` | MuleSoft Anypoint | Response phase (DataWeave) | Manual (see README) |

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

## Product type

Every event carries `productType`, which the ingestor requires in production. Each plugin has a setting for it, default `API` (trimmed and upper-cased; unknown values are passed through):

| Plugin | Setting |
|--------|---------|
| Kong | `config.product_type` |
| Apigee | KVM key `product_type` |
| AWS Lambda | `PRODUCT_TYPE` env var / `ProductType` SAM parameter |
| Azure APIM | Named Value `aforo-product-type` (per-API override: `set-variable name="aforo-product-type"` before `aforo-context`) |
| MuleSoft | `product-type` property (`${product_type}` in `template.xml`) |

An MCP `tools/call` is sent as `MCP_SERVER` only when both `toolName` and `agentId` are known; otherwise it keeps the configured type. Events missing the fields their type requires (e.g. `MCP_SERVER` without `agentId`, or `AI_AGENT` / `GRPC_API` / `GRAPHQL_API` / `WEBSOCKET_API` / `MQTT_BROKER`, whose fields an HTTP gateway cannot observe or trust) are skipped rather than sent, because one invalid event fails the whole batch.

## Install Instructions

See the `README.md` in each plugin directory for gateway-specific setup.
