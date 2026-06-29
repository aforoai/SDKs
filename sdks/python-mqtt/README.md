# aforo-mqtt-metering

Aforo MQTT Metering SDK for Python — wraps the two dominant Python MQTT clients (`paho-mqtt` synchronous, `aiomqtt` async) to meter PUBLISH, SUBSCRIBE, UNSUBSCRIBE, CONNECT and DISCONNECT events.

> For **broker-side** (server-level) MQTT metering, see the companion EMQ X Erlang plugin at `aforo-nextgen-docker/emqx-plugin-aforo-metering/`. This Python SDK is for **client-side** metering — use it when you consume a third-party broker (AWS IoT, HiveMQ Cloud, EMQ X Cloud) and want to meter only what your client publishes and receives.

## Install

```bash
pip install aforo-mqtt-metering paho-mqtt        # paho (sync) integration
pip install aforo-mqtt-metering aiomqtt          # aiomqtt (async) integration
pip install aforo-mqtt-metering[httpx]           # faster HTTP flush
```

## Usage — paho-mqtt

```python
import paho.mqtt.client as mqtt
from aforo_mqtt_metering import AforoMqttBilling, wrap_paho_client

billing = AforoMqttBilling(
    tenant_id="tenant_acme",
    product_id="prod_mqtt_iot_telemetry",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://ingestor.aforo.ai",
)

client = mqtt.Client(client_id="device-001")
wrap_paho_client(billing, client, customer_id="cust_acme_001")

client.username_pw_set(username="api", password=os.environ["AFORO_API_KEY"])
client.tls_set()
client.connect("broker.example.com", 8883)
client.subscribe("sensors/+/temperature")
client.publish("devices/001/status", '{"online": true}')
client.loop_forever()
```

## Usage — aiomqtt (async)

```python
import aiomqtt
from aforo_mqtt_metering import AforoMqttBilling, wrap_aiomqtt_client

billing = AforoMqttBilling(...)

async def main():
    async with aiomqtt.Client("broker.example.com", port=8883, tls_context=ssl_ctx) as c:
        wrap_aiomqtt_client(billing, c, customer_id="cust_acme_001", client_id="device-001")
        await c.subscribe("sensors/+/temperature")
        await c.publish("devices/001/status", '{"online": true}')
        async for msg in c.messages:
            print(msg.topic, msg.payload)
```

## Event shape

Every event carries `mqttQos`, `mqttRetained`, `mqttClientId`, and `mqttEventType`. Use these in your rate plans:

```json
{
  "productType": "MQTT_BROKER",
  "mqttTopic": "sensors/room-a/temperature",
  "mqttQos": 1,
  "mqttRetained": false,
  "mqttEventType": "PUBLISH",
  "mqttClientId": "device-001",
  "dataBytes": 128
}
```

## QoS / retained filtering

Use descriptor filter conditions in your rate plans to tier by QoS:

- Free for QoS 0, paid for QoS ≥ 1: `filterCondition: mqtt_qos IN ("1", "2")`
- Separate line for retained messages: `filterCondition: mqtt_retained = "true"`

## Batching & retry

200 events / 2 seconds default — MQTT is the highest-volume of the protocols. 3× exponential retry, then `on_error`. Call `billing.shutdown()` before process exit.

## DELIVER events

Inbound `on_message` callbacks emit a `DELIVER` event **only** when `emit_deliver_events=True` is set on the config (off by default). This controls the trade-off: per-received-message billing vs. batch size.

## License

MIT
