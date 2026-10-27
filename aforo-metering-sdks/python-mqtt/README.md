# aforo-mqtt-metering

Meter MQTT client traffic — PUBLISH, SUBSCRIBE, UNSUBSCRIBE, CONNECT, DISCONNECT — by wrapping a `paho-mqtt` (sync) or `aiomqtt` (async) client. Use it when you connect to a third-party broker (AWS IoT, HiveMQ Cloud, EMQ X Cloud) and want to meter what your client sends and receives.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

> For **broker-side** (server-level) metering, use the companion EMQ X Erlang plugin in `aforo-nextgen-docker/emqx-plugin-aforo-metering/`. This Python SDK is **client-side**.

## Install

Intended public install:

```bash
pip install aforo-mqtt-metering              # core
pip install "aforo-mqtt-metering[paho]"      # paho-mqtt (sync)
pip install "aforo-mqtt-metering[aiomqtt]"   # aiomqtt (async)
pip install "aforo-mqtt-metering[httpx]"     # faster HTTP flush than stdlib urllib
```

**Install `2.0.0` or later. `1.0.0` on PyPI was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on PyPI yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/python-mqtt     # folder holding setup.py
pip install -e .
pip install -e ".[paho]"               # or [aiomqtt] / [httpx]
```

The core package has **no required dependencies** — the MQTT client libraries and HTTP client are optional extras.

## Quickstart — paho-mqtt (sync)

Best when you publish/subscribe from a device or service against a managed broker and want per-event billing without rewriting your MQTT code.

```python
import os
import paho.mqtt.client as mqtt
from aforo_mqtt_metering import AforoMqttBilling, wrap_paho_client

billing = AforoMqttBilling(
    tenant_id="tenant_acme",
    product_id="prod_mqtt_iot_telemetry",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://api.aforo.ai",
)

client = mqtt.Client(client_id="device-001")
wrap_paho_client(billing, client, customer_id="cust_acme_001")

client.tls_set()
client.connect("broker.example.com", 8883)
client.subscribe("sensors/+/temperature")
client.publish("devices/001/status", '{"online": true}')
client.loop_forever()
```

## Quickstart — aiomqtt (async)

```python
import aiomqtt
from aforo_mqtt_metering import AforoMqttBilling, wrap_aiomqtt_client

billing = AforoMqttBilling(
    tenant_id="tenant_acme",
    product_id="prod_mqtt_iot_telemetry",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://api.aforo.ai",
)

async def main():
    async with aiomqtt.Client("broker.example.com", port=8883, tls_context=ssl_ctx) as c:
        wrap_aiomqtt_client(billing, c, customer_id="cust_acme_001", client_id="device-001")
        await c.subscribe("sensors/+/temperature")
        await c.publish("devices/001/status", '{"online": true}')
        async for msg in c.messages:
            print(msg.topic, msg.payload)
```

Each metered event POSTs to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`, carrying `mqttEventType`, `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttClientId`, and `dataBytes`.

> ⚠ Events are sent to the ingestor's **`/v1/ingest/batch`** path as `{"events": [...]}`, at most 1000 events per request (larger buffers are split). Set `ingestor_url` to the host only — the SDK appends the path.

> **The customer comes from your own mapping.** Pass `customer_id` when you wrap the client, from your trusted device/account mapping, or `customer_resolver=callable(client)`. Billing the connection's MQTT username needs `trust_customer_header=True` — whoever configures the connection sets it. With none of the three, the wrapper raises `ValueError`. `tenant_id` is fixed from config and sent as a header.
>
> **What is billed:** CONNECT when the broker accepts the connection; DISCONNECT when you disconnect, or `reconnect_debounce_sec` (default 30 s) after a dropped connection that did not come back — a drop followed by a reconnect inside that window is one session, so network flaps do not create billable CONNECT/DISCONNECT pairs. PUBLISH is billed after paho confirms it (`on_publish`: the broker's ack for QoS 1/2, the socket write for QoS 0); a publish paho refuses is not billed. With aiomqtt, PUBLISH is billed after `publish()` returns.

## Configuration

Constructor arguments for `AforoMqttBilling(...)`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | Product the events bill against. |
| `api_key` | `str` | — (required) | Aforo API key, sent to the ingestor as `X-API-Key`. |
| `ingestor_url` | `str` | — (required) | Host; `/v1/ingest/batch` is appended. |
| `flush_interval_sec` | `float` | `2.0` | Background flush cadence — tightest of the SDKs, since MQTT is high-volume. |
| `flush_count` | `int` | `500` | Events per request, and the queue size that wakes the sender early (at most 1000). |
| `emit_deliver_events` | `bool` | `False` | Emit a `DELIVER` event for each inbound `on_message` (off by default). |
| `on_error` | `Callable[[Exception], None]?` | logs | Receives a `TransportError`; branch on `.kind`: `outage` / `auth` (events still queued and retried), `rejected` (the ingestor refused them; message carries its `errors[].message`), `shutdown`, `closed`. `.events` and `.status` say which events and which HTTP status. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with events that will not be delivered and the reason (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). See [Dropped events](#dropped-events). Pass by keyword. |
| `product_type` | `str` | `"MQTT_BROKER"` | Top-level `productType` sent on every event (trimmed and upper-cased; values the SDK does not know are passed through). Override per event with `push(..., product_type=...)` or `product_type=` on `wrap_paho_client` / `wrap_aiomqtt_client`. |
| `max_queue_size` | `int` | `10000` | Queue capacity; the oldest event is dropped as `overflow` when full. Keyword-only. |
| `timeout_sec` | `float` | `10.0` | Total deadline per HTTP request. Keyword-only. |
| `shutdown_timeout_sec` | `float` | `5.0` | `shutdown()` flushes for at most this long; leftovers are dropped as `shutdown`. Keyword-only. |
| `allow_insecure_http` | `bool` | `False` | Allow plain `http://` to a host other than localhost. Keyword-only. |
| `http_transport`, `transport_options` | | `None` | An `httpx` transport / extra transport-core settings, for tests and unusual networks. Keyword-only. |

Event metric names follow `mqtt_broker.<event_type lowercased>` (e.g. `mqtt_broker.publish`, `mqtt_broker.subscribe`). Delivery uses the shared transport core: `push()`/`record()` only queue (bounded by `max_queue_size`, default 10 000; the oldest event is dropped as `overflow` when full) and one background thread sends batches of up to `flush_count` events (default 500, at most 1000; a body over 4 MiB is split). Network errors, timeouts, 408, 429 and 5xx are retried 3 times with full-jitter backoff; `Retry-After` is honoured as seconds or an HTTP date, capped at 60 s. After that, or on 401/403 (logged at ERROR: the API key is wrong or revoked), the batch goes back to the front of the queue with the same idempotency keys and the sender pauses (full jitter, at most 5 s at first and at least 250 ms, growing to 5 min) — an outage loses nothing unless the queue fills. A redirect (3xx) is never followed, so the API key cannot reach another host; it is treated like 401/403 and logged at ERROR with the target host. Events the ingestor marks `retryable` in a 2xx are re-sent with the same keys after the same backoff, at most 3 times. Each request's `timeout_sec` covers the whole exchange, including reading the response. `flush()` during an outage makes one attempt. `shutdown()` keeps retrying until its deadline. An event that cannot be turned into JSON is dropped as `invalid` when you push it. A 413 splits the batch; any other 4xx drops it with reason `rejected`. `shutdown()` (also run at interpreter exit) flushes for at most `shutdown_timeout_sec` (default 5 s). `ingestor_url` must be `https://`; plain `http://` only for localhost / 127.0.0.1 / ::1 or with `allow_insecure_http=True`. The API key is sent only as `X-API-Key` and never appears in `repr()` or logs.

## Execution status (`executionStatus`)

Events can carry an execution status. OUTCOME_BASED rate plans bill each event at the weight set for its status; events without one bill at full price.

The client wrappers don't set one: they emit each event before the broker answers, so the SDK has no outcome to report. Send your own with `push()`:

```python
billing.push(customer_id="cust_acme_001", topic="devices/001/status", qos=1, retained=False,
             event_type="PUBLISH", client_id="device-001", execution_status="FAILED")
```

The SDK trims and upper-cases the value and leaves it off the event when it's blank. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED` — any other value is logged as a warning and left off the event, since the ingestor would reject the event.

## Dropped events

An event that will never reach Aforo is counted in `billing.dropped_count`, logged at WARNING, and passed to the opt-in `on_drop(events, reason)` hook. The events keep their idempotency keys, so sending them again later cannot double-bill.

| Reason | When |
|---|---|
| `invalid` | The event failed a client-side check (a blank `customer_id` or one longer than 64 characters, an unsupported `event_type`, or a missing topic on anything other than CONNECT / DISCONNECT). It is not buffered or sent. `push()` does not raise for event content. An over-long topic or client id does not drop the event: both come from the MQTT traffic, so a topic over 500 characters or a client id over 128 is truncated to the limit and the event is sent (one WARNING per field per client). |
| `rejected` | The ingestor answered 4xx (other than 408 / 429) for the batch, or refused individual events inside a 202 response. |
| `overflow` | The queue was full (usually a long ingest outage); the oldest event was evicted. |
| `shutdown` | Still queued when `shutdown()` reached `shutdown_timeout_sec`. |
| `closed` | Sent after `shutdown()`. |

```python
def on_drop(events, reason):
    dead_letter.write(reason, events)

billing = AforoMqttBilling(..., on_drop=on_drop)
```

When a 202 response reports refused events without a usable `index`, they are counted in `dropped_count` but not passed to the hook, since the SDK cannot tell which events they were. Exceptions raised by the hook are swallowed. An unknown `executionStatus` is not a drop: the field is left off and the event is still sent.

## Walk me through it

Install → wrap the client → publish/subscribe → confirm the event in Aforo, step by step, is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

Inbound message delivery is **not** billed unless you set `emit_deliver_events=True` — it's off by default to keep volume down. This is client-side metering only; for broker-wide accounting (every client on the broker) use the EMQ X plugin. It doesn't enforce QoS limits or topic ACLs. Pricing, and QoS/retained tiering via filter conditions, are configured in the Aforo console.
