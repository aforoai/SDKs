# aforo-mcp-metering

Meter MCP (Model Context Protocol) tool calls without rewriting your handlers — wrap each tool handler with one decorator and Aforo records every invocation (with timing and status), tracks the session, and batches events to the ingestor.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-mcp-metering
```

**Install `2.0.0` or later.** 2.0.0 changes how the billed customer is chosen; see the [changelog](CHANGELOG.md) before upgrading from 1.x. If `2.0.0` is not on PyPI yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/python-mcp     # folder holding setup.py
pip install -e .
```

The package depends on `httpx` (one pooled connection per client). The `aiohttp` and `httpx` extras are kept so old install lines still work; they add nothing.

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
    # Who pays for a call. Read it from what your server authenticated,
    # never from the tool arguments the MCP client sends.
    customer_resolver=lambda call: current_session().customer_id,
)

@server.call_tool()
@billing.wrap_tool_handler
async def handle_tool(name: str, arguments: dict, **kwargs):
    # your tool logic; kwargs may carry agent_id / session_id
    return [TextContent(type="text", text=result)]

# On shutdown (also runs at interpreter exit if you forget):
await billing.shutdown()
```

Sending starts when the client is constructed; there is no `start()` to call (it still exists and does nothing).

The decorator times the call and records one `mcp_server.tool_invocations` event per call. The call's `executionStatus` is derived for you: a returned result → `SUCCESS`; a returned result with `isError: true` (the normal way an MCP tool reports failure) → `ERROR`; a raised `TimeoutError` or an MCP error with JSON-RPC code `-32001` → `TIMEOUT`; any other raised exception → `ERROR`; `asyncio.CancelledError`, `KeyboardInterrupt` or `SystemExit` → `CANCELLED`. Exceptions are always re-raised. To override, pass a synchronous resolver: `@billing.wrap_tool_handler(status_resolver=lambda result, error: ...)` — it returns one of the 11 canonical statuses, or `None` to keep the default; a resolver that raises, is async, or returns an unknown value is logged and the default is used. Handlers may be `async def` or plain `def`.

Events POST to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and an `X-Tenant-Id: <tenant_id>` header.

> `tenant_id` is set in code from your trusted config — it is never read from a request the tool caller controls.

### Who is billed

Each event carries a `customerId` (the customer billed) and an `agentId` (the MCP client that made the call). Before 2.0.0 both were the `agent_id` kwarg, and a call without one was billed to `"unknown"`. Now:

- **`customer_resolver(call)`** (on the client, or per handler on `wrap_tool_handler`) returns the customer. `call` is a `ToolCall` with `name`, `arguments`, `kwargs` and `meta` (the request's `_meta` object). Use your authenticated session, not the tool arguments.
- **`trust_customer_header=True`** bills the `customer_id` kwarg, or `_meta.customer_id`, that the MCP client sends. Only use this when your transport authenticates the client and sets that value itself — otherwise any caller can bill someone else.
- With neither, `wrap_tool_handler` raises `ValueError` when you decorate.
- `agentId` is the `agent_id` kwarg; if a call has none, `agent_resolver(call)` is asked (for example to read the MCP session's `clientInfo`).
- A call with no customer or no agent still runs. Its event is not sent: it is counted in `dropped_count` and passed to `on_drop` with reason `invalid`.

## Configuration

Constructor arguments for `AforoMcpBilling(...)`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Your Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | MCP product the calls bill against; stamped in event metadata. |
| `api_key` | `str` | — (required) | Aforo API key, sent to the ingestor as `X-API-Key`. |
| `ingestor_url` | `str` | — (required) | Ingestor host; `/v1/ingest/batch` is appended. Use `https://api.aforo.ai`. Must be `https://`; plain `http://` is accepted only for `localhost`/`127.0.0.1`, or with `allow_insecure_http=True`. |
| `customer_resolver` | `Callable[[ToolCall], str \| None]?` | `None` | Returns the customer to bill for a call. This or `trust_customer_header` is required. |
| `trust_customer_header` | `bool` | `False` | Bill the `customer_id` the MCP client sends (kwarg or `_meta.customer_id`). Only safe when your transport authenticates the client. |
| `agent_resolver` | `Callable[[ToolCall], str \| None]?` | `None` | Supplies `agentId` when a call has no `agent_id` kwarg. |
| `flush_interval_sec` | `float` | `5.0` | Seconds between background sends. |
| `flush_count` | `int` | `500` | Queue size that wakes the sender early; also the batch size (clamped to 1..1000, the ingestor's batch limit). |
| `max_queue_size` | `int` | `10000` | Events held in memory. When full, the oldest are dropped with reason `overflow`. |
| `timeout_sec` | `float` | `10.0` | Timeout for each HTTP request. |
| `shutdown_timeout_sec` | `float` | `5.0` | Most time `shutdown()` (and the exit hook) spends sending what is left. |
| `on_error` | `Callable[[Exception], None]?` | logs at debug | Receives a `TransportError`; branch on `.kind`: `outage` / `auth` (events still queued and retried), `rejected` (the ingestor refused them; message carries its `errors[].message`), `shutdown`, `closed`. `.events` and `.status` say which events and which HTTP status. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Opt-in hook for events the SDK loses for good; `reason` is `overflow`, `rejected`, `invalid`, `shutdown` or `closed`. `billing.dropped_count` is the running total. Dropped events keep their idempotency keys. |
| `heartbeat_interval_sec` | `float` | `30.0` | Seconds between session heartbeats. |
| `heartbeat_enabled` | `bool` | `True` | Turn periodic session heartbeats off. |
| `on_session_killed` | `Callable[[str, str], None]?` | `None` | Called when the ingestor returns this session in `killedSessionIds`. |
| `product_type` | `str` | `"MCP_SERVER"` | Top-level `productType` on every event (trimmed + upper-cased; unknown values passed through). Override per call with a `product_type` handler kwarg or `record_tool_invocation(..., product_type=...)`. |

One background thread sends batches, one request at a time, over one pooled connection; a tool call never waits on the network. Network errors, timeouts, 408, 429, 5xx, 401 and 403 are treated as an outage: the batch is retried with jittered backoff (429 and 503 honour `Retry-After`, as seconds or an HTTP date, capped at 60 s), then a circuit breaker pauses sending and the events stay queued. Nothing is dropped for being unreachable — only when the queue is full (`overflow`). Any other 4xx drops the batch with reason `rejected` and `on_error` receives the ingestor's `errors[].message`; a 413 splits the batch in half first. Events the ingestor rejects individually in a `202` are dropped with reason `rejected` unless the response marks them retryable, in which case they are resent with the same idempotency key after the same backoff, at most 3 times. Every 5xx is retried, not only 500/502/503/504. A redirect (3xx) is never followed, so the API key cannot reach another host; it is treated like 401/403 and logged at ERROR with the target host. The circuit-breaker pause is full jitter: at most 5 s at first and at least 250 ms, growing to 5 min. Each request's `timeout_sec` covers the whole exchange, including reading the response. A flush during an outage makes one attempt; shutdown keeps retrying until its deadline. An event that cannot be turned into JSON is dropped as `invalid` when it is recorded.

`await billing.flush()` sends what is queued and waits (in a worker thread, so your event loop keeps running); it returns how many events are still queued. `await billing.shutdown()` stops heartbeats and sends for at most `shutdown_timeout_sec`; whatever is left is passed to `on_drop` as `shutdown`. The same happens at interpreter exit if you never call it. Code without a running event loop can call `billing.shutdown_sync()`. After a fork, the child gets its own sender.

`record_tool_invocation` (and the decorator) never raise for event content. An invocation the ingestor would reject — blank tool name, no customer or no agent, `agent_id` over 36 chars, `customer_id` or `session_id` over 64 UTF-16 code units — is not buffered or sent: it is counted in `dropped_count`, WARN-logged (first occurrence, then every 1000th) and passed to `on_drop` with reason `invalid`. Those ids are never truncated. `record_tool_invocation(tool_name, agent_id, ..., customer_id=...)` takes the customer explicitly. The tool name is different: it is the name from the client's `tools/call` request, so a name over 64 characters is truncated to 64 and the call is still metered (one WARNING per client). An `execution_status` outside the 11 canonical values is logged and left off; that event is still sent.

Session heartbeats (`start_session`, or automatically on the first tool call carrying `session_id`) are `system.session.heartbeat` events with `quantity: 1` and top-level `sessionId`, `productType`, `sessionBoundary` (`HEARTBEAT` / `SESSION_END`). Each is POSTed **alone** (`{"events": [heartbeat]}`), never inside a usage batch, so the ingestor always intercepts it before billing. They are best-effort: one attempt, failures logged, never affecting usage delivery and never counted in `dropped_count`.

## Walk me through it

Install → wrap a handler → fire a real tool call → confirm the event in Aforo, step by step, is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

This SDK **emits** invocation, heartbeat and session-end events — it does not price them. It does not enforce entitlements at call time: the only server-driven control is the `killedSessionIds` signal returned on a flush (on a heartbeat or a flush), which stops that session's heartbeats and fires `on_session_killed` (it does not abort an in-flight tool call). Streaming/partial tool results are recorded as a single invocation. Rate plans and metric mapping live in the Aforo console.
