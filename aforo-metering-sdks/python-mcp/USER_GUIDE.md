# aforo-mcp-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Python engineers running an MCP server who need per-tool-call billing.

## What you'll build

An MCP server whose tool handlers are metered automatically: every call records one `mcp_server.tool_invocations` event with duration and status, and all of it batches to the Aforo ingestor. You'll finish by confirming a real tool call shows up in Aforo.

## Prerequisites

- Python **3.9+** and an async MCP server (handlers are `async def`).
- An Aforo **API key** (`AFORO_API_KEY`), a **tenant id**, and the **product id** for your MCP product, all from the Aforo console.
- Optional: `aiohttp` or `httpx` for the async HTTP flush. Without either, the SDK uses stdlib `urllib`.

## Step 1 — Install

```bash
pip install -e .                 # from python-mcp/ (not yet on PyPI)
pip install -e ".[httpx]"        # or [aiohttp] for an async client
```

## Step 2 — Construct the billing client

Do this once, at server startup, with values from trusted config:

```python
import os
from aforo_mcp_metering import AforoMcpBilling

billing = AforoMcpBilling(
    tenant_id="tenant_smartai",
    product_id="prod_mcp_001",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://ingest.aforo.ai",
)
```

All four arguments are required — the constructor raises `ValueError` if any is empty.

> ⚠ `ingestor_url` is a **host**, not a full path. The client appends `/v1/ingest/batch`. Pass `https://ingest.aforo.ai`, not `https://ingest.aforo.ai/v1/ingest/batch`.

## Step 3 — Wrap your tool handler

Stack the decorator under your MCP `@server.call_tool()` registration:

```python
@server.call_tool()
@billing.wrap_tool_handler
async def handle_tool(name: str, arguments: dict, **kwargs):
    # name = tool name, arguments = tool args.
    # kwargs may carry agent_id and session_id from your server.
    result = await run_tool(name, arguments)
    return [TextContent(type="text", text=result)]
```

The wrapper times the call, records the invocation in a `finally` block (so failures are still billed), and re-raises any exception with `executionStatus="ERROR"`.

> ⚠ The wrapped handler **must** keep the `(name, arguments, **kwargs)` shape. `agent_id` and `session_id` are read from `kwargs`; if your server passes them positionally or under different names, they won't be attributed (`agent_id` falls back to `"unknown"`). The `customerId` on each event is the `agent_id` — so a missing `agent_id` bills everything to `"unknown"`.

## Step 4 — Start the flush loop

Events buffer in memory and flush on three triggers: hitting `flush_count` (50), the periodic loop (`flush_interval_sec`, 5 s), and `shutdown()`. The periodic loop only runs after you start it:

```python
await billing.start()   # call once inside your event loop
```

## Step 5 — Fire a real tool call and flush

Invoke a tool through your MCP client as normal. Then force a flush to confirm delivery now instead of waiting for the timer:

```python
await billing.flush()
```

`flush()` POSTs the buffered batch and, on a 2xx, parses the response for `killedSessionIds` — if your active session is in that list it clears the session and calls `on_session_killed`. (The ingestor only computes `killedSessionIds` while processing heartbeats, so with heartbeats removed this signal is not expected to fire until a dedicated heartbeat API exists.) Old ingestors that return an empty `202` are handled (the parse is best-effort).

## Step 6 — Verify it landed in Aforo

In the Aforo console, open the usage/events view for your tenant and filter by `metric_name = mcp_server.tool_invocations`. You should see one event per call carrying `toolName`, `agentId`, `executionStatus`, and `executionDurationMs`. If nothing appears, check the `ingestor_url` host and that the API key matches the tenant — see Troubleshooting.

## Step 7 — Sessions (optional)

```python
await billing.start_session("sess_abc123")   # records the active session
# ... session runs, tools get called ...
await billing.end_session()                   # clears the session, then flushes
```

You don't have to call `start_session` yourself — `wrap_tool_handler` records the session from the first tool call that carries a `session_id`. Session heartbeats are no longer sent: they were `system.session.heartbeat` events with `quantity: 0` sent in the usage batch, and the ingestor rejects quantity 0 and fails the whole batch with 400, taking every real event batched with it down. The ingestor has no dedicated heartbeat endpoint. `heartbeat_enabled` / `heartbeat_interval_sec` are accepted and ignored.

## Step 8 — Shut down cleanly

```python
await billing.shutdown()   # stops the flush loop, flushes remaining events
```

A hard crash skips this — buffered events that never flushed are lost.

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | required | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | required | MCP product id; stamped in metadata. |
| `api_key` | `str` | required | Aforo API key, sent as `X-API-Key`. |
| `ingestor_url` | `str` | required | Host; `/v1/ingest/batch` appended. |
| `flush_interval_sec` | `float` | `5.0` | Periodic flush cadence (needs `start()`). |
| `flush_count` | `int` | `50` | Buffer size that triggers an async flush. |
| `on_error` | `Callable?` | logs | Called on permanent batch failure. |
| `heartbeat_interval_sec` | `float` | `30.0` | Deprecated, ignored — heartbeats are no longer sent. |
| `heartbeat_enabled` | `bool` | `True` | Deprecated, ignored — heartbeats are no longer sent. |
| `on_session_killed` | `Callable[[str, str], None]?` | `None` | Called on a server kill signal `(session_id, "SERVER_KILL")`. |

Methods: `wrap_tool_handler(handler)`, `record_tool_invocation(tool_name, agent_id, session_id=None, execution_status="SUCCESS", execution_duration_ms=0)`, `start()`, `flush()`, `start_session(session_id)`, `end_session()`, `shutdown()`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events at all | `await start()` was never called and the buffer hasn't hit `flush_count`. | Call `await billing.start()` once, or `await billing.flush()` to force it. |
| Every event has `agentId = "unknown"` | The handler didn't receive `agent_id` in `kwargs`. | Pass `agent_id` (and `session_id`) through from your MCP server to the tool handler. |
| `on_error` fires with "Aforo returned 401/403" | Bad/unscoped API key — 4xx is dropped, not retried. | Fix `api_key`; confirm it belongs to `tenant_id`. |
| Events sent, none in console | Wrong `ingestor_url` host, or `mcp_server.tool_invocations` isn't mapped to a rate plan. | Use `https://ingest.aforo.ai`; map the metric in the Aforo console. |
| Session keeps billing after you expected it killed | Kill only clears the SDK's session; it does not abort the in-flight tool call. | Handle the stop in `on_session_killed` and close the session yourself. |
| Events lost on restart | Buffered events weren't flushed before exit. | `await billing.shutdown()` in your shutdown path. |

## What this guide does NOT cover

It doesn't define what `mcp_server.tool_invocations` costs — pricing and metric mapping are in the Aforo console. It doesn't enforce quotas before a tool runs; the only server-side control is the post-flush `killedSessionIds` signal, which clears the session rather than blocking calls (The ingestor only computes `killedSessionIds` while processing heartbeats, so with heartbeats removed this signal is not expected to fire until a dedicated heartbeat API exists.) For non-MCP protocols (HTTP, gRPC, GraphQL, WebSocket, MQTT) use the matching package in this SDK repo.
