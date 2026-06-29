# aforo-mqtt-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Python engineers running an MQTT client against a managed broker who need per-event billing.

## What you'll build

An MQTT client whose PUBLISH / SUBSCRIBE / UNSUBSCRIBE / CONNECT / DISCONNECT events are reported to Aforo, each tagged with topic, QoS, retained flag, and byte size — by wrapping a `paho-mqtt` or `aiomqtt` client. You'll finish by confirming a real publish reached the Aforo ingestor.

## Prerequisites

- Python **3.9+**.
- An Aforo **API key**, **tenant id**, and **product id** from the Aforo console.
- An MQTT broker you connect to (AWS IoT, HiveMQ Cloud, EMQ X Cloud, …) and either `paho-mqtt>=1.6` or `aiomqtt>=2.0`.
- The `customer_id` you bill against and the `client_id` of the connection.

## Step 1 — Install

```bash
pip install -e .                  # from python-mqtt/ (not yet on PyPI)
pip install -e ".[paho]"          # or [aiomqtt] / [httpx]
```

## Step 2 — Construct the billing client

```python
import os
from aforo_mqtt_metering import AforoMqttBilling

billing = AforoMqttBilling(
    tenant_id="tenant_acme",
    product_id="prod_mqtt_iot_telemetry",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://ingest.aforo.ai",
)
```

All four arguments are required — the constructor raises `ValueError` if any is empty.

> ⚠ `ingestor_url` is the **host**; this package appends `/v1/ingest/events`. Pass `https://ingest.aforo.ai`.

## Step 3 — Wrap your MQTT client

Wrap **before** you connect/publish so the SDK can hook the client's methods. `customer_id` is supplied here, once, for everything that client sends:

**paho-mqtt (sync):**

```python
import paho.mqtt.client as mqtt
from aforo_mqtt_metering import wrap_paho_client

client = mqtt.Client(client_id="device-001")
wrap_paho_client(billing, client, customer_id="cust_acme_001")
```

**aiomqtt (async):**

```python
import aiomqtt
from aforo_mqtt_metering import wrap_aiomqtt_client

async with aiomqtt.Client("broker.example.com", port=8883, tls_context=ssl_ctx) as c:
    wrap_aiomqtt_client(billing, c, customer_id="cust_acme_001", client_id="device-001")
```

> ⚠ Set `customer_id` from your trusted device/account mapping. Don't derive it from anything the broker peer controls. The wrap is what hooks publish/subscribe — an unwrapped client emits nothing.

## Step 4 — Publish and subscribe normally

```python
client.subscribe("sensors/+/temperature")          # → mqtt_broker.subscribe event
client.publish("devices/001/status", '{"online": true}')   # → mqtt_broker.publish event
client.loop_forever()
```

Each call produces one event with `mqttEventType`, `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttClientId`, and `dataBytes`.

## Step 5 — Verify it landed in Aforo

In the Aforo console, open the usage/events view for your tenant and filter by `metric_name = mqtt_broker.publish` (or `.subscribe`, `.connect`, etc.). You should see one event per outbound action carrying the topic, QoS, and byte size. If nothing appears, check the `ingestor_url` host and that the client was wrapped before publishing — see Troubleshooting.

## Step 6 — Bill inbound deliveries (optional, higher volume)

Inbound `on_message` callbacks are **not** billed by default. Turn them on only if you price per received message:

```python
billing = AforoMqttBilling(..., emit_deliver_events=True)
```

> ⚠ A wildcard subscription on a busy topic can deliver thousands of messages a second. With `emit_deliver_events=True` each one becomes a `mqtt_broker.deliver` event — make sure your rate plan and ingest budget expect that volume. Off by default for this reason.

## Step 7 — Tier by QoS / retained in your rate plan

The event attributes are designed for descriptor filter conditions in Aforo:

- Free QoS 0, paid QoS ≥ 1: `mqtt_qos IN ("1", "2")`
- Separate line for retained messages: `mqtt_retained = "true"`

These conditions live in the rate plan in the Aforo console — the SDK just emits the attributes.

## Step 8 — Shut down cleanly

```python
billing.shutdown()   # flushes the final batch before process exit
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | required | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | required | Product the events bill against. |
| `api_key` | `str` | required | Bearer token. |
| `ingestor_url` | `str` | required | Host; `/v1/ingest/events` appended. |
| `flush_interval_sec` | `float` | `2.0` | Background flush cadence. |
| `flush_count` | `int` | `200` | Buffer size that forces a flush. |
| `emit_deliver_events` | `bool` | `False` | Bill inbound `on_message` deliveries. |
| `on_error` | `Callable?` | logs | Called on permanent batch failure. |

Exports: `AforoMqttBilling`, `wrap_paho_client(billing, client, customer_id=...)`, `wrap_aiomqtt_client(billing, client, customer_id=..., client_id=...)`. Metric names: `mqtt_broker.<event_type>` (publish / subscribe / unsubscribe / connect / disconnect / deliver).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events at all | The client was wrapped after connecting/publishing, or never wrapped. | Call `wrap_paho_client` / `wrap_aiomqtt_client` before you publish/subscribe. |
| Inbound messages not billed | `emit_deliver_events` defaults to `False`. | Set `emit_deliver_events=True` if you price received messages. |
| `on_error` fires with "Aforo returned 401/403" | Bad/unscoped API key — 4xx is dropped, not retried. | Fix `api_key`; confirm it matches `tenant_id`. |
| Events sent, none in console | Wrong `ingestor_url` host, or `mqtt_broker.*` isn't mapped to a rate plan. | Use `https://ingest.aforo.ai`; map the metric in Aforo. |
| QoS tier never applies | Filter condition not set on the rate plan. | Add `mqtt_qos IN ("1","2")` (or similar) to the rate plan in the console. |
| Event volume far higher than expected | `emit_deliver_events=True` on a wildcard subscription. | Turn it off, or narrow the subscription topics. |
| Final batch lost on shutdown | `shutdown()` not called before exit. | Call `billing.shutdown()` in your cleanup path. |

## What this guide does NOT cover

Broker-side metering (every client on the broker) — that's the EMQ X plugin, not this SDK. It doesn't enforce QoS limits or topic ACLs. Payload inspection beyond byte counts. Pricing and QoS/retained tiering are configured in the Aforo console.
