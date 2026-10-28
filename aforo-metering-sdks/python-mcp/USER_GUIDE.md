# aforo-mcp-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Python engineers running an MCP server who need per-tool-call billing.

## What you'll build

An MCP server whose tool handlers are metered automatically: every call records one `mcp_server.tool_invocations` event with duration and status, and all of it batches to the Aforo ingestor. You'll finish by confirming a real tool call shows up in Aforo.

## Prerequisites

- Python **3.9+** and an async MCP server (handlers are `async def`).
- An Aforo **API key** (`AFORO_API_KEY`), a **tenant id**, and the **product id** for your MCP product, all from the Aforo console.
- `httpx` is installed with the package.
- A way to know which customer each tool call belongs to (your MCP server's authenticated session).

## Step 1 — Install

```bash
pip install -e .                 # from python-mcp/ (or: pip install "aforo-mcp-metering>=2.0.0")
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
    ingestor_url="https://api.aforo.ai",
    customer_resolver=lambda call: current_session().customer_id,
)
```

The first four arguments are required — the constructor raises `ValueError` if any is empty. `customer_resolver` decides who is billed for each call; it receives a `ToolCall` (`name`, `arguments`, `kwargs`, `meta`). Return the customer from what your server authenticated — never from `arguments`, which the MCP client controls. If your transport authenticates the client and sets `customer_id` (as a kwarg or in `_meta`) itself, you can pass `trust_customer_header=True` instead. With neither, `wrap_tool_handler` raises `ValueError`.

> ⚠ `ingestor_url` must be `https://`. Plain `http://` is accepted only for `localhost` and `127.0.0.1`, or with `allow_insecure_http=True`.

> ⚠ `ingestor_url` is a **host**, not a full path. The client appends `/v1/ingest/batch`. Pass `https://api.aforo.ai`, not `https://api.aforo.ai/v1/ingest/batch`.

## Step 3 — Wrap your tool handler

Stack the decorator under your MCP `@server.call_tool()` registration:

```python
@server.call_tool()
@billing.wrap_tool_handler
async def handle_tool(name: str, arguments: dict, **kwargs):
    # name = tool name, arguments = tool args.
    # kwargs may carry agent_id, session_id and product_type from your server.
    result = await run_tool(name, arguments)
    return [TextContent(type="text", text=result)]
```

The wrapper times the call and records the invocation in a `finally` block, so failures are still metered. The call's `executionStatus` is derived for you: a returned result → `SUCCESS`; a returned result with `isError: true` (the normal way an MCP tool reports failure) → `ERROR`; a raised `TimeoutError` or an MCP error with JSON-RPC code `-32001` → `TIMEOUT`; any other raised exception → `ERROR`; `asyncio.CancelledError`, `KeyboardInterrupt` or `SystemExit` → `CANCELLED`. Exceptions are always re-raised. To override, pass a synchronous resolver: `@billing.wrap_tool_handler(status_resolver=lambda result, error: ...)` — it returns one of the 11 canonical statuses, or `None` to keep the default; a resolver that raises, is async, or returns an unknown value is logged and the default is used. Handlers may be `async def` or plain `def`.

> ⚠ The wrapped handler **must** keep the `(name, arguments, **kwargs)` shape. `agent_id` and `session_id` are read from `kwargs`. A call without `agent_id` asks `agent_resolver` (if you set one); a call with no agent or no customer still runs, but its event is not sent — it is counted in `dropped_count` and passed to `on_drop` with reason `invalid`. Nothing is billed to `"unknown"`.

## Step 4 — How events are sent

Events queue in memory (up to `max_queue_size`, 10 000) and a background thread sends them in batches of up to `flush_count` (500), every `flush_interval_sec` (5 s) or sooner when the queue reaches `flush_count`. It starts when the client is constructed — there is nothing to start. `await billing.start()` still exists and does nothing.

## Step 5 — Fire a real tool call and flush

Invoke a tool through your MCP client as normal. Then force a flush to confirm delivery now instead of waiting for the timer:

```python
await billing.flush()
```

`flush()` sends what is queued and waits for it in a worker thread (your event loop keeps running). It returns how many events are still queued — non-zero while the ingestor can't be reached. Each 2xx response is checked for `killedSessionIds` — if your active session is in that list it stops the session's heartbeats and calls `on_session_killed` (heartbeat responses are checked the same way). Old ingestors that return an empty `202` are handled (the parse is best-effort).

## Step 6 — Verify it landed in Aforo

In the Aforo console, open the usage/events view for your tenant and filter by `metric_name = mcp_server.tool_invocations`. You should see one event per call carrying `toolName`, `agentId`, `executionStatus`, and `executionDurationMs`. If nothing appears, check the `ingestor_url` host and that the API key matches the tenant — see Troubleshooting.

## Step 7 — Sessions (optional)

```python
await billing.start_session("sess_abc123", customer_id="cust_acme")  # heartbeat now + every 30 s
# ... session runs, tools get called ...
await billing.end_session()   # stops heartbeats, flushes, sends SESSION_END
```

You don't have to call `start_session` yourself — `wrap_tool_handler` starts the session from the first tool call that carries a `session_id` (using that call's customer as the heartbeat customer). Heartbeats are `system.session.heartbeat` events with `quantity: 1`, top-level `sessionId`, `productType` (the session's; `start_session(product_type=...)`, default the client's) and `sessionBoundary` (`HEARTBEAT`, or `SESSION_END` from `end_session()`), and `customerId` = `customer_id` (default `"system"`). Each is POSTed **on its own** (`{"events": [heartbeat]}`) — never inside a usage batch — so it always takes the ingestor's synchronous path, where heartbeats are intercepted before billing. They are best-effort: one attempt, no retry, failures logged at debug level. `heartbeat_interval_sec` sets the cadence; `heartbeat_enabled=False` turns periodic heartbeats off.

## Step 8 — Shut down cleanly

```python
await billing.shutdown()   # stops heartbeats, sends what is left for up to shutdown_timeout_sec
```

Events still queued at the deadline are passed to `on_drop` with reason `shutdown`. If you never call `shutdown()`, the same runs at interpreter exit. Code without a running event loop can call `billing.shutdown_sync()`. A hard crash (`SIGKILL`, out of memory) skips both — queued events are lost.

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | required | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | required | MCP product id; stamped in metadata. |
| `api_key` | `str` | required | Aforo API key, sent as `X-API-Key`. |
| `ingestor_url` | `str` | required | Host; `/v1/ingest/batch` appended. `https://` only (see Step 2). |
| `customer_resolver` | `Callable[[ToolCall], str \| None]?` | `None` | Customer to bill per call. This or `trust_customer_header` is required. |
| `trust_customer_header` | `bool` | `False` | Bill the `customer_id` the MCP client sends. Only with an authenticating transport. |
| `agent_resolver` | `Callable[[ToolCall], str \| None]?` | `None` | `agentId` for calls without an `agent_id` kwarg. |
| `flush_interval_sec` | `float` | `5.0` | Seconds between background sends. |
| `flush_count` | `int` | `500` | Batch size; a queue this long wakes the sender (clamped to 1..1000). |
| `max_queue_size` | `int` | `10000` | Events held in memory; the oldest are dropped as `overflow` when full. |
| `timeout_sec` | `float` | `10.0` | Per-request timeout. |
| `shutdown_timeout_sec` | `float` | `5.0` | Time limit for `shutdown()` and the exit hook. |
| `allow_insecure_http` | `bool` | `False` | Accept a plain `http://` ingestor that isn't localhost. |
| `on_error` | `Callable?` | logs at debug | Receives a `TransportError`; branch on `.kind`: `outage` / `auth` (events still queued and retried), `rejected` (the ingestor refused them; message carries its `errors[].message`), `shutdown`, `closed`. `.events` and `.status` say which events and which HTTP status. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with events lost for good; `reason` is `overflow`, `rejected`, `invalid`, `shutdown` or `closed`. `dropped_count` is the running total. |
| `heartbeat_interval_sec` | `float` | `30.0` | Seconds between session heartbeats. |
| `heartbeat_enabled` | `bool` | `True` | Turn periodic session heartbeats off. |
| `on_session_killed` | `Callable[[str, str], None]?` | `None` | Called on a server kill signal `(session_id, "SERVER_KILL")`. |
| `product_type` | `str` | `"MCP_SERVER"` | Top-level `productType` on every event; per-call override via the `product_type` handler kwarg or `record_tool_invocation(product_type=...)`. |

Methods: `wrap_tool_handler(handler, *, status_resolver=None, customer_resolver=None, trust_customer_header=None)`, `record_tool_invocation(tool_name, agent_id, session_id=None, execution_status="SUCCESS", execution_duration_ms=0, *, product_type=None, customer_id=None)`, `flush(timeout=None)`, `start_session(session_id, product_type=None, customer_id=None)`, `end_session()`, `shutdown(timeout=None)`, `shutdown_sync(timeout=None)`. `start()` is kept and does nothing.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ValueError` when decorating a handler | Neither `customer_resolver` nor `trust_customer_header=True` is set. | Pass a `customer_resolver` (see Step 2). |
| No events, `dropped_count` rises with reason `invalid` | The call had no customer (resolver returned nothing) or no agent (`agent_id` kwarg missing and no `agent_resolver`). | Return a customer from your resolver; pass `agent_id` through or set `agent_resolver`. |
| Events stay queued, one ERROR "rejected the API key" | 401/403 — treated as an outage, so events are kept and retried. | Fix `api_key`; confirm it belongs to `tenant_id`. |
| `dropped_count` rises, WARN "Invalid tool invocation not sent" | Blank tool name, `agent_id` over 36 chars, or `customer_id` / `session_id` over 64 UTF-16 code units. The invocation is not sent and those ids are not truncated. (A tool name over 64 chars does not drop the event: it is truncated to 64 and the call is still sent.) | Shorten the id at the source; inspect the events your `on_drop` hook receives with reason `"invalid"`. |
| A failed tool bills as `SUCCESS` | The tool returns an error payload without `isError: true` and without raising. | Return `isError: true`, raise, or pass a `status_resolver`. |
| Events sent, none in console | Wrong `ingestor_url` host, or `mcp_server.tool_invocations` isn't mapped to a rate plan. | Use `https://api.aforo.ai`; map the metric in the Aforo console. |
| Session keeps billing after you expected it killed | Kill only clears the SDK's session; it does not abort the in-flight tool call. | Handle the stop in `on_session_killed` and close the session yourself. |
| Events lost on restart | The process was killed before the exit hook ran, or `shutdown_timeout_sec` was too short. | `await billing.shutdown()` in your shutdown path; watch `on_drop` for reason `shutdown`. |

## What this guide does NOT cover

It doesn't define what `mcp_server.tool_invocations` costs — pricing and metric mapping are in the Aforo console. It doesn't enforce quotas before a tool runs; the only server-side control is the post-flush `killedSessionIds` signal, which stops the session's heartbeats rather than blocking calls. For non-MCP protocols (HTTP, gRPC, GraphQL, WebSocket, MQTT) use the matching package in this SDK repo.
