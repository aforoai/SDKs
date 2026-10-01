# @aforoai/mcp-test-server

A runnable **toy MCP server** for testing Aforo's MCP metering path. Speaks
JSON-RPC 2.0 across **HTTP, stdio, and SSE (Streamable HTTP)** transports.
Bare — does no metering itself. Meant to sit *behind* the layer under test:
a Kong instance with the Aforo Metering plugin, an mcp-proxy sidecar, or an
MCP server wrapped in `@aforoai/mcp-metering`.

## Why this exists

Loadgen's `ci-mcp-only` scenario proves the *ingest → billing* pipeline
holds under MCP-shaped events, but never emits a real JSON-RPC `tools/call`
payload — so gateway-plugin detection code paths (Kong's `handler.lua`
`detect_mcp_tool_call`, Azure APIM's `<when>` branch, AWS Lambda's
`detectMcpToolCall`, Apigee's callout, MuleSoft's DataWeave) are
structurally invisible to it. This server closes that gap: point loadgen's
new `mcp_jsonrpc` driver at this server (or at a gateway sitting in front
of it), and every request becomes a real MCP call the plugin can see.

## Install

```bash
npm install
npm run build
```

## Usage

```bash
# HTTP transport (default) — POST /mcp accepts JSON-RPC 2.0 bodies
aforo-mcp-test-server --transport http --port 8080

# stdio transport — newline-delimited JSON-RPC on stdin/stdout
aforo-mcp-test-server --transport stdio

# SSE (Streamable HTTP) — POST /mcp + GET /mcp with Mcp-Session-Id header
aforo-mcp-test-server --transport sse --port 8081
```

Or the workspace shortcuts:

```bash
npm run start:http
npm run start:stdio
npm run start:sse
```

## Options

| Flag | Default | Purpose |
|---|---|---|
| `--transport <mode>` | `http` | `http`, `stdio`, or `sse` |
| `--port <n>` | `8080` | HTTP + SSE port |
| `--host <host>` | `0.0.0.0` | HTTP + SSE bind host |
| `--simulate-latency` | off | Sleep per-tool typical latency before replying (300ms for heavy tools, 5ms otherwise) |
| `--verbose` | off | Echo request/response envelopes to stderr |

## What it does (and doesn't)

**Handles:** `initialize`, `initialized`, `ping`, `tools/list`, `tools/call`.
Returns 10 synthetic tools mirroring the loadgen `defaultMCPTools` list:
`search_web`, `read_file`, `write_file`, `execute_query`, `vector_search`,
`summarize`, `translate`, `classify`, `send_email`, `create_record`.

**Doesn't:** any actual work (all responses are deterministic synthetic
data), any metering (bare — that's the point), resources / prompts /
sampling methods (out of scope for a test server).

## Test scenarios this unblocks

**A. Gateway-plugin detection** — Kong (or Apigee/AWS/Azure/MuleSoft) in
front, this server as the upstream, loadgen's `mcp_jsonrpc` driver as the
client. Any regression in the plugin's `tools/call` extraction now shows
up as a delta in expected event count.

```
loadgen ──POST /mcp──▶ Kong (with aforo-metering plugin) ──▶ mcp-test-server
                                    │
                                    └── generates metering event
```

**B. SDK integration** — wrap this server's `McpTestServer.handle()` with
`@aforoai/mcp-metering`'s `wrapToolHandler` in your test harness. Point
loadgen at it directly.

**C. Proxy sidecar** — run `@aforoai/mcp-proxy` in front of this server
(any transport), point loadgen at the proxy. Verifies the proxy's
inline `tools/call` interception across stdio / SSE / Streamable HTTP.

## Docker

```bash
docker build -t aforo/mcp-test-server .
docker run --rm -p 8080:8080 aforo/mcp-test-server
```

Health check hits `GET /health` → returns `ok`.

## Programmatic use

`startHttp` and `startSse` return `Promise<http.Server>` that resolves
after the `'listening'` event fires, so consumers can trust the port is
bound before they use it. `startStdio` is synchronous (no listen step).

```ts
import { McpTestServer, startHttp } from '@aforoai/mcp-test-server';

const server = new McpTestServer();
const httpServer = await startHttp({ port: 8080, server });
const { port } = httpServer.address(); // safe — server is listening
```

Both HTTP and SSE transports cap request bodies at 1 MiB by default
(configurable via `maxBodyBytes`). JSON-RPC batch requests (top-level
array) are rejected with `-32600 InvalidRequest` per MCP spec
2024-11-05. Response `'error'` events (client hung up mid-stream) are
swallowed so the process doesn't crash under load.

## Tests

```bash
npm test
```

Covers: server dispatch (10 tests), HTTP transport (8), stdio transport
(3), SSE transport (5). Total: **26**. Includes production-hardening
tests for body-size limit, batch rejection, `params.arguments` type
validation, `EADDRINUSE` propagation, and SSE-fanout-survives-client-
disconnect.

## License

Apache-2.0 — see the repository [LICENSE](../LICENSE).
