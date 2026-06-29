# aforo-ws-metering

Aforo WebSocket Metering SDK for Python. Works with the `websockets` library, FastAPI/Starlette `WebSocket` routes, and any async framework that exposes the standard message/send surface.

## Install

```bash
pip install aforo-ws-metering                     # core
pip install aforo-ws-metering[websockets]         # `websockets` library
pip install aforo-ws-metering[fastapi]            # FastAPI / Starlette
pip install aforo-ws-metering[httpx]              # faster HTTP flush
```

## Usage — `websockets` library

```python
import asyncio
import websockets
from aforo_ws_metering import AforoWsBilling, track_websockets_connection

billing = AforoWsBilling(
    tenant_id="tenant_acme",
    product_id="prod_ws_market_feed",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://ingestor.aforo.ai",
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

## Usage — FastAPI / Starlette

```python
from fastapi import FastAPI, WebSocket
from aforo_ws_metering import AforoWsBilling, track_starlette_websocket

billing = AforoWsBilling(...)
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

## Billing strategy

Default: one `CONNECTION_OPENED` + one `CONNECTION_CLOSED` event per connection, with aggregated `messageCount` (sent + received), `dataBytes`, and `durationMs` on close.

For per-frame events (one event per inbound/outbound frame):

```python
billing = AforoWsBilling(..., per_frame_events=True)
```

## Close-reason mapping

Standard WebSocket close codes (1000–1011) map to the descriptor enum (`NORMAL_CLOSURE`, `ABNORMAL_CLOSURE`, `POLICY_VIOLATION`, ...). Exceptions inside the handler surface as `INTERNAL_ERROR`.

## Batching & retry

100 events / 3 seconds. 3× exponential retry (1s/2s/4s), then `on_error`. Call `billing.shutdown()` at shutdown.

## License

MIT
