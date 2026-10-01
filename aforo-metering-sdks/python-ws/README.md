# aforo-ws-metering

Meter WebSocket traffic — connection duration, message counts, and bytes — by wrapping a connection from the `websockets` library or a FastAPI/Starlette `WebSocket` route. One open + one close event per connection by default, or one event per frame.

**Version:** 1.2.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-ws-metering                 # core
pip install "aforo-ws-metering[websockets]"   # `websockets` library
pip install "aforo-ws-metering[fastapi]"      # FastAPI / Starlette
pip install "aforo-ws-metering[httpx]"        # faster HTTP flush than stdlib urllib
```

**Install `1.2.2` or later. `1.0.0` on PyPI was built from an older copy of this code and lacks the fixes listed in the changelog.** If `1.2.2` is not on PyPI yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/python-ws     # folder holding setup.py
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
    ingestor_url="https://api.aforo.ai",
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
    ingestor_url="https://api.aforo.ai",
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

Events POST to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`. The tracker counts sent/received messages and bytes by wrapping the connection's `send`/`recv`, and emits a close event with `messageCount`, `dataBytes`, and `executionDurationMs` when the `async with` block exits.

> ⚠ Events are sent to the ingestor's **`/v1/ingest/batch`** path as `{"events": [...]}`, at most 1000 events per request (larger buffers are split). Set `ingestor_url` to the host only — the SDK appends the path.

> `customer_id` is resolved by **your** handler (the examples read `x-customer-id`) and passed into the tracker — read it from a header your gateway sets, not a value the client can spoof. The tracker doesn't meter a connection you don't wrap.

## Configuration

Constructor arguments for `AforoWsBilling(...)`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | Product the connections bill against. |
| `api_key` | `str` | — (required) | Aforo API key, sent to the ingestor as `X-API-Key`. |
| `ingestor_url` | `str` | — (required) | Host; `/v1/ingest/batch` is appended. |
| `flush_interval_sec` | `float` | `3.0` | Background flush cadence (daemon thread from construction). |
| `flush_count` | `int` | `100` | Buffer size that triggers an immediate flush. |
| `per_frame_events` | `bool` | `False` | Emit one event per inbound/outbound frame instead of open+close. |
| `on_error` | `Callable[[Exception], None]?` | logs | Called on permanent batch failure, and with the ingestor's `errors[].message` when it rejects events. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with events that will not be delivered and the reason (`invalid`, `rejected`, `retry_exhausted`). See [Dropped events](#dropped-events). Pass by keyword. |
| `product_type` | `str` | `"WEBSOCKET_API"` | Top-level `productType` sent on every event (trimmed and upper-cased; values the SDK does not know are passed through). Override per event with a `productType` key in `push({...})` or `product_type=` on `track_websockets_connection` / `track_starlette_websocket`. |

Close-code mapping: `WS_CLOSE_REASONS` maps standard close codes (1000–1011) to descriptor labels (`NORMAL_CLOSURE`, `ABNORMAL_CLOSURE`, `POLICY_VIOLATION`, …); an exception inside the handler surfaces as `INTERNAL_ERROR`. Retry is fixed at **3 attempts** (`1s / 2s` backoff between them); 408 and 5xx are retried, 429 waits for `Retry-After` (capped at 60 s), and any other 4xx is not retried and the batch is dropped with reason `rejected`.

## Execution status (`executionStatus`)

Each event can carry an execution status. OUTCOME_BASED rate plans bill each event at the weight set for its status; events without one bill at full price.

The SDK doesn't derive one: an event carries a status only when you set it. With the connection helpers, the value you set goes on the `CONNECTION_CLOSED` event; a close with or without an exception sends no status otherwise. Frame events and `CONNECTION_OPENED` carry no status.

To send your own value:

```python
async with await track_websockets_connection(billing, ws, customer_id,
                                             execution_status="PARTIAL") as t:
    ...
    t.execution_status = "TIMEOUT"   # or change it inside the block

billing.push({"customerId": "cust_42", "wsConnectionId": conn_id, "wsFrameType": "TEXT"},
             execution_status="SUCCESS")
```

`execution_status` is keyword-only (`push()` also reads an `executionStatus` key in the dict when the keyword isn't given). The SDK trims and upper-cases it and leaves it off the event when it's blank. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED` — any other value is logged as a warning and left off the event, since the ingestor would reject the event.

## Dropped events

An event that will never reach Aforo is counted in `billing.dropped_count`, logged at WARNING, and passed to the opt-in `on_drop(events, reason)` hook. The events keep their idempotency keys, so sending them again later cannot double-bill.

| Reason | When |
|---|---|
| `invalid` | The event failed a client-side check (a blank `customerId`, one longer than 64 characters, or no `wsConnectionId`). It is not buffered or sent. `push()` does not raise for event content. |
| `rejected` | The ingestor answered 4xx (other than 408 / 429) for the batch, or refused individual events inside a 202 response. |
| `retry_exhausted` | Network errors, 5xx, 408 or 429 on all 3 attempts. |

```python
def on_drop(events, reason):
    dead_letter.write(reason, events)

billing = AforoWsBilling(..., on_drop=on_drop)
```

When a 202 response reports refused events without a usable `index`, they are counted in `dropped_count` but not passed to the hook, since the SDK cannot tell which events they were. Exceptions raised by the hook are swallowed. An unknown `executionStatus` is not a drop: the field is left off and the event is still sent.

## Walk me through it

Install → wrap a connection → push frames → confirm the event in Aforo, step by step, is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

The tracker meters connections **you wrap** — an unwrapped route emits nothing. Default mode is open+close (aggregated counts); `per_frame_events=True` is much higher volume, so price for it. It doesn't enforce connection limits or close idle sockets. Pricing and metric mapping are in the Aforo console. For broker fan-out (MQTT) use `aforo-mqtt-metering`.
