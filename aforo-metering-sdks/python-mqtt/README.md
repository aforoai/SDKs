# aforo-mqtt-metering

Meter MQTT client traffic — PUBLISH, SUBSCRIBE, UNSUBSCRIBE, CONNECT, DISCONNECT — by wrapping a `paho-mqtt` (sync) or `aiomqtt` (async) client. Use it when you connect to a third-party broker (AWS IoT, HiveMQ Cloud, EMQ X Cloud) and want to meter what your client sends and receives.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

> For **broker-side** (server-level) metering, use the companion EMQ X Erlang plugin in `aforo-nextgen-docker/emqx-plugin-aforo-metering/`. This Python SDK is **client-side**.

## Install

Intended public install:

```bash
pip install aforo-mqtt-metering              # core
pip install "aforo-mqtt-metering[paho]"      # paho-mqtt (sync)
pip install "aforo-mqtt-metering[aiomqtt]"   # aiomqtt (async)
pip install "aforo-mqtt-metering[httpx]"     # faster HTTP flush than stdlib urllib
```

**Not yet on PyPI — install from source for now:**

```bash
git clone https://github.com/aforoai/aforo-metering-sdks.git
cd aforo-metering-sdks/python-mqtt     # folder holding setup.py
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
    ingestor_url="https://ingest.aforo.ai",
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
    ingestor_url="https://ingest.aforo.ai",
)

async def main():
    async with aiomqtt.Client("broker.example.com", port=8883, tls_context=ssl_ctx) as c:
        wrap_aiomqtt_client(billing, c, customer_id="cust_acme_001", client_id="device-001")
        await c.subscribe("sensors/+/temperature")
        await c.publish("devices/001/status", '{"online": true}')
        async for msg in c.messages:
            print(msg.topic, msg.payload)
```

Each metered event POSTs to `https://ingest.aforo.ai/v1/ingest/events` with `Authorization: Bearer <api_key>` and `X-Tenant-Id: <tenant_id>`, carrying `mqttEventType`, `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttClientId`, and `dataBytes`.

> ⚠ This package targets the ingestor's **`/v1/ingest/events`** path (the base and MCP Aforo SDKs use `/v1/ingest/batch`). Set `ingestor_url` to the host only — the SDK appends the path.

> `customer_id` is passed in when you wrap the client — supply it from your trusted device/account mapping, not from anything the broker peer controls. `tenant_id` is fixed from config and sent as a header.

## Configuration

Constructor arguments for `AforoMqttBilling(...)`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | Product the events bill against. |
| `api_key` | `str` | — (required) | Bearer token for the ingestor. |
| `ingestor_url` | `str` | — (required) | Host; `/v1/ingest/events` is appended. |
| `flush_interval_sec` | `float` | `2.0` | Background flush cadence — tightest of the SDKs, since MQTT is high-volume. |
| `flush_count` | `int` | `200` | Buffer size that triggers an immediate flush. |
| `emit_deliver_events` | `bool` | `False` | Emit a `DELIVER` event for each inbound `on_message` (off by default). |
| `on_error` | `Callable[[Exception], None]?` | logs | Called on permanent batch failure. |

Event metric names follow `mqtt_broker.<event_type lowercased>` (e.g. `mqtt_broker.publish`, `mqtt_broker.subscribe`). Retry is fixed at **3 attempts** (`1s / 2s / 4s`); 4xx is non-retryable.

## Walk me through it

Install → wrap the client → publish/subscribe → confirm the event in Aforo, step by step, is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

Inbound message delivery is **not** billed unless you set `emit_deliver_events=True` — it's off by default to keep volume down. This is client-side metering only; for broker-wide accounting (every client on the broker) use the EMQ X plugin. It doesn't enforce QoS limits or topic ACLs. Pricing, and QoS/retained tiering via filter conditions, are configured in the Aforo console.
