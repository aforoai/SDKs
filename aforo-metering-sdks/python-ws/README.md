# aforo-ws-metering

Meter WebSocket traffic — connection duration, message counts, and bytes — by wrapping a connection from the `websockets` library or a FastAPI/Starlette `WebSocket` route. One open + one close event per connection by default, or one event per frame.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-ws-metering                 # core
pip install "aforo-ws-metering[websockets]"   # `websockets` library
pip install "aforo-ws-metering[fastapi]"      # FastAPI / Starlette
pip install "aforo-ws-metering[httpx]"        # faster HTTP flush than stdlib urllib
```

**Install `2.0.0` or later. `1.0.0` on PyPI was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on PyPI yet, install from source:

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
    customer_id = customer_for_token(ws.request.headers.get("Authorization"))  # your verified auth
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
    customer_id = customer_for_token(ws.headers.get("authorization"))  # your verified auth
    if not customer_id:
        await ws.close(code=4401); return
    async with await track_starlette_websocket(billing, ws, customer_id):
        while True:
            data = await ws.receive_text()
            await ws.send_text(f"echo: {data}")
```

Events POST to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`. The tracker counts sent/received messages and bytes by wrapping the connection's `send`/`recv`, and emits a close event with `messageCount`, `dataBytes`, and `executionDurationMs` when the `async with` block exits.

> ⚠ Events are sent to the ingestor's **`/v1/ingest/batch`** path as `{"events": [...]}`, at most 1000 events per request (larger buffers are split). Set `ingestor_url` to the host only — the SDK appends the path.

> **The customer comes from your own auth.** Pass the `customer_id` your handler resolved from verified identity, or `customer_resolver=callable(websocket)`. Reading the `x-customer-id` handshake header needs `trust_customer_header=True` — the client sets that header, so use it only behind a gateway that overwrites it. With none of the three, the helper raises `ValueError`. If the customer resolves to nothing, the connection still works and its events are counted as `invalid` drops. The tracker doesn't meter a connection you don't wrap.

## Configuration

Constructor arguments for `AforoWsBilling(...)`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | Product the connections bill against. |
| `api_key` | `str` | — (required) | Aforo API key, sent to the ingestor as `X-API-Key`. |
| `ingestor_url` | `str` | — (required) | Host; `/v1/ingest/batch` is appended. |
| `flush_interval_sec` | `float` | `3.0` | Background flush cadence (daemon thread from construction). |
| `flush_count` | `int` | `500` | Events per request, and the queue size that wakes the sender early (at most 1000). |
| `per_frame_events` | `bool` | `False` | Emit one event per inbound/outbound frame instead of open+close. |
| `on_error` | `Callable[[Exception], None]?` | logs | Receives a `TransportError`; branch on `.kind`: `outage` / `auth` (events still queued and retried), `rejected` (the ingestor refused them; message carries its `errors[].message`), `shutdown`, `closed`. `.events` and `.status` say which events and which HTTP status. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with events that will not be delivered and the reason (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). See [Dropped events](#dropped-events). Pass by keyword. |
| `product_type` | `str` | `"WEBSOCKET_API"` | Top-level `productType` sent on every event (trimmed and upper-cased; values the SDK does not know are passed through). Override per event with a `productType` key in `push({...})` or `product_type=` on `track_websockets_connection` / `track_starlette_websocket`. |
| `max_queue_size` | `int` | `10000` | Queue capacity; the oldest event is dropped as `overflow` when full. Keyword-only. |
| `timeout_sec` | `float` | `10.0` | Total deadline per HTTP request. Keyword-only. |
| `shutdown_timeout_sec` | `float` | `5.0` | `shutdown()` flushes for at most this long; leftovers are dropped as `shutdown`. Keyword-only. |
| `connection_idle_timeout_sec` | `float` | `3600.0` | A connection opened through a helper that sees no frames for this long is reported closed (`ABNORMAL_CLOSURE`, `closedBy: "sdk_idle_timeout"`) and forgotten. Connections still open at `shutdown()` are reported closed (`GOING_AWAY`, `closedBy: "sdk_shutdown"`). Keyword-only; negative raises `ValueError`. |
| `allow_insecure_http` | `bool` | `False` | Allow plain `http://` to a host other than localhost. Keyword-only. |
| `http_transport`, `transport_options` | | `None` | An `httpx` transport / extra transport-core settings, for tests and unusual networks. Keyword-only. |

Close-code mapping: `WS_CLOSE_REASONS` maps standard close codes (1000–1011) to descriptor labels (`NORMAL_CLOSURE`, `ABNORMAL_CLOSURE`, `POLICY_VIOLATION`, …); an exception inside the handler surfaces as `INTERNAL_ERROR`. Delivery uses the shared transport core: `push()`/`record()` only queue (bounded by `max_queue_size`, default 10 000; the oldest event is dropped as `overflow` when full) and one background thread sends batches of up to `flush_count` events (default 500, at most 1000; a body over 4 MiB is split). Network errors, timeouts, 408, 429 and 5xx are retried 3 times with full-jitter backoff; `Retry-After` is honoured as seconds or an HTTP date, capped at 60 s. After that, or on 401/403 (logged at ERROR: the API key is wrong or revoked), the batch goes back to the front of the queue with the same idempotency keys and the sender pauses (full jitter, at most 5 s at first and at least 250 ms, growing to 5 min) — an outage loses nothing unless the queue fills. A redirect (3xx) is never followed, so the API key cannot reach another host; it is treated like 401/403 and logged at ERROR with the target host. Events the ingestor marks `retryable` in a 2xx are re-sent with the same keys after the same backoff, at most 3 times. Each request's `timeout_sec` covers the whole exchange, including reading the response. `flush()` during an outage makes one attempt. `shutdown()` keeps retrying until its deadline. An event that cannot be turned into JSON is dropped as `invalid` when you push it. A 413 splits the batch; any other 4xx drops it with reason `rejected`. `shutdown()` (also run at interpreter exit) flushes for at most `shutdown_timeout_sec` (default 5 s). `ingestor_url` must be `https://`; plain `http://` only for localhost / 127.0.0.1 / ::1 or with `allow_insecure_http=True`. The API key is sent only as `X-API-Key` and never appears in `repr()` or logs.

## Execution status (`executionStatus`)

Each event can carry an execution status. OUTCOME_BASED rate plans bill each event at the weight set for its status; events without one bill at full price.

The SDK doesn't derive one: an event carries a status only when you set it. With the connection helpers, the value you set goes on the `CONNECTION_CLOSED` event; a close with or without an exception sends no status otherwise. Frame events and `CONNECTION_OPENED` (frame type `OPEN`, metric `websocket_api.connection_opened`) carry no status.

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
| `overflow` | The queue was full (usually a long ingest outage); the oldest event was evicted. |
| `shutdown` | Still queued when `shutdown()` reached `shutdown_timeout_sec`. |
| `closed` | Sent after `shutdown()`. |

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
