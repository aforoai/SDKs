# aforo-mcp-metering

Meter MCP (Model Context Protocol) tool calls without rewriting your handlers — wrap each tool handler with one decorator and Aforo records every invocation (with timing and status), tracks the session, and batches events to the ingestor.

**Version:** 1.3.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-mcp-metering
# pick an async HTTP client (optional — stdlib urllib is the fallback):
pip install "aforo-mcp-metering[aiohttp]"
pip install "aforo-mcp-metering[httpx]"
```

**Install `1.3.2` or later. `1.0.0` on PyPI was built from an older copy of this code and lacks the fixes listed in the changelog.** If `1.3.2` is not on PyPI yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/python-mcp     # folder holding setup.py
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

The decorator times the call and records one `mcp_server.tool_invocations` event per call. The call's `executionStatus` is derived for you: a returned result → `SUCCESS`; a returned result with `isError: true` (the normal way an MCP tool reports failure) → `ERROR`; a raised `TimeoutError` or an MCP error with JSON-RPC code `-32001` → `TIMEOUT`; any other raised exception → `ERROR`; `asyncio.CancelledError`, `KeyboardInterrupt` or `SystemExit` → `CANCELLED`. Exceptions are always re-raised. To override, pass a synchronous resolver: `@billing.wrap_tool_handler(status_resolver=lambda result, error: ...)` — it returns one of the 11 canonical statuses, or `None` to keep the default; a resolver that raises, is async, or returns an unknown value is logged and the default is used. Handlers may be `async def` or plain `def`.

Events POST to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and an `X-Tenant-Id: <tenant_id>` header.

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
| `flush_count` | `int` | `50` | Buffer size that triggers an immediate async flush (clamped to 1..1000, the ingestor's batch limit). |
| `on_error` | `Callable[[Exception], None]?` | logs the error | Invoked when a batch fails permanently. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Opt-in hook for events the SDK loses; `reason` is `retry_exhausted`, `rejected` or `invalid`. `billing.dropped_count` is the running total. Dropped events keep their idempotency keys. |
| `heartbeat_interval_sec` | `float` | `30.0` | Seconds between session heartbeats. |
| `heartbeat_enabled` | `bool` | `True` | Turn periodic session heartbeats off. |
| `on_session_killed` | `Callable[[str, str], None]?` | `None` | Called when the ingestor returns this session in `killedSessionIds`. |
| `product_type` | `str` | `"MCP_SERVER"` | Top-level `productType` on every event (trimmed + upper-cased; unknown values passed through). Override per call with a `product_type` handler kwarg or `record_tool_invocation(..., product_type=...)`. |

Retry is fixed at **3 attempts** with `1s / 2s / 4s` backoff; 429 honours `Retry-After`; any other 4xx except 408 is non-retryable: `on_error` receives the ingestor's `errors[].message` and the batch is dropped with reason `rejected`. A batch that still fails after 3 attempts is dropped with reason `retry_exhausted`. Events the ingestor rejects individually in a `202` (`failed` / `errors[]`) are dropped with reason `rejected`; only the ones the response names by index are passed to `on_drop`.

`record_tool_invocation` (and the decorator) never raise for event content. An invocation the ingestor would reject — blank tool name, `agent_id` over 36 chars (it is sent as both `agentId` and `customerId`), `session_id` over 64 chars — is not buffered or sent: it is counted in `dropped_count`, WARN-logged (first occurrence, then every 1000th) and passed to `on_drop` with reason `invalid`. Those ids are never truncated. The tool name is different: it is the name from the client's `tools/call` request, so a name over 64 characters is truncated to 64 and the call is still metered (one WARNING per client). An `execution_status` outside the 11 canonical values is logged and left off; that event is still sent.

Session heartbeats (`start_session`, or automatically on the first tool call carrying `session_id`) are `system.session.heartbeat` events with `quantity: 1` and top-level `sessionId`, `productType`, `sessionBoundary` (`HEARTBEAT` / `SESSION_END`). Each is POSTed **alone** (`{"events": [heartbeat]}`), never inside a usage batch, so the ingestor always intercepts it before billing. They are best-effort: one attempt, failures logged, never affecting usage delivery and never counted in `dropped_count`.

## Walk me through it

Install → wrap a handler → fire a real tool call → confirm the event in Aforo, step by step, is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

This SDK **emits** invocation, heartbeat and session-end events — it does not price them. It does not enforce entitlements at call time: the only server-driven control is the `killedSessionIds` signal returned on a flush (on a heartbeat or a flush), which stops that session's heartbeats and fires `on_session_killed` (it does not abort an in-flight tool call). Streaming/partial tool results are recorded as a single invocation. Rate plans and metric mapping live in the Aforo console.
