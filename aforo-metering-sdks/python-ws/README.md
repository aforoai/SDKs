# aforo-ws-metering

Meter WebSocket traffic — connection duration, message counts, and bytes — by wrapping a connection from the `websockets` library or a FastAPI/Starlette `WebSocket` route. One open + one close event per connection by default, or one event per frame.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-ws-metering                 # core
pip install "aforo-ws-metering[websockets]"   # `websockets` library
pip install "aforo-ws-metering[fastapi]"      # FastAPI / Starlette
pip install "aforo-ws-metering[httpx]"        # faster HTTP flush than stdlib urllib
```

**Not yet on PyPI — install from source for now:**

```bash
git clone https://github.com/aforoai/aforo-metering-sdks.git
cd aforo-metering-sdks/python-ws     # folder holding setup.py
pip install -e .
pip install -e ".[fastapi]"          # or [websockets] / [httpx]
```

The core package has **no required dependencies** — the integration libraries and HTTP client are optional extras.

## Quickstart — `websockets` library

Best when you serve raw WebSocket connections and want connection-level billing without rewriting the handler.

```python
import os, asyncio, websockets
from aforo_ws_metering import AforoWsBilling, track_websockets_connection

billing = AforoWsBilling(
    tenant_id="tenant_acme",
    product_id="prod_ws_market_feed",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://ingest.aforo.ai",
)

async def handler(ws):
    customer_id = dict(ws.request_headers).get("x-customer-id")
    if not customer_id:
        await ws.close(code=4401); return
    async with await track_websockets_connection(billing, ws, customer_id):
        async for msg in ws:
            await ws.send(f"echo: {msg}")

async def main():
    async with websockets.serve(handler, "0.0.0.0", 8765):
        await asyncio.Future()  # run forever

asyncio.run(main())
```

## Quickstart — FastAPI / Starlette

```python
from fastapi import FastAPI, WebSocket
from aforo_ws_metering import AforoWsBilling, track_starlette_websocket

billing = AforoWsBilling(
    tenant_id="tenant_acme",
    product_id="prod_ws_market_feed",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://ingest.aforo.ai",
)
app = FastAPI()

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

Events POST to `https://ingest.aforo.ai/v1/ingest/events` with `Authorization: Bearer <api_key>` and `X-Tenant-Id: <tenant_id>`. The tracker counts sent/received messages and bytes by wrapping the connection's `send`/`recv`, and emits a close event with `messageCount`, `dataBytes`, and `durationMs` when the `async with` block exits.

> ⚠ This package targets the ingestor's **`/v1/ingest/events`** path (the base and MCP Aforo SDKs use `/v1/ingest/batch`). Set `ingestor_url` to the host only — the SDK appends the path.

> `customer_id` is resolved by **your** handler (the examples read `x-customer-id`) and passed into the tracker — read it from a header your gateway sets, not a value the client can spoof. The tracker doesn't meter a connection you don't wrap.

## Configuration

Constructor arguments for `AforoWsBilling(...)`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | Product the connections bill against. |
| `api_key` | `str` | — (required) | Bearer token for the ingestor. |
| `ingestor_url` | `str` | — (required) | Host; `/v1/ingest/events` is appended. |
| `flush_interval_sec` | `float` | `3.0` | Background flush cadence (daemon thread from construction). |
| `flush_count` | `int` | `100` | Buffer size that triggers an immediate flush. |
| `per_frame_events` | `bool` | `False` | Emit one event per inbound/outbound frame instead of open+close. |
| `on_error` | `Callable[[Exception], None]?` | logs | Called on permanent batch failure. |

Close-code mapping: `WS_CLOSE_REASONS` maps standard close codes (1000–1011) to descriptor labels (`NORMAL_CLOSURE`, `ABNORMAL_CLOSURE`, `POLICY_VIOLATION`, …); an exception inside the handler surfaces as `INTERNAL_ERROR`. Retry is fixed at **3 attempts** (`1s / 2s / 4s`); 4xx is non-retryable.

## Walk me through it

Install → wrap a connection → push frames → confirm the event in Aforo, step by step, is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

The tracker meters connections **you wrap** — an unwrapped route emits nothing. Default mode is open+close (aggregated counts); `per_frame_events=True` is much higher volume, so price for it. It doesn't enforce connection limits or close idle sockets. Pricing and metric mapping are in the Aforo console. For broker fan-out (MQTT) use `aforo-mqtt-metering`.
