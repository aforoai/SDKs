# @aforoai/agent-test-server

A runnable **toy AI_AGENT server** for testing Aforo's AI_AGENT metering
path. Speaks a REST-shaped wire protocol across **HTTP, stdio, and SSE**
transports. Bare — does no metering itself. Meant to sit *behind* the
layer under test: an agent SDK (`@aforoai/agent-metering`) wrapping its
invoke path, loadgen's new `ai_agent_wire` driver, or a future
gateway plugin.

Sibling of [`@aforoai/mcp-test-server`](../mcp-test-server/) — same
bare-by-design philosophy, different wire shape. MCP is JSON-RPC 2.0
with a fixed `tools/call` method; AI_AGENT is a REST protocol with
first-class session lifecycle (create, invoke × N, end) matching the
`research-agent.yaml` reference manifest.

## Why this exists

Loadgen's existing `ai_agent_rest` driver POSTs the standard ingest
envelope directly to usage-ingestor — good for exercising the
descriptor-driven per-capability path, but it bypasses the SDK entirely.
So SDK code paths (session state machine, buffered flushing, retry, drop
observability) are structurally invisible to it. This server closes that
gap: point the SDK at this server, and every capability the SDK wraps
becomes a real invocation the server handles.

The parallel with the MCP-side gap `@aforoai/mcp-test-server` closes is
exact — this server is what the `ai_agent_wire` loadgen driver targets,
same way `mcp_jsonrpc` targets `@aforoai/mcp-test-server`.

## Install

```bash
npm install
npm run build
```

## Usage

```bash
# HTTP transport (default) — REST endpoints
aforo-agent-test-server --transport http --port 8090

# stdio transport — newline-delimited JSON dispatch
aforo-agent-test-server --transport stdio

# SSE transport — per-session event stream
aforo-agent-test-server --transport sse --port 8091
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
| `--port <n>` | `8090` | HTTP + SSE port |
| `--host <host>` | `0.0.0.0` | HTTP + SSE bind host |
| `--simulate-latency` | off | Sleep per-capability simulated latency (500ms) before responding |
| `--verbose` | off | Echo request/response envelopes to stderr |

## Wire protocol (HTTP)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/agent/session` | Create a new session — body: `{agentId, tenantId?, metadata?}` |
| `GET` | `/agent/session/{id}` | Fetch a session snapshot (id, counters, status) |
| `DELETE` | `/agent/session/{id}` | End a session and return final counters |
| `POST` | `/agent/invoke` | Invoke a capability — body: `{sessionId, capability, input?}` |
| `GET` | `/agent/capabilities` | List the 5 canonical capabilities |
| `GET` | `/health` | JSON `{status:"UP", uptimeSeconds, server}` — docker HEALTHCHECK path |

`POST /agent/session` echoes the newly-minted id via the `X-Session-Id`
response header AND a `Location: /agent/session/{id}` header, so a
client following the Location can immediately GET the session state.

## Wire protocol (stdio)

Newline-delimited JSON envelopes. One object per line, one response per
non-notification request:

```json
{"id": 1, "method": "session.create", "params": {"agentId": "agt_1"}}
{"id": 2, "method": "invoke", "params": {"sessionId": "sess_...", "capability": "summarize_url", "input": {"url": "https://x"}}}
{"id": 3, "method": "session.end", "params": {"sessionId": "sess_..."}}
```

Methods: `session.create`, `session.get`, `session.end`, `invoke`. A
request without an `id` is a notification — server processes it,
writes nothing back.

## Wire protocol (SSE)

`GET /agent/stream/{sessionId}` opens a per-session event stream. Each
`POST /agent/invoke` against that session fans out an
`event: invocation` frame with the InvokeResponse. `DELETE /agent/session/{id}`
fans out an `event: session_end` frame. Heartbeats every 30s so intermediate
proxies (Kong, CloudFront) don't idle-timeout the stream.

## Canonical capabilities

Mirrors [`agent-samples/manifests/research-agent.yaml`](../agent-samples/manifests/research-agent.yaml).
Every handler is **deterministic** — given the same input, always the
same output. No timestamps, no randomness in the payload. The
`--simulate-latency` CLI flag adds a fixed 500ms sleep before responding
for perf-shape testing.

| Capability | Input | Notes |
|---|---|---|
| `summarize_url` | `{url, length?}` | Returns synthetic summary |
| `extract_entities` | `{text}` | Fixed 3 entities (PERSON, ORG, LOCATION) |
| `verify_claim` | `{claim, sources, require_hitl?}` | `require_hitl:true` → `HITL_REQUIRED` execution status |
| `rank_sources` | `{query, sources}` | Reverses the source list, deterministic ranking |
| `answer_question` | `{question, max_sources?}` | Returns synthetic answer with N synthetic sources |

The four execution_status values match the descriptor at
`aforo-nextgen-common/src/main/resources/descriptors/ai_agent.json`:
**SUCCESS**, **FAILURE**, **BLOCKED**, **HITL_REQUIRED**.

## Sessions

Sessions are first-class resources (unlike MCP where the session is
transport-carried). A session tracks (agentId, tenantId, per-session
counters, lifecycle timestamps) and is subject to two limits mirroring
`research-agent.yaml`'s `session:` block:

- Default idle timeout: **15 minutes** (configurable via `SessionStoreOptions.idleTimeoutSec`)
- Default max active: **100** (configurable via `SessionStoreOptions.capacity`)

Idle sessions are swept on a 30s tick. Ended sessions are retained for
2× the idle window so a follow-up `GET /agent/session/{id}` after end
still observes the terminal state.

## Test scenarios this unblocks

**A. SDK integration** — wrap `@aforoai/agent-metering` around a client
that talks to this server. Verifies the SDK's session state machine,
buffered flushing, and capability_name → dimension pricing bridge in
usage-ingestor's `ProductTypeEventExtractor.extractAiAgentFields`.

**B. Loadgen wire path** — loadgen's `ai_agent_wire` driver (see
`aforo-nextgen-loadgen/internal/driver/ai_agent_wire.go`) POSTs against
this server's HTTP endpoints. Exercises the full SDK → server →
optional-gateway → usage-ingestor path in a scenario.

```
loadgen ──POST /agent/invoke──▶ agent-test-server
                                    │
                                    └── SDK-emitted metering event (optional)
                                        via @aforoai/agent-metering wrap
```

**C. Nightly regression E2E** — the hello-agent example
(`node-agent/examples/hello-agent/`, `python-agent/examples/hello_agent/`)
uses this server as the invoke target so a scheduled run can prove the
SDK → server → ingest chain still holds.

## Docker

```bash
docker build -t aforo/agent-test-server .
docker run --rm -p 8090:8090 aforo/agent-test-server
```

Health check hits `GET /health` → JSON `{status:"UP", ...}`.

## Programmatic use

`startHttp` and `startSse` return `Promise<http.Server>` that resolves
after the `'listening'` event fires, so consumers can trust the port is
bound before they use it. `startStdio` is synchronous (no listen step).

```ts
import { AgentTestServer, startHttp } from '@aforoai/agent-test-server';

const server = new AgentTestServer();
const httpServer = await startHttp({ port: 8090, server });
const { port } = httpServer.address(); // safe — server is listening

// ... use it ...

httpServer.close();
server.dispose(); // stops the session sweeper timer
```

HTTP + SSE transports cap request bodies at 1 MiB by default
(configurable via `maxBodyBytes`). Array-at-root bodies are rejected
with a `malformed_body` error — this server takes single JSON objects
only. Response `'error'` events (client hung up mid-response) are
swallowed so the process doesn't crash under load.

## Tests

```bash
npm test
```

Covers: server dispatch (14 tests), HTTP transport (10), stdio
transport (3), SSE transport (3), session store (9). Total: **39**.
Includes production-hardening tests for body-size limit, ended-session
410, unknown-session-before-unknown-capability precedence, session
capacity cap, `params.arguments` type validation, `EADDRINUSE`
propagation, and SSE-fanout survives client disconnect.

## License

Apache-2.0 — see the repository [LICENSE](../LICENSE).
