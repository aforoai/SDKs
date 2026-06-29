# @aforo/mcp-proxy

Transparent MCP Transport Proxy for metering stdio/SSE/HTTP MCP servers without requiring SDK integration.

## Quick Start

```bash
npm install -g @aforo/mcp-proxy

# stdio mode — wrap any MCP server
aforo-mcp-proxy --transport stdio \
  --command "npx" --args "-y,@modelcontextprotocol/server-filesystem,/tmp" \
  --tenant tenant_abc --product prod_mcp_fs \
  --api-key sk_live_xxx --ingestor-url https://usage-ingestor.aforo.ai

# SSE mode — proxy an SSE MCP server
aforo-mcp-proxy --transport sse \
  --upstream http://localhost:8080/sse --port 3100 \
  --tenant tenant_abc --product prod_mcp_fs \
  --api-key sk_live_xxx --ingestor-url https://usage-ingestor.aforo.ai
```

## Claude Desktop Integration

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "aforo-mcp-proxy",
      "args": ["--config", "/path/to/aforo-proxy.json"]
    }
  }
}
```

## Config File

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  "aforo": {
    "tenantId": "tenant_abc",
    "productId": "prod_mcp_fs",
    "apiKey": "sk_live_xxx",
    "ingestorUrl": "https://usage-ingestor.aforo.ai",
    "agentId": "agent_claude_desktop",
    "quotaEnforcement": false,
    "debug": false
  }
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AFORO_TENANT_ID` | Tenant ID (overrides config) |
| `AFORO_PRODUCT_ID` | Product ID |
| `AFORO_API_KEY` | API key for ingestor auth |
| `AFORO_INGESTOR_URL` | Ingestor endpoint URL |
| `AFORO_AGENT_ID` | Agent identifier override |
| `AFORO_QUOTA_ENFORCEMENT` | Enable quota enforcement (true/false) |
| `AFORO_DEBUG` | Enable debug logging (true/false) |

## Transport Modes

| Mode | Use Case |
|------|----------|
| `stdio` | Wrap CLI-based MCP servers (Claude Desktop, Cursor) |
| `sse` | Proxy SSE-based MCP servers |
| `streamable-http` | Proxy Streamable HTTP MCP servers |

## Docker

```bash
docker run -e AFORO_TENANT_ID=abc -e AFORO_API_KEY=sk_live_xxx \
  ghcr.io/aforo/mcp-proxy:latest \
  --transport sse --upstream http://mcp-server:8080/sse --port 3100
```
