# aforo-ws-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Python engineers serving WebSocket connections who need connection- or frame-level billing.

## What you'll build

A WebSocket server that reports usage to Aforo — by default one connection-open and one connection-close event per socket, with aggregated message counts, bytes, and duration on close. Works with the `websockets` library or FastAPI/Starlette routes. You'll finish by confirming a real connection's events reached the Aforo ingestor.

## Prerequisites

- Python **3.9+**.
- An Aforo **API key**, **tenant id**, and **product id** from the Aforo console.
- A WebSocket server: the `websockets` library, or FastAPI/Starlette.
- A way to resolve `customer_id` from identity your service verified (a session or token checked during the handshake).

## Step 1 — Install

```bash
pip install -e .                  # from python-ws/ (or: pip install "aforo-ws-metering>=2.0.0")
pip install -e ".[fastapi]"       # or [websockets] / [httpx]
```

## Step 2 — Construct the billing client

```python
import os
from aforo_ws_metering import AforoWsBilling

billing = AforoWsBilling(
    tenant_id="tenant_acme",
    product_id="prod_ws_market_feed",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://api.aforo.ai",
)
```

All four arguments are required — the constructor raises `ValueError` if any is empty.

> ⚠ `ingestor_url` is the **host**; this package appends `/v1/ingest/batch`. Pass `https://api.aforo.ai`.

## Step 3 — Resolve the customer, then wrap the connection

The tracker meters a connection only while it's wrapped in the `async with` block. Resolve `customer_id` first; reject the socket if you can't:

**`websockets` library:**

```python
from aforo_ws_metering import track_websockets_connection

async def handler(ws):
    customer_id = customer_for_token(ws.request.headers.get("Authorization"))  # your verified auth
    if not customer_id:
        await ws.close(code=4401); return
    async with await track_websockets_connection(billing, ws, customer_id):
        async for msg in ws:
            await ws.send(f"echo: {msg}")
```

**FastAPI / Starlette:**

```python
from aforo_ws_metering import track_starlette_websocket

@app.websocket("/ws")
async def ws_handler(ws: WebSocket):
    await ws.accept()
    customer_id = customer_for_token(ws.headers.get("authorization"))  # your verified auth
    if not customer_id:
        await ws.close(code=4401); return
    async with await track_starlette_websocket(billing, ws, customer_id):
        while True:
            data = await ws.receive_text()
            await ws.send_text(f"echo: {data}")
```

> ⚠ The tracker wraps the connection's `send`/`recv` to count traffic. Resolve `customer_id` from identity you verified — don't bill against a value the client can set freely. `trust_customer_header=True` (instead of `customer_id`) reads `x-customer-id` from the handshake, only safe behind a gateway that sets it; `customer_resolver=callable(websocket)` is the other option. An unwrapped route emits nothing.

## Step 4 — Drive some frames and let the connection close

Send and receive normally inside the block. When the `async with` exits — clean close, client disconnect, or an exception — the tracker emits the close event with `messageCount` (sent + received), `dataBytes`, `executionDurationMs`, and a `wsCloseReason` label.

## Step 5 — Verify it landed in Aforo

In the Aforo console, open the usage/events view for your tenant and filter by `metric_name = websocket_api.connection_closed` (opens arrive as `websocket_api.connection_opened` with frame type `OPEN`; `websocket_api.message` if you enabled per-frame). You should see the close event carrying the aggregated counts and the mapped close reason. If nothing appears, check the `ingestor_url` host and that the connection was actually wrapped — see Troubleshooting.

## Step 6 — Per-frame billing (optional, high volume)

For one event per inbound/outbound frame instead of open+close:

```python
billing = AforoWsBilling(..., per_frame_events=True)
```

> ⚠ A busy socket can emit thousands of frames a second — `per_frame_events=True` multiplies your event volume accordingly. The queue (10 000 events, sent in batches of up to 500 every 3 s) is sized for this, but make sure your rate plan and ingest budget expect it.

## Step 7 — Shut down cleanly

```python
billing.shutdown()   # flushes the final batch before process exit
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | required | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | required | Product the connections bill against. |
| `api_key` | `str` | required | Aforo API key, sent as `X-API-Key`. |
| `ingestor_url` | `str` | required | Host; `/v1/ingest/batch` appended. |
| `flush_interval_sec` | `float` | `3.0` | Background flush cadence. |
| `flush_count` | `int` | `500` | Events per request, and the queue size that wakes the sender early (at most 1000). |
| `per_frame_events` | `bool` | `False` | One event per frame vs. open + close. |
| `on_error` | `Callable?` | logs | Receives a `TransportError`; branch on `.kind`: `outage` / `auth` (events still queued and retried), `rejected` (the ingestor refused them; message carries its `errors[].message`), `shutdown`, `closed`. `.events` and `.status` say which events and which HTTP status. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with events that will not be delivered and the reason (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). Pass by keyword. |
| `product_type` | `str` | `"WEBSOCKET_API"` | Top-level `productType` sent on every event (trimmed and upper-cased; values the SDK does not know are passed through). Override per event with a `productType` key in `push({...})` or `product_type=` on `track_websockets_connection` / `track_starlette_websocket`. |
| `max_queue_size` | `int` | `10000` | Queue capacity; the oldest event is dropped as `overflow` when full. Keyword-only. |
| `timeout_sec` | `float` | `10.0` | Total deadline per HTTP request. Keyword-only. |
| `shutdown_timeout_sec` | `float` | `5.0` | `shutdown()` flushes for at most this long; leftovers are dropped as `shutdown`. Keyword-only. |
| `connection_idle_timeout_sec` | `float` | `3600.0` | A connection opened through a helper that sees no frames for this long is reported closed (`ABNORMAL_CLOSURE`, `closedBy: "sdk_idle_timeout"`) and forgotten. Connections still open at `shutdown()` are reported closed (`GOING_AWAY`, `closedBy: "sdk_shutdown"`). Keyword-only; negative raises `ValueError`. |
| `allow_insecure_http` | `bool` | `False` | Allow plain `http://` to a host other than localhost. Keyword-only. |
| `http_transport`, `transport_options` | | `None` | An `httpx` transport / extra transport-core settings, for tests and unusual networks. Keyword-only. |

Exports: `AforoWsBilling`, `track_websockets_connection(billing, ws, customer_id=..., *, customer_resolver=None, trust_customer_header=False)`, `track_starlette_websocket(...)` (same arguments), `WS_CLOSE_REASONS`. Each tracker helper returns an async context manager.

Execution status (`executionStatus`, used by OUTCOME_BASED pricing) is described in the [README](README.md#execution-status-executionstatus).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A route emits no events | The connection wasn't wrapped in `track_*`, or `customer_id` was falsy. | Wrap the connection in the `async with` block and resolve `customer_id` first. |
| Close event missing / counts are zero | The `async with` block never exited cleanly, or the handler returned before entering it. | Ensure the block wraps the whole message loop; counts finalize on exit. |
| ERROR log "Ingestor answered HTTP 401" (or 403) | Bad or revoked API key. The events stay queued (up to `max_queue_size`) and are retried after a pause. | Fix `api_key` and restart; confirm it matches `tenant_id`. |
| `billing.dropped_count` is above 0 | Events were dropped: `invalid` (failed a client-side check, or no customer), `rejected` (ingestor refused them), `overflow` (queue full during an outage), `shutdown` (still queued at the shutdown deadline) or `closed` (sent after shutdown). An ingest outage alone does not drop events. | Read the WARNING log line for the reason; see [Dropped events](README.md#dropped-events). |
| Events sent, none in console | Wrong `ingestor_url` host, or the metric isn't mapped to a rate plan. | Use `https://api.aforo.ai`; map `websocket_api.connection_closed` (and `websocket_api.connection_opened` / `.message` if you bill those) in Aforo. |
| Event volume far higher than expected | `per_frame_events=True` emits one event per frame. | Switch back to default open+close unless you price per frame. |
| `wsCloseReason` is `INTERNAL_ERROR` | An exception was raised inside the handler before a clean close. | Expected — fix the handler error; the close is still recorded. |

## What this guide does NOT cover

Client-side WebSocket metering (this is server-side). Sub-protocols or binary-frame decoding beyond byte counts. Enforcing connection limits or closing idle sockets — the SDK only emits events. Pricing and metric mapping are in the Aforo console. For MQTT pub/sub, see `aforo-mqtt-metering`.
