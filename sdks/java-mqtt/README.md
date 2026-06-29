# com.aforo:mqtt-metering

Aforo MQTT Metering SDK for Java — client-mode integration. For broker-side metering on EMQ X 5.x, use the companion Erlang plugin at `aforo-nextgen-docker/emqx-plugin-aforo-metering/`.

## Install

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>mqtt-metering</artifactId>
  <version>1.0.0</version>
</dependency>
```

Peer dep: `org.eclipse.paho:org.eclipse.paho.mqttv5.client ^1.2.5` (provided by your application).

## Usage — Eclipse Paho MQTT 5

```java
import com.aforo.mqtt.AforoMqttBilling;
import org.eclipse.paho.mqttv5.client.*;
import org.eclipse.paho.mqttv5.common.MqttMessage;

AforoMqttBilling billing = AforoMqttBilling.newBuilder()
    .tenantId("tenant_acme")
    .productId("prod_mqtt_iot_telemetry")
    .apiKey(System.getenv("AFORO_API_KEY"))
    .ingestorUrl("https://ingestor.aforo.ai")
    .build();

MqttClient client = new MqttClient("ssl://broker.example.com:8883", "device-001");
client.setCallback(new MqttCallback() {
    public void connectComplete(boolean reconnect, String serverURI) {
        billing.recordConnect("cust_acme_001", "device-001");
    }
    public void disconnected(MqttDisconnectResponse r) {
        billing.recordDisconnect("cust_acme_001", "device-001");
    }
    public void messageArrived(String topic, MqttMessage msg) {
        billing.recordDeliver("cust_acme_001", "device-001",
            topic, msg.getQos(), msg.isRetained(), msg.getPayload().length);
    }
    /* ... other callbacks ... */
});
client.connect();

// Wrap your publish/subscribe calls:
client.subscribe("sensors/+/temperature", 1);
billing.recordSubscribe("cust_acme_001", "device-001", "sensors/+/temperature", 1);

client.publish("devices/001/status", new MqttMessage("{\"online\": true}".getBytes()));
billing.recordPublish("cust_acme_001", "device-001",
    "devices/001/status", 0, false, 17);
```

## Event types

| SDK call             | Event type     |
|----------------------|---------------|
| `recordPublish`      | `PUBLISH`     |
| `recordDeliver`      | `DELIVER` (off by default — see below) |
| `recordSubscribe`    | `SUBSCRIBE`   |
| `recordUnsubscribe`  | `UNSUBSCRIBE` |
| `recordConnect`      | `CONNECT`     |
| `recordDisconnect`   | `DISCONNECT`  |

`DELIVER` events are **not** emitted unless `emitDeliverEvents(true)` is set on the builder. Inbound message volume is typically high; opt-in only if you need per-receipt billing.

## QoS / retain in rate plans

Every event carries `mqttQos` (0/1/2) and `mqttRetained`. Use these in descriptor filter conditions to differentiate pricing:

- Charge only QoS ≥ 1 → `filterCondition: { mqtt_qos: ['1', '2'] }`
- Premium tier for retained messages → `filterCondition: { mqtt_retained: ['true'] }`

## Batching & retry

200 events / 2 s by default — most aggressive of the SDKs because MQTT telemetry can be tens of thousands of events/sec. 3× exponential retry. AutoCloseable.

## License

MIT
