# @aforo/mcp-proxy

A sidecar that meters an MCP server you can't modify. It sits between the client and the server, watches the JSON-RPC traffic, and bills each `tools/call` to Aforo — over stdio, SSE, or Streamable HTTP. Best when you don't own the MCP server's source (or don't want to touch it) and the gateway-plugin path doesn't fit.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i -g @aforo/mcp-proxy
```

> **Not yet on the public npm registry.** Until it's published, install from source:
> ```bash
> git clone https://github.com/aforoai/aforo-metering-sdks.git
> cd aforo-metering-sdks/mcp-proxy
> npm install && npm run build
> npm link        # exposes the `aforo-mcp-proxy` command on your PATH
> # or run directly: node dist/bin/aforo-mcp-proxy.js --help
> ```

Requires Node >= 18.

## Quickstart

**stdio** — wrap a CLI-launched MCP server. The proxy spawns the server as a child process and meters the JSON-RPC crossing its stdio:

```bash
aforo-mcp-proxy --transport stdio \
  --command "npx" --args "-y,@modelcontextprotocol/server-filesystem,/tmp" \
  --tenant tenant_smartai --product prod_mcp_fs \
  --api-key "$AFORO_API_KEY" \
  --ingestor-url https://usage-ingestor.aforo.ai
```

**SSE** — front a network MCP server. The proxy listens on `--port` and forwards to `--upstream`:

```bash
aforo-mcp-proxy --transport sse \
  --upstream http://localhost:8080/sse --port 3100 --host 127.0.0.1 \
  --tenant tenant_smartai --product prod_mcp_fs \
  --api-key "$AFORO_API_KEY" \
  --ingestor-url https://usage-ingestor.aforo.ai
```

**Streamable HTTP** — same shape as SSE, `--transport streamable-http`.

### Claude Desktop / Cursor (stdio via a config file)

Put the proxy in front of the server in the host's `mcpServers` block, with the proxy config in a JSON file:

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

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  "aforo": {
    "tenantId": "tenant_smartai",
    "productId": "prod_mcp_fs",
    "apiKey": "sk_live_xxx",
    "ingestorUrl": "https://usage-ingestor.aforo.ai",
    "agentId": "agent_claude_desktop",
    "quotaEnforcement": false,
    "debug": false
  }
}
```

> ⚠ In stdio mode the proxy owns the child's stdout. It parses newline-delimited JSON-RPC and only meters `tools/call`; everything else (`initialize`, `ping`, notifications) passes through untouched. If your server frames messages some other way, metering may miss calls — file the framing you use.

## Configuration

The proxy resolves each value with this precedence: **environment variable > CLI flag > config file > built-in default.** Set the three Aforo credentials any way you like; mix sources freely.

| CLI flag | Config key | Env var | Default | What it does |
|---|---|---|---|---|
| `-t, --transport` | `transport` | `AFORO_TRANSPORT` | — (required) | `stdio` \| `sse` \| `streamable-http`. |
| `--command` | `command` | — | — | Server command to spawn (stdio only; required for stdio). |
| `--args` | `args` | — | — | Comma-separated args for `--command` (CLI splits on `,`; config takes a real array). |
| `--upstream` | `upstream` | — | — | Upstream MCP URL (required for sse / streamable-http). |
| `--port` | `listen.port` | — | `3100` | Listen port (sse / streamable-http). |
| `--host` | `listen.host` | — | `127.0.0.1` | Listen host (sse / streamable-http). |
| `--tenant` | `aforo.tenantId` | `AFORO_TENANT_ID` | — (required) | Aforo tenant scope. Sent as `X-Tenant-Id`. |
| `--product` | `aforo.productId` | `AFORO_PRODUCT_ID` | — (required) | MCP_SERVER product the events bill against. |
| `--api-key` | `aforo.apiKey` | `AFORO_API_KEY` | — (required) | `Authorization: Bearer <apiKey>`. |
| `--ingestor-url` | `aforo.ingestorUrl` | `AFORO_INGESTOR_URL` | — (required) | Base ingestor URL. The proxy appends `/v1/ingest/batch`. |
| `--agent-id` | `aforo.agentId` | `AFORO_AGENT_ID` | — | Agent id override when the traffic doesn't carry `_meta.agent_id`. |
| `--quota-enforcement` | `aforo.quotaEnforcement` | `AFORO_QUOTA_ENFORCEMENT` | `false` | Pre-flight quota gate before each `tools/call` (see below). |
| `--debug` | `aforo.debug` | `AFORO_DEBUG` | `false` | Verbose logging. |
| — | `aforo.flushIntervalMs` | `AFORO_FLUSH_INTERVAL_MS` | `5000` | Buffer dwell time before a timed flush. |
| — | `aforo.flushCount` | `AFORO_FLUSH_COUNT` | `50` | Force a flush at this buffer size. |
| — | `aforo.heartbeatIntervalMs` | `AFORO_HEARTBEAT_INTERVAL_MS` | `30000` | Session heartbeat cadence. |

> ⚠ The four `aforo.*` credentials (`tenantId`, `productId`, `apiKey`, `ingestorUrl`) are required and validated at startup — a missing one exits with a non-zero code and an error, it doesn't run unmetered. Pass `--ingestor-url` as the **base** URL (`https://usage-ingestor.aforo.ai`); the proxy appends `/v1/ingest/batch` for events and calls `/api/v1/quota/check` for quota.

## Walk me through it

Step-by-step from install to a verified metered call: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

Metering happens in the proxy's observe path, so it never blocks a tool call — **except** when `--quota-enforcement` is on, which adds a pre-flight check with a 50ms latency budget that **fails open** (network/timeout error → the call proceeds, unmetered-by-quota). Event delivery is best-effort: a 3-attempt backoff, then the batch is dropped (5xx/408/429 retried, other 4xx not). The proxy meters `tools/call`; `tools/list`, `resources/read`, and `prompts/get` are tracked for analytics, and protocol chatter (`initialize`, `ping`, notifications) is ignored. It does not transform tool payloads, rewrite responses, or add auth to the upstream server.
