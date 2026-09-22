# aforo-mcp-metering

Meter MCP (Model Context Protocol) tool calls without rewriting your handlers — wrap each tool handler with one decorator and Aforo records every invocation (with timing and status), tracks the session, and batches events to the ingestor.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

> The package manifest (`setup.py`) declares **no license**. Treat the license as unset until the project sets one; this doc does not assert a license the source doesn't.

## Install

Intended public install:

```bash
pip install aforo-mcp-metering
# pick an async HTTP client (optional — stdlib urllib is the fallback):
pip install "aforo-mcp-metering[aiohttp]"
pip install "aforo-mcp-metering[httpx]"
```

**Not yet on PyPI — install from source for now:**

```bash
git clone https://github.com/aforoai/aforo-metering-sdks.git
cd aforo-metering-sdks/python-mcp     # folder holding setup.py
pip install -e .
pip install -e ".[aiohttp]"           # or [httpx]
```

The core package has **zero required dependencies** — it falls back to `urllib` for the HTTP flush if neither `aiohttp` nor `httpx` is installed. Install one of the extras if you want a real async client.

## Quickstart

Best when you run an MCP server with `async` tool handlers and want per-call billing with no plumbing inside the handler body.

```python
import os
from aforo_mcp_metering import AforoMcpBilling

billing = AforoMcpBilling(
    tenant_id="tenant_smartai",
    product_id="prod_mcp_001",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://api.aforo.ai",
    product_type="MCP_SERVER",  # default; sent as productType on every event
)

@server.call_tool()
@billing.wrap_tool_handler
async def handle_tool(name: str, arguments: dict, **kwargs):
    # your tool logic; kwargs may carry agent_id / session_id
    return [TextContent(type="text", text=result)]

# Start the periodic flush loop once (inside your async runtime):
await billing.start()
# On shutdown:
await billing.shutdown()
```

The decorator times the call, sets `executionStatus` to `SUCCESS` or `ERROR` (re-raising any exception), and records one `mcp_server.tool_invocations` event per call. Events POST to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and an `X-Tenant-Id: <tenant_id>` header.

> `tenant_id` is set in code from your trusted config — it is never read from a request the tool caller controls. `wrap_tool_handler` reads `agent_id` and `session_id` from the handler's `**kwargs`; pass them through from your MCP server, or `agent_id` defaults to `"unknown"`.

## Configuration

Constructor arguments for `AforoMcpBilling(...)`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Your Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | MCP product the calls bill against; stamped in event metadata. |
| `api_key` | `str` | — (required) | Aforo API key, sent to the ingestor as `X-API-Key`. |
| `ingestor_url` | `str` | — (required) | Ingestor host; `/v1/ingest/batch` is appended. Use `https://api.aforo.ai`. |
| `flush_interval_sec` | `float` | `5.0` | Background flush cadence (seconds). Requires `await start()`. |
| `flush_count` | `int` | `50` | Buffer size that triggers an immediate async flush. |
| `on_error` | `Callable[[Exception], None]?` | logs the error | Invoked when a batch fails permanently. |
| `heartbeat_interval_sec` | `float` | `30.0` | Seconds between session heartbeats. |
| `heartbeat_enabled` | `bool` | `True` | Turn periodic session heartbeats off. |
| `on_session_killed` | `Callable[[str, str], None]?` | `None` | Called when the ingestor returns this session in `killedSessionIds`. |
| `product_type` | `str` | `"MCP_SERVER"` | Top-level `productType` on every event (trimmed + upper-cased; unknown values passed through). Override per call with a `product_type` handler kwarg or `record_tool_invocation(..., product_type=...)`. |

Retry is fixed at **3 attempts** with `1s / 2s / 4s` backoff; 429 honours `Retry-After`; any other 4xx except 408 is non-retryable and the batch is dropped via `on_error` (with the ingestor's `errors[].message`). An invocation the ingestor would reject (blank tool name, `customerId` over 64 chars) is dropped via `on_error` instead of failing its batch; `toolName` is capped at 64 chars and `agentId` at 36.

Session heartbeats (`start_session`, or automatically on the first tool call carrying `session_id`) are `system.session.heartbeat` events with `quantity: 1` and top-level `sessionId`, `productType`, `sessionBoundary` (`HEARTBEAT` / `SESSION_END`). Each is POSTed **alone** (`{"events": [heartbeat]}`), never inside a usage batch, so the ingestor always intercepts it before billing. They are best-effort: one attempt, failures logged, never affecting usage delivery.

## Walk me through it

Install → wrap a handler → fire a real tool call → confirm the event in Aforo, step by step, is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

This SDK **emits** invocation, heartbeat and session-end events — it does not price them. It does not enforce entitlements at call time: the only server-driven control is the `killedSessionIds` signal returned on a flush (on a heartbeat or a flush), which stops that session's heartbeats and fires `on_session_killed` (it does not abort an in-flight tool call). Streaming/partial tool results are recorded as a single invocation. Rate plans and metric mapping live in the Aforo console.
