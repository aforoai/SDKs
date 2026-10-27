# @aforoai/mcp-proxy — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** operators metering an MCP server they don't own the source of — stdio (Claude Desktop / Cursor), SSE, or Streamable HTTP.

## What you'll build

A transparent proxy in front of an MCP server so each `tools/call` is billed to Aforo, with the client and server otherwise unaware it's there. By the end you'll have confirmed a metered call hit the ingestor — and, if you turned it on, seen a quota denial come back as a JSON-RPC error.

## Prerequisites

- Node >= 18.
- An Aforo **API key**, a **tenant id**, and an MCP_SERVER **product id**.
- An MCP server to put behind the proxy: a CLI command (stdio) or a network endpoint (SSE / Streamable HTTP).

## Step 1 — Install the proxy

Public install (once published):

```bash
npm i -g @aforoai/mcp-proxy
```

Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog. If `2.0.0` is not on npm yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/mcp-proxy
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
export AFORO_INGESTOR_URL="https://api.aforo.ai"
export AFORO_CUSTOMER_ID="cust_acme"   # who the calls are billed to (see "Who is billed" in the README)
```

The proxy also needs a customer source and refuses to start without one: `AFORO_CUSTOMER_ID` / `--customer-id` for a sidecar that serves one customer, `--auth-tokens-file` on the HTTP transports to bill each client's token to its customer, or `--trust-client-customer-id` to bill the `params._meta.customer_id` your own clients send. A call is never billed to its agent id.

> ⚠ `--ingestor-url` (or `AFORO_INGESTOR_URL`) is the **base** URL. The proxy appends `/v1/ingest/batch` for events and `/api/v1/quota/check` for quota — don't include those paths yourself.

## Step 3a — Run in stdio mode (wrap a CLI server)

The proxy spawns the server as a child process and meters the JSON-RPC crossing its stdio:

```bash
aforo-mcp-proxy --transport stdio \
  --command "npx" --arg -y --arg @modelcontextprotocol/server-filesystem --arg /tmp
```

(The four credentials come from the env you set in Step 2.)

> ⚠ The child gets a short allowlist of the proxy's environment (`PATH`, `HOME`, locale, temp dirs, proxy and npm-cache settings) and never any `AFORO_*` variable, so a third-party server cannot read your Aforo key. Pass anything else it needs with `--pass-env NAME1,NAME2` or the config file's `env` block.

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
    "ingestorUrl": "https://api.aforo.ai",
    "agentId": "agent_claude_desktop",
    "customerId": "cust_acme",
    "productType": "MCP_SERVER",
    "quotaEnforcement": false
  }
}
```

> ⚠ In a config file, `args` is a real JSON array (`["-y", "@…", "/tmp"]`). On the CLI, repeat `--arg` once per argument; each value is passed unchanged, so `--arg "select a,b from t"` reaches the child as one argument. The older `--args "-y,@…,/tmp"` still works but splits on `,`. When both are given, `--arg` is used and `--args` is ignored with a warning.

## Step 3b — Run in SSE / Streamable HTTP mode (front a network server)

The proxy listens on `--port`/`--host` and forwards to `--upstream`:

```bash
export AFORO_PROXY_AUTH_TOKEN="$(openssl rand -hex 24)"
aforo-mcp-proxy --transport sse \
  --upstream http://localhost:8080/sse --port 3100 --host 127.0.0.1
```

Then point your MCP client at `http://127.0.0.1:3100` instead of the upstream directly, with `Authorization: Bearer $AFORO_PROXY_AUTH_TOKEN`. `--transport streamable-http` is the same shape. The listener refuses to start without `--auth-token`, `--auth-tokens-file` or (loopback only) `--allow-unauthenticated`, and refuses requests whose Host header is not this proxy (421) or whose Origin is not in `--allowed-origins` (403). With several clients, give each its own token in a tokens file so each is billed to its own customer:

```json
{ "tok_7f3c9a1e5b2d4c6f": "cust_acme", "tok_0a9b8c7d6e5f4a3b": "cust_globex" }
```

## Step 4 — Make a tool call and confirm metering

Trigger any `tools/call` through the client. With `--debug` the proxy logs each flush result:

```bash
aforo-mcp-proxy --transport stdio --command "npx" --arg -y --arg @modelcontextprotocol/server-filesystem --arg /tmp --debug
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
  --command "npx" --arg -y --arg @modelcontextprotocol/server-filesystem --arg /tmp \
  --ingestor-url http://localhost:8084 --debug
```

Make a tool call. The catcher prints `POST /v1/ingest/batch` with a body like:

```json
{"events":[
  {"customerId":"cust_acme","metricName":"mcp_server.tool_invocations","quantity":1,"productType":"MCP_SERVER","toolName":"read_file","agentId":"agent_claude_desktop","executionStatus":"SUCCESS"}
]}
```

If you see that hit `/v1/ingest/batch`, the proxy is metering. Point `--ingestor-url` back at `https://api.aforo.ai` and confirm `mcp_server.tool_invocations` shows up against `prod_mcp_fs` in your Aforo usage view.

## Step 6 — (Optional) turn on quota enforcement

`--quota-enforcement` adds a pre-flight `POST /api/v1/quota/check` before each `tools/call`. On `DENY` the proxy returns a JSON-RPC error (`code -32000`; the message is the server's reason, and `error.data` carries `reason`, `currentUsage`, `limit`, `retryAfterMs` and `resetsAt`) to the client and never forwards the call to the server:

```bash
aforo-mcp-proxy --transport stdio \
  --command "npx" --arg -y --arg @modelcontextprotocol/server-filesystem --arg /tmp \
  --quota-enforcement
```

> ⚠ The quota check has a **1 s** deadline (`--quota-timeout-ms`) and **fails open** by default: a timeout or network error lets the call through. Add `--quota-fail-mode closed` to refuse calls the check cannot answer. DENY answers are reused for 5 s and ALLOW answers for 1 s (`AFORO_QUOTA_ALLOW_CACHE_MS`), so a burst can run up to a second past a newly reached limit.

## Configuration reference

Precedence: **env var > CLI flag > config file > default.**

| CLI flag | Config key | Env var | Default | What it does |
|---|---|---|---|---|
| `-t, --transport` | `transport` | `AFORO_TRANSPORT` | — (required) | `stdio` \| `sse` \| `streamable-http`. |
| `--command` | `command` | — | — | Server command to spawn (stdio; required for stdio). |
| `--arg` (repeatable) | `args` | — | — | One argument per `--arg`, passed unchanged (commas allowed). |
| `--args` | `args` | — | — | Comma-separated args (an argument can't contain a comma). `--arg` wins over `--args`; both win over the config file's `args`. |
| `--upstream` | `upstream` | — | — | Upstream URL (required for sse / streamable-http). |
| `--port` | `listen.port` | — | `3100` | Listen port (sse / streamable-http). |
| `--host` | `listen.host` | — | `127.0.0.1` | Listen host (sse / streamable-http). |
| `--tenant` | `aforo.tenantId` | `AFORO_TENANT_ID` | — (required) | Tenant scope; sent as `X-Tenant-Id`. |
| `--product` | `aforo.productId` | `AFORO_PRODUCT_ID` | — (required) | MCP_SERVER product. |
| `--api-key` | `aforo.apiKey` | `AFORO_API_KEY` | — (required) | `X-API-Key: <apiKey>`. |
| `--ingestor-url` | `aforo.ingestorUrl` | `AFORO_INGESTOR_URL` | — (required) | Base URL; proxy appends `/v1/ingest/batch` and `/api/v1/quota/check`. |
| `--agent-id` | `aforo.agentId` | `AFORO_AGENT_ID` | — | Agent id override when traffic lacks `_meta.agent_id`. |
| `--customer-id` | `aforo.customerId` | `AFORO_CUSTOMER_ID` | — | One customer billed for every tool call; also the heartbeat customer. See the README for the other customer sources and the listener flags. |
| — | `aforo.productType` | `AFORO_PRODUCT_TYPE` | `MCP_SERVER` | Top-level `productType` on every event (required by the ingestor). Trimmed and uppercased. |
| `--quota-enforcement` | `aforo.quotaEnforcement` | `AFORO_QUOTA_ENFORCEMENT` | `false` | Pre-flight quota gate (1 s deadline; fail mode `--quota-fail-mode open\|closed`). |
| `--debug` | `aforo.debug` | `AFORO_DEBUG` | `false` | Verbose logging. |
| — | `aforo.flushIntervalMs` | `AFORO_FLUSH_INTERVAL_MS` | `5000` | Timed flush cadence. |
| — | `aforo.flushCount` | `AFORO_FLUSH_COUNT` | `500` | Events per request; reaching it wakes the sender. |
| — | `aforo.heartbeatIntervalMs` | `AFORO_HEARTBEAT_INTERVAL_MS` | `30000` | Interval between session heartbeats (`system.session.heartbeat`, quantity 1). The first tool call starts the session and sends one immediately; a `SESSION_END` is sent on shutdown. Each heartbeat goes in its own `/v1/ingest/batch` request, never inside a usage batch, so the ingestor intercepts it before billing. Best-effort: no retries, failures ignored. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Exits at startup with `aforo.<field> is required` | A required credential is missing across all sources | Provide `tenantId`, `productId`, `apiKey`, `ingestorUrl` via flag, env, or config. |
| `transport is required` / `Invalid transport` | `--transport` unset or not one of the three | Set `stdio`, `sse`, or `streamable-http`. |
| `command is required for stdio transport` | stdio mode with no `--command` | Add `--command` (and `--arg` for each argument it needs). |
| `upstream URL is required for SSE/HTTP transport` | sse/http mode with no `--upstream` | Add `--upstream`. |
| Events POST to `…/v1/ingest/batch/v1/ingest/batch` (404) | `--ingestor-url` included the batch path | Pass only the base URL. |
| Exits with `No customer source configured` | No `--customer-id`, tokens file, resolver or `--trust-client-customer-id` | Set one. |
| Exits with `The HTTP listener needs authentication` | sse / streamable-http without a token | Set `--auth-token` or `--auth-tokens-file`. |
| Clients get 401 / 421 / 403 | Missing or wrong bearer token / Host not this proxy / Origin not allowed | Send `Authorization: Bearer <token>`; add the name you reach the proxy by to `--allowed-hosts`; add browser origins to `--allowed-origins`. |
| `Tool call not metered — ... no customer` | No source named a customer for that call | Map the client's token to a customer, or set `--customer-id`. |
| The MCP server cannot find a variable it needs | The child gets an allowlisted environment | Add it with `--pass-env NAME` or the config file's `env`. |
| Usage rolls up under agent `"unknown"` | Traffic carries no `_meta.agent_id` | Set `--agent-id` / `AFORO_AGENT_ID`. |
| `Events dropped` in logs, `reason: rejected` | The ingestor refused the batch (non-retryable 4xx) or some of its events; the log carries the server's message | Check `apiKey` + `tenantId`, and fix what the message names (unknown metric, bad field). |
| `Aforo ingestor unavailable` in logs | The ingestor was unreachable, or kept returning 401/403/5xx/408/429 | The usage stays queued and is re-sent; check connectivity to `ingestorUrl` and the API key. |
| `Tool call not metered — invalid event dropped` in logs | The call's `agentId` (> 36 chars), `customerId` (> 64) or `sessionId` (> 64) exceeds the ingestor's limit | Shorten the value at its source. The call itself is still forwarded. |
| A failed tool call is billed as `ERROR`, a slow one as `TIMEOUT` | That is the default status mapping (see the README's "What each tool call is billed as") | Raise `AFORO_RESPONSE_TIMEOUT_MS` for long-running tools, or set `aforo.statusResolver` when embedding the proxy as a library. |
| Quota enforcement never denies under load | The check failed open on timeout | Raise `--quota-timeout-ms`, or use `--quota-fail-mode closed`. |
| stdio metering misses calls | Server uses non-newline JSON-RPC framing | Confirm metering on a known tool; report the framing your server uses. |

## What this guide does NOT cover

- **Hard quota blocking by default.** `--quota-enforcement` fails open unless you set `--quota-fail-mode closed`, and reuses ALLOW answers for up to a second.
- **Guaranteed delivery.** During an outage usage is kept in memory (up to `maxQueueSize`) and re-sent; it is lost if the proxy dies first. No on-disk queue.
- **Transforming payloads or adding upstream auth.** The proxy observes and meters; it doesn't rewrite tool inputs/outputs or authenticate to the upstream server for you.
- **Product / metric / rate-plan setup.** Done in the Aforo console.
