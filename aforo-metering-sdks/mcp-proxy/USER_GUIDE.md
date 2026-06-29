# @aforo/mcp-proxy — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** operators metering an MCP server they don't own the source of — stdio (Claude Desktop / Cursor), SSE, or Streamable HTTP.

## What you'll build

A transparent proxy in front of an MCP server so each `tools/call` is billed to Aforo, with the client and server otherwise unaware it's there. By the end you'll have confirmed a metered call hit the ingestor — and, if you turned it on, seen a quota denial come back as a JSON-RPC error.

## Prerequisites

- Node >= 18.
- An Aforo **API key**, a **tenant id**, and an MCP_SERVER **product id**.
- An MCP server to put behind the proxy: a CLI command (stdio) or a network endpoint (SSE / Streamable HTTP).

## Step 1 — Install the proxy

Public install (once published):

```bash
npm i -g @aforo/mcp-proxy
```

Not on npm yet, so install from source for now:

```bash
git clone https://github.com/aforoai/aforo-metering-sdks.git
cd aforo-metering-sdks/mcp-proxy
npm install && npm run build
npm link        # exposes `aforo-mcp-proxy` on your PATH
```

Confirm it runs:

```bash
aforo-mcp-proxy --help    # or: node dist/bin/aforo-mcp-proxy.js --help
```

## Step 2 — Choose a transport and supply credentials

The four `aforo.*` credentials are required for every transport. Supply them as flags, env vars, or a config file — env wins over flags, flags win over the file.

```bash
export AFORO_API_KEY="sk_live_xxx"
export AFORO_TENANT_ID="tenant_smartai"
export AFORO_PRODUCT_ID="prod_mcp_fs"
export AFORO_INGESTOR_URL="https://usage-ingestor.aforo.ai"
```

> ⚠ `--ingestor-url` (or `AFORO_INGESTOR_URL`) is the **base** URL. The proxy appends `/v1/ingest/batch` for events and `/api/v1/quota/check` for quota — don't include those paths yourself.

## Step 3a — Run in stdio mode (wrap a CLI server)

The proxy spawns the server as a child process and meters the JSON-RPC crossing its stdio:

```bash
aforo-mcp-proxy --transport stdio \
  --command "npx" --args "-y,@modelcontextprotocol/server-filesystem,/tmp"
```

(The four credentials come from the env you set in Step 2.)

> ⚠ stdio metering parses **newline-delimited** JSON-RPC. The proxy spawns the child, forwards its stderr to yours, and writes parsed messages to the client. If your server frames messages differently, calls can be missed — confirm metering on a known tool first (Step 4).

### Behind Claude Desktop / Cursor

Point the host's `mcpServers` entry at the proxy with a config file:

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
    "quotaEnforcement": false
  }
}
```

> ⚠ In a config file, `args` is a real JSON array (`["-y", "@…", "/tmp"]`). On the CLI it's one comma-separated string (`--args "-y,@…,/tmp"`) that the proxy splits on `,`. Don't mix the two forms.

## Step 3b — Run in SSE / Streamable HTTP mode (front a network server)

The proxy listens on `--port`/`--host` and forwards to `--upstream`:

```bash
aforo-mcp-proxy --transport sse \
  --upstream http://localhost:8080/sse --port 3100 --host 127.0.0.1
```

Then point your MCP client at `http://127.0.0.1:3100` instead of the upstream directly. `--transport streamable-http` is the same shape.

## Step 4 — Make a tool call and confirm metering

Trigger any `tools/call` through the client. With `--debug` the proxy logs each flush result:

```bash
aforo-mcp-proxy --transport stdio --command "npx" --args "-y,@modelcontextprotocol/server-filesystem,/tmp" --debug
```

You'll see a `Flushed events` log line with `accepted` / `duplicates` / `failed` counts once the buffer flushes (≤ `flushIntervalMs`, default 5s, or at `flushCount` events). `tools/list`, `resources/read`, and `prompts/get` are tracked but not billed; `initialize`, `ping`, and notifications are ignored.

> ⚠ If the traffic doesn't carry `_meta.agent_id`, usage attributes to `"unknown"` unless you set `--agent-id`. Set it so calls roll up under a real agent.

## Step 5 — Verify it landed in Aforo

Point the ingestor at a local catcher to see the exact batch the proxy posts:

```bash
# A throwaway HTTP echo that prints the POST body:
node -e "require('http').createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{console.log(req.method,req.url,b);res.writeHead(202,{'content-type':'application/json'}).end('{\"accepted\":1,\"duplicates\":0,\"failed\":0}')})}).listen(8084)"
```

```bash
aforo-mcp-proxy --transport stdio \
  --command "npx" --args "-y,@modelcontextprotocol/server-filesystem,/tmp" \
  --ingestor-url http://localhost:8084 --debug
```

Make a tool call. The catcher prints `POST /v1/ingest/batch` with a body like:

```json
{"events":[
  {"customerId":"agent_claude_desktop","metricName":"mcp_server.tool_invocations","quantity":1,"productType":"MCP_SERVER","toolName":"read_file","agentId":"agent_claude_desktop","executionStatus":"SUCCESS"}
]}
```

If you see that hit `/v1/ingest/batch`, the proxy is metering. Point `--ingestor-url` back at `https://usage-ingestor.aforo.ai` and confirm `mcp_server.tool_invocations` shows up against `prod_mcp_fs` in your Aforo usage view.

## Step 6 — (Optional) turn on quota enforcement

`--quota-enforcement` adds a pre-flight `POST /api/v1/quota/check` before each `tools/call`. On `DENY` the proxy returns a JSON-RPC error (`code -32000`, "Quota exceeded") to the client and never forwards the call to the server:

```bash
aforo-mcp-proxy --transport stdio \
  --command "npx" --args "-y,@modelcontextprotocol/server-filesystem,/tmp" \
  --quota-enforcement
```

> ⚠ The quota check has a **50ms** latency budget and **fails open**: a timeout or network error lets the call through unmetered-by-quota. Deny decisions are cached in-process for 5s to avoid hammering the endpoint. This is a soft gate, not a hard wall — don't rely on it for security-grade blocking.

## Configuration reference

Precedence: **env var > CLI flag > config file > default.**

| CLI flag | Config key | Env var | Default | What it does |
|---|---|---|---|---|
| `-t, --transport` | `transport` | `AFORO_TRANSPORT` | — (required) | `stdio` \| `sse` \| `streamable-http`. |
| `--command` | `command` | — | — | Server command to spawn (stdio; required for stdio). |
| `--args` | `args` | — | — | Comma-separated args (CLI) / array (config). |
| `--upstream` | `upstream` | — | — | Upstream URL (required for sse / streamable-http). |
| `--port` | `listen.port` | — | `3100` | Listen port (sse / streamable-http). |
| `--host` | `listen.host` | — | `127.0.0.1` | Listen host (sse / streamable-http). |
| `--tenant` | `aforo.tenantId` | `AFORO_TENANT_ID` | — (required) | Tenant scope; sent as `X-Tenant-Id`. |
| `--product` | `aforo.productId` | `AFORO_PRODUCT_ID` | — (required) | MCP_SERVER product. |
| `--api-key` | `aforo.apiKey` | `AFORO_API_KEY` | — (required) | `Authorization: Bearer <apiKey>`. |
| `--ingestor-url` | `aforo.ingestorUrl` | `AFORO_INGESTOR_URL` | — (required) | Base URL; proxy appends `/v1/ingest/batch` and `/api/v1/quota/check`. |
| `--agent-id` | `aforo.agentId` | `AFORO_AGENT_ID` | — | Agent id override when traffic lacks `_meta.agent_id`. |
| `--quota-enforcement` | `aforo.quotaEnforcement` | `AFORO_QUOTA_ENFORCEMENT` | `false` | Pre-flight quota gate (fail-open, 50ms budget). |
| `--debug` | `aforo.debug` | `AFORO_DEBUG` | `false` | Verbose logging. |
| — | `aforo.flushIntervalMs` | `AFORO_FLUSH_INTERVAL_MS` | `5000` | Timed flush cadence. |
| — | `aforo.flushCount` | `AFORO_FLUSH_COUNT` | `50` | Force flush at this buffer size. |
| — | `aforo.heartbeatIntervalMs` | `AFORO_HEARTBEAT_INTERVAL_MS` | `30000` | Session heartbeat cadence. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Exits at startup with `aforo.<field> is required` | A required credential is missing across all sources | Provide `tenantId`, `productId`, `apiKey`, `ingestorUrl` via flag, env, or config. |
| `transport is required` / `Invalid transport` | `--transport` unset or not one of the three | Set `stdio`, `sse`, or `streamable-http`. |
| `command is required for stdio transport` | stdio mode with no `--command` | Add `--command` (and `--args` if needed). |
| `upstream URL is required for SSE/HTTP transport` | sse/http mode with no `--upstream` | Add `--upstream`. |
| Events POST to `…/v1/ingest/batch/v1/ingest/batch` (404) | `--ingestor-url` included the batch path | Pass only the base URL. |
| Usage rolls up under `"unknown"` | Traffic carries no `_meta.agent_id` | Set `--agent-id` / `AFORO_AGENT_ID`. |
| `Flush failed — events dropped` in logs | Auth/tenant error (4xx) or retries exhausted (5xx) | Check `apiKey` + `tenantId`; non-408/429 4xx is not retried. |
| Quota enforcement never denies under load | The 50ms check failed open on timeout | Expected on a slow path; quota is a soft gate. Raise the limit upstream, don't rely on it for hard blocking. |
| stdio metering misses calls | Server uses non-newline JSON-RPC framing | Confirm metering on a known tool; report the framing your server uses. |

## What this guide does NOT cover

- **Hard quota blocking.** `--quota-enforcement` is a 50ms fail-open pre-flight gate, not a security wall. A timeout lets the call through.
- **Guaranteed delivery.** A 3-attempt backoff then the batch is dropped (logged). No on-disk queue.
- **Transforming payloads or adding upstream auth.** The proxy observes and meters; it doesn't rewrite tool inputs/outputs or authenticate to the upstream server for you.
- **Product / metric / rate-plan setup.** Done in the Aforo console.
