# Aforo Metering — Azure APIM Policy

Meters Standard API requests and MCP Server tool invocations via Azure API Management outbound policies.

## Files

| File | Purpose |
|------|---------|
| `outbound-policy.xml` | Main policy fragment — handles both standard API and MCP metering with W3C trace capture |
| `mcp-policy-fragment.xml` | Legacy MCP-only fragment (delegates to outbound-policy.xml) |

## Prerequisites

Create these **Named Values** in your Azure APIM instance:

| Named Value | Description |
|-------------|-------------|
| `aforo-endpoint` | Aforo usage ingestor batch URL |
| `aforo-api-key` | Aforo API key |
| `aforo-tenant-id` | Your Aforo tenant ID |
| `aforo-mcp-enabled` | `"true"` to enable MCP detection (optional) |
| `aforo-mcp-product-id` | Aforo product ID for MCP server (optional) |

## Installation

Add to your API's outbound policy:

```xml
<outbound>
    <base />
    <include-fragment fragment-id="aforo-metering" />
</outbound>
```

## W3C Trace Context

The policy captures these headers from inbound requests:
- `traceparent` — W3C trace parent header
- `tracestate` — W3C trace state header
- `x-trace-id` — Legacy trace ID header
- `x-request-id` — Legacy request ID header

Absent headers are emitted as `null` (no synthetic values).

## Manual Verification

```bash
# 1. Standard API request with trace headers
curl -X GET "https://your-apim.azure-api.net/v1/accounts/123" \
  -H "Ocp-Apim-Subscription-Key: YOUR_KEY" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
  -H "tracestate: congo=t61rcWkgMzE"

# 2. Verify event in Aforo usage-ingestor logs — should include:
#    endpointPath, httpMethod, statusCode, responseTimeMs, trace.traceparent

# 3. MCP tools/call request
curl -X POST "https://your-apim.azure-api.net/v1/mcp" \
  -H "Content-Type: application/json" \
  -H "Ocp-Apim-Subscription-Key: YOUR_KEY" \
  -H "traceparent: 00-abc123-def456-01" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_docs"}}'
```
