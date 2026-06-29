# aforo-ws-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Python engineers serving WebSocket connections who need connection- or frame-level billing.

## What you'll build

A WebSocket server that reports usage to Aforo — by default one connection-open and one connection-close event per socket, with aggregated message counts, bytes, and duration on close. Works with the `websockets` library or FastAPI/Starlette routes. You'll finish by confirming a real connection's events reached the Aforo ingestor.

## Prerequisites

- Python **3.9+**.
- An Aforo **API key**, **tenant id**, and **product id** from the Aforo console.
- A WebSocket server: the `websockets` library, or FastAPI/Starlette.
- A header your gateway/auth sets so the handler can resolve `customer_id` (the examples use `x-customer-id`).

## Step 1 — Install

```bash
pip install -e .                  # from python-ws/ (not yet on PyPI)
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
    ingestor_url="https://ingest.aforo.ai",
)
```

All four arguments are required — the constructor raises `ValueError` if any is empty.

> ⚠ `ingestor_url` is the **host**; this package appends `/v1/ingest/events`. Pass `https://ingest.aforo.ai`.

## Step 3 — Resolve the customer, then wrap the connection

The tracker meters a connection only while it's wrapped in the `async with` block. Resolve `customer_id` first; reject the socket if you can't:

**`websockets` library:**

```python
from aforo_ws_metering import track_websockets_connection

async def handler(ws):
    customer_id = dict(ws.request_headers).get("x-customer-id")
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
    customer_id = ws.headers.get("x-customer-id")
    if not customer_id:
        await ws.close(code=4401); return
    async with await track_starlette_websocket(billing, ws, customer_id):
        while True:
            data = await ws.receive_text()
            await ws.send_text(f"echo: {data}")
```

> ⚠ The tracker wraps the connection's `send`/`recv` to count traffic. Resolve `customer_id` from a header your gateway controls — don't bill against a value the client can set freely. An unwrapped route emits nothing.

## Step 4 — Drive some frames and let the connection close

Send and receive normally inside the block. When the `async with` exits — clean close, client disconnect, or an exception — the tracker emits the close event with `messageCount` (sent + received), `dataBytes`, `durationMs`, and a `wsCloseReason` label.

## Step 5 — Verify it landed in Aforo

In the Aforo console, open the usage/events view for your tenant and filter by `metric_name = websocket_api.connection_closed` (and `websocket_api.message` if you enabled per-frame). You should see the close event carrying the aggregated counts and the mapped close reason. If nothing appears, check the `ingestor_url` host and that the connection was actually wrapped — see Troubleshooting.

## Step 6 — Per-frame billing (optional, high volume)

For one event per inbound/outbound frame instead of open+close:

```python
billing = AforoWsBilling(..., per_frame_events=True)
```

> ⚠ A busy socket can emit thousands of frames a second — `per_frame_events=True` multiplies your event volume accordingly. The buffer (100 events / 3 s) is sized for this, but make sure your rate plan and ingest budget expect it.

## Step 7 — Shut down cleanly

```python
billing.shutdown()   # flushes the final batch before process exit
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | required | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | required | Product the connections bill against. |
| `api_key` | `str` | required | Bearer token. |
| `ingestor_url` | `str` | required | Host; `/v1/ingest/events` appended. |
| `flush_interval_sec` | `float` | `3.0` | Background flush cadence. |
| `flush_count` | `int` | `100` | Buffer size that forces a flush. |
| `per_frame_events` | `bool` | `False` | One event per frame vs. open + close. |
| `on_error` | `Callable?` | logs | Called on permanent batch failure. |

Exports: `AforoWsBilling`, `track_websockets_connection(billing, ws, customer_id)`, `track_starlette_websocket(billing, ws, customer_id)`, `WS_CLOSE_REASONS`. Each tracker helper returns an async context manager.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A route emits no events | The connection wasn't wrapped in `track_*`, or `customer_id` was falsy. | Wrap the connection in the `async with` block and resolve `customer_id` first. |
| Close event missing / counts are zero | The `async with` block never exited cleanly, or the handler returned before entering it. | Ensure the block wraps the whole message loop; counts finalize on exit. |
| `on_error` fires with "Aforo returned 401/403" | Bad/unscoped API key — 4xx is dropped, not retried. | Fix `api_key`; confirm it matches `tenant_id`. |
| Events sent, none in console | Wrong `ingestor_url` host, or the metric isn't mapped to a rate plan. | Use `https://ingest.aforo.ai`; map `websocket_api.connection_closed` (and `.message`) in Aforo. |
| Event volume far higher than expected | `per_frame_events=True` emits one event per frame. | Switch back to default open+close unless you price per frame. |
| `wsCloseReason` is `INTERNAL_ERROR` | An exception was raised inside the handler before a clean close. | Expected — fix the handler error; the close is still recorded. |

## What this guide does NOT cover

Client-side WebSocket metering (this is server-side). Sub-protocols or binary-frame decoding beyond byte counts. Enforcing connection limits or closing idle sockets — the SDK only emits events. Pricing and metric mapping are in the Aforo console. For MQTT pub/sub, see `aforo-mqtt-metering`.
