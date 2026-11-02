# @aforoai/mcp-proxy

A sidecar that meters an MCP server you can't modify. It sits between the client and the server, watches the JSON-RPC traffic, and bills each `tools/call` to Aforo — over stdio, SSE, or Streamable HTTP. Use it when you don't own the MCP server's source (or don't want to change it) and the gateway-plugin path doesn't fit.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i -g @aforoai/mcp-proxy
```

> **Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on npm yet, install from source:
> ```bash
> git clone https://github.com/aforoai/SDKs.git
> cd SDKs/aforo-metering-sdks/mcp-proxy
> npm install && npm run build
> npm link        # exposes the `aforo-mcp-proxy` command on your PATH
> # or run directly: node dist/bin/aforo-mcp-proxy.js --help
> ```

Requires Node >= 18.

## Quickstart

**stdio** — wrap a CLI-launched MCP server. The proxy spawns the server as a child process and meters the JSON-RPC crossing its stdio. The sidecar bills one customer:

```bash
aforo-mcp-proxy --transport stdio \
  --command "npx" --arg -y --arg @modelcontextprotocol/server-filesystem --arg /tmp \
  --tenant tenant_smartai --product prod_mcp_fs --customer-id cust_acme \
  --api-key "$AFORO_API_KEY" \
  --ingestor-url https://api.aforo.ai
```

**SSE** — front a network MCP server. The proxy listens on `--port` and forwards to `--upstream`. Every client sends a bearer token; a tokens file maps each token to the customer it is billed to:

```bash
echo '{ "tok_7f3c9a1e5b2d4c6f": "cust_acme", "tok_0a9b8c7d6e5f4a3b": "cust_globex" }' > /etc/aforo/proxy-tokens.json
aforo-mcp-proxy --transport sse \
  --upstream http://localhost:8080/sse --port 3100 --host 127.0.0.1 \
  --auth-tokens-file /etc/aforo/proxy-tokens.json \
  --tenant tenant_smartai --product prod_mcp_fs \
  --api-key "$AFORO_API_KEY" \
  --ingestor-url https://api.aforo.ai
```

Clients then send `Authorization: Bearer tok_7f3c9a1e5b2d4c6f`. **Streamable HTTP** — same shape as SSE, `--transport streamable-http`.

### Who is billed

The proxy refuses to start without a customer source:

| Source | Flag / config | Use it when |
|---|---|---|
| One customer | `--customer-id` / `aforo.customerId` / `AFORO_CUSTOMER_ID` | The sidecar serves one customer (the usual stdio case). |
| Bearer token → customer | `--auth-tokens-file` / `listen.authTokensFile` | SSE / Streamable HTTP with several clients. The authenticated token decides the customer. |
| Your own function | `aforo.customerResolver` (library use) | You embed the proxy and know the caller some other way. It receives the tool name, agent id, session, `_meta` and the authenticated principal; it decides alone. |
| The client's claim | `--trust-client-customer-id` / `aforo.trustClientCustomerId` | Every client is yours and puts the customer in `params._meta.customer_id`. Any client can put any id there, so this is off by default. Calls without one fall back to `--customer-id`. |

A call whose customer cannot be decided is forwarded and runs; its event is dropped as `invalid` and counted. It is never billed to its agent id.

### Securing the HTTP listeners

The SSE and Streamable HTTP listeners refuse to start without authentication: `--auth-token <token>` (one token for every client, at least 16 characters), `--auth-tokens-file` (one per client), or `--allow-unauthenticated` (only on a loopback `--host`). Every request is also checked for:

- **Host** — `localhost`, `127.0.0.1`, `[::1]`, the `--host` value, or one listed in `--allowed-hosts`. Anything else gets 421, which stops a DNS-rebinding page from reaching the proxy through a name it controls.
- **Origin** — refused (403) unless listed in `--allowed-origins`. CORS answers name that origin; there is no wildcard.
- **Body size** — at most 4 MiB (`listen.maxBodyBytes`), else 413.

The proxy's bearer token is never forwarded to the MCP server.

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
    "ingestorUrl": "https://api.aforo.ai",
    "agentId": "agent_claude_desktop",
    "productType": "MCP_SERVER",
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
| `--arg` (repeatable) | `args` | — | — | One argument for `--command`; repeat it for each. The value reaches the child unchanged, commas included. |
| `--args` | `args` | — | — | Older form: comma-separated args for `--command` (split on `,`, so an argument can't contain a comma). Precedence: `--arg` > `--args` > the config file's `args`; giving both CLI forms uses `--arg` and logs a warning. |
| `--pass-env` | `passEnv` | `AFORO_PASS_ENV` | — | Comma-separated names of the proxy's environment variables the stdio child may inherit. The child otherwise gets only `PATH`, `HOME`, `USER`, locale, temp-dir, proxy and npm-cache variables, plus the config file's `env`. `AFORO_*` variables are never passed. |
| `--upstream` | `upstream` | — | — | Upstream MCP URL (required for sse / streamable-http). |
| `--port` | `listen.port` | — | `3100` | Listen port (sse / streamable-http). |
| `--host` | `listen.host` | — | `127.0.0.1` | Listen host (sse / streamable-http). |
| `--auth-token` | `listen.authToken` | `AFORO_PROXY_AUTH_TOKEN` | — | Bearer token every client must send (at least 16 characters). |
| `--auth-tokens-file` | `listen.authTokensFile` | `AFORO_PROXY_AUTH_TOKENS_FILE` | — | JSON `{ "<token>": "<customerId>" }`: a token per client, billed to its customer. |
| `--allow-unauthenticated` | `listen.allowUnauthenticated` | `AFORO_PROXY_ALLOW_UNAUTHENTICATED` | `false` | Accept requests without a token. Only with a loopback `--host`. |
| `--allowed-hosts` | `listen.allowedHosts` | `AFORO_PROXY_ALLOWED_HOSTS` | — | Extra Host header values to accept (comma-separated). |
| `--allowed-origins` | `listen.allowedOrigins` | `AFORO_PROXY_ALLOWED_ORIGINS` | — | Browser origins allowed to call the proxy (comma-separated). |
| `--health-file` | `healthFile` | `AFORO_HEALTH_FILE` | — | File the proxy rewrites every 10 s while serving and removes on shutdown, for container health checks. |
| `--tenant` | `aforo.tenantId` | `AFORO_TENANT_ID` | — (required) | Aforo tenant scope. Sent as `X-Tenant-Id`. |
| `--product` | `aforo.productId` | `AFORO_PRODUCT_ID` | — (required) | MCP_SERVER product the events bill against. |
| `--api-key` | `aforo.apiKey` | `AFORO_API_KEY` | — (required) | `X-API-Key: <apiKey>`. |
| `--ingestor-url` | `aforo.ingestorUrl` | `AFORO_INGESTOR_URL` | — (required) | Base ingestor URL. The proxy appends `/v1/ingest/batch`. |
| `--agent-id` | `aforo.agentId` | `AFORO_AGENT_ID` | — | Agent id override when the traffic doesn't carry `_meta.agent_id`. |
| `--customer-id` | `aforo.customerId` | `AFORO_CUSTOMER_ID` | — | One customer billed for every tool call. Also the customer on session heartbeats (else the first call's customer, else `system`; heartbeats are never billed). |
| `--trust-client-customer-id` | `aforo.trustClientCustomerId` | `AFORO_TRUST_CLIENT_CUSTOMER_ID` | `false` | Bill `params._meta.customer_id` as the client sends it. |
| — | `aforo.customerResolver` | — | — | Library use only: decides the customer per call (see [Who is billed](#who-is-billed)). |
| `--allow-insecure-http` | `aforo.allowInsecureHttp` | `AFORO_ALLOW_INSECURE_HTTP` | `false` | Allow a plain `http://` ingestor URL on a host other than localhost / 127.0.0.1 / ::1. Otherwise it must be `https://`. |
| — | `aforo.productType` | `AFORO_PRODUCT_TYPE` | `MCP_SERVER` | Top-level `productType` on every event (required by the ingestor). Trimmed and uppercased. |
| — | `aforo.statusResolver` | — | — | Library use only: overrides the `executionStatus` decided for each tool call (see below). |
| — | `aforo.onDrop` | — | — | Library use only: called with usage events the proxy is about to lose (see below). |
| `--quota-enforcement` | `aforo.quotaEnforcement` | `AFORO_QUOTA_ENFORCEMENT` | `false` | Pre-flight quota gate before each `tools/call` (see below). |
| `--quota-timeout-ms` | `aforo.quotaTimeoutMs` | `AFORO_QUOTA_TIMEOUT_MS` | `1000` | Deadline for one quota check. |
| — | `aforo.quotaAllowCacheMs` | `AFORO_QUOTA_ALLOW_CACHE_MS` | `1000` | How long an ALLOW answer is reused for the same customer (`0` = never). DENY answers are reused for 5 s; WARN answers never. |
| `--quota-fail-mode` | `aforo.quotaFailMode` | `AFORO_QUOTA_FAIL_MODE` | `open` | When the quota check cannot answer (timeout, network error, non-2xx): `open` lets the call through, `closed` refuses it with JSON-RPC error `-32000` (`data.reason: QUOTA_CHECK_UNAVAILABLE`). |
| `--response-timeout-ms` | `aforo.responseTimeoutMs` | `AFORO_RESPONSE_TIMEOUT_MS` | `300000` | How long a tool call may wait for its response before it is metered as `TIMEOUT` (5 minutes). Raise it for tools that legitimately run longer: a response that arrives after the timeout is not metered again. It also bounds how long the HTTP transports wait for the MCP server's answer to a forwarded POST (then 504); that answer is read up to 16 MiB (then 502). |
| `--debug` | `aforo.debug` | `AFORO_DEBUG` | `false` | Verbose logging. |
| — | `aforo.flushIntervalMs` | `AFORO_FLUSH_INTERVAL_MS` | `5000` | Queued events are sent at least this often. |
| — | `aforo.flushCount` | `AFORO_FLUSH_COUNT` | `500` | Events per request; reaching it wakes the sender (at most 1000). |
| — | `aforo.maxQueueSize` | `AFORO_MAX_QUEUE_SIZE` | `10000` | Most usage events held while the ingestor is unreachable; past it the oldest is dropped (`overflow`). |
| — | `aforo.shutdownTimeoutMs` | `AFORO_SHUTDOWN_TIMEOUT_MS` | `3000` | How long shutdown keeps sending queued events; what is left is dropped as `shutdown`. |
| — | `aforo.heartbeatIntervalMs` | `AFORO_HEARTBEAT_INTERVAL_MS` | `30000` | Interval between session heartbeats (`system.session.heartbeat`, quantity 1). The first tool call starts the session and sends one immediately; a `SESSION_END` is sent on shutdown. Each heartbeat goes in its own `/v1/ingest/batch` request, never inside a usage batch, so the ingestor intercepts it before billing. Best-effort: no retries, failures ignored. |

> ⚠ The four `aforo.*` credentials (`tenantId`, `productId`, `apiKey`, `ingestorUrl`), a customer source, and (for the HTTP transports) listener authentication are required and validated at startup — a missing one exits with a non-zero code and an error, it doesn't run unmetered. Pass `--ingestor-url` as the **base** URL (`https://api.aforo.ai`); the proxy appends `/v1/ingest/batch` for events and calls `/api/v1/quota/check` for quota.

## What each tool call is billed as

| Wire outcome | `executionStatus` |
|---|---|
| Result without `isError: true` | `SUCCESS` |
| Result with `isError: true` | `ERROR` |
| JSON-RPC error `-32001` (request timeout) | `TIMEOUT` |
| Any other JSON-RPC error | `ERROR` |
| No response within the response timeout | `TIMEOUT` (once) |
| Still waiting when the proxy shuts down (SIGTERM/SIGINT) | `CANCELLED` (once, before the final flush) |

A library `statusResolver` can override these. It must be synchronous and return one of the 11 canonical statuses (`SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`); a Promise or any other value is logged and the default is used. Calls are matched to responses by session and JSON-RPC id, so two clients reusing id `1` are metered separately: Streamable HTTP keys sessions on `Mcp-Session-Id`, and in `sse` mode each SSE connection is its own session (a POST is matched to its connection by the message endpoint the server gave that connection). Every `tools/call` inside a JSON-RPC batch is metered and quota-checked; refused calls are removed from the batch and answered by the proxy. The proxy keeps at most 10 000 calls waiting for a response (the oldest past that is metered as `TIMEOUT`) and at most 10 000 open sessions (idle ones expire after an hour).

Each tool call's idempotency key is minted once, when its event is created, and reused by every flush retry.

## Dropped events

A usage event the proxy loses is counted, WARN-logged, and — when the proxy is embedded as a library — passed to `aforo.onDrop(events, reason)`. Events keep their idempotency keys, so re-sending them is dedup-safe. The CLI has no flag for the hook; it logs.

| `reason` | When |
|---|---|
| `rejected` | The ingestor refused the batch with a non-retryable 4xx (400, 422, ...), or refused these events individually inside a batch it otherwise accepted. Per-event errors marked `retryable` are re-sent instead. |
| `invalid` | The tool call's event could not be sent: no customer for the call, `agentId` over 36 characters, `customerId` over 64, or `sessionId` over 64. The call is still forwarded to the MCP server. The WARN is logged for the first such call and then every 1000th. A `toolName` over 64 characters is not a drop: it is cut to 64 on the event and the call is metered (one WARN per label). |
| `overflow` | The queue was full (`maxQueueSize`) during an outage; the oldest event made room. |
| `shutdown` | Still queued when shutdown reached its deadline. |
| `closed` | Produced after shutdown began. |

An ingest outage is not a drop: on network errors, timeouts, 401, 403, 408, 429 and 5xx the batch is retried with full-jitter backoff (`Retry-After` honoured as seconds or an HTTP-date, capped at 60 s), then put back at the front of the queue with the same idempotency keys while the sender pauses (5 s, doubling up to 5 min). A wrong or revoked key (401/403) is logged once per outage. Only one ingest request is in flight at a time. When a 2xx response reports failures without saying which events, the count is logged and `onDrop` is not called. A failed session heartbeat is not a drop.

## Container image

The `Dockerfile` builds a runtime image that runs as the unprivileged `node` user and sets `AFORO_HEALTH_FILE=/tmp/aforo-proxy-alive`. Its health check passes only while that file is younger than a minute, which the proxy keeps fresh every 10 s while it serves.

## Walk me through it

Step-by-step from install to a verified metered call: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

Metering happens in the proxy's observe path, so it never blocks a tool call — **except** when `--quota-enforcement` is on, which adds a pre-flight check (1 s deadline, ALLOW answers reused for 1 s) that **fails open** by default; set `--quota-fail-mode closed` to refuse calls the check cannot answer. Usage waits in memory during an outage (up to `maxQueueSize`); it is lost if the proxy dies before sending it, and there is no disk spool. The proxy meters `tools/call`; `tools/list`, `resources/read`, and `prompts/get` are tracked for analytics, and protocol chatter (`initialize`, `ping`, notifications) is ignored. It does not transform tool payloads, rewrite responses, or add auth to the upstream server.
