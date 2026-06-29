# com.aforo:mqtt-metering

Meter MQTT client traffic — PUBLISH, SUBSCRIBE, CONNECT, DISCONNECT — from any Java MQTT client. Call one method per primitive from your Eclipse Paho (or other client) callbacks and Aforo handles batching and retry. For broker-side metering on EMQ X 5.x, use the companion Erlang plugin instead.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>mqtt-metering</artifactId>
  <version>1.0.0</version>
</dependency>
```

**Not yet on Maven Central — build from source for now:**

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java-mqtt
mvn clean install
```

Java 17+. `org.eclipse.paho:org.eclipse.paho.mqttv5.client` 1.2.5+ is a `provided` peer dependency — your application brings its own. The SDK's API takes raw MQTT primitives, so it works with any Java MQTT client, not only Paho.

## Quickstart — Eclipse Paho MQTT 5

```java
import com.aforo.mqtt.AforoMqttBilling;
import org.eclipse.paho.mqttv5.client.*;
import org.eclipse.paho.mqttv5.common.MqttMessage;

AforoMqttBilling billing = AforoMqttBilling.newBuilder()
        .tenantId("tenant_acme")
        .productId("prod_mqtt_iot_telemetry")
        .apiKey(System.getenv("AFORO_API_KEY"))
        .ingestorUrl("https://ingest.aforo.ai")
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
    /* ...other callbacks... */
});
client.connect();

// Wrap your publish/subscribe calls:
client.subscribe("sensors/+/temperature", 1);
billing.recordSubscribe("cust_acme_001", "device-001", "sensors/+/temperature", 1);

client.publish("devices/001/status", new MqttMessage("{\"online\": true}".getBytes()));
billing.recordPublish("cust_acme_001", "device-001", "devices/001/status", 0, false, 17);
```

Events POST to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer <apiKey>` and `X-Tenant-Id: <tenantId>`. The buffer flushes every 2 seconds or once 200 events queue — the most aggressive of the SDKs, because MQTT telemetry can run tens of thousands of events/sec — with 3× exponential retry.

> ⚠ The SDK does not see your MQTT traffic — you report it. Call the matching `record*` method right next to each `publish` / `subscribe` / `connect` / `disconnect`. The customer id is your argument; resolve it from your device-to-customer mapping, never from the message payload.

## Event types

| SDK call | `mqttEventType` | Notes |
|---|---|---|
| `recordPublish` | `PUBLISH` | Carries `mqttQos`, `mqttRetained`, `dataBytes`. |
| `recordDeliver` | `DELIVER` | **Off by default** — emitted only when `emitDeliverEvents(true)`. |
| `recordSubscribe` | `SUBSCRIBE` | Topic filter + QoS. |
| `recordUnsubscribe` | `UNSUBSCRIBE` | Topic filter. |
| `recordConnect` | `CONNECT` | Lifecycle marker. |
| `recordDisconnect` | `DISCONNECT` | Lifecycle marker. |

Inbound `DELIVER` volume is typically high, so it's opt-in. Turn it on only if you bill per receipt.

## Configuration

Builder options on `AforoMqttBilling.newBuilder()`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | Sent as the `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | Stamped into `metadata.productId`. |
| `apiKey` | `String` | *(required)* | Bearer token. |
| `ingestorUrl` | `String` | *(required)* | Ingestion host. The SDK appends `/v1/ingest/events`. Use `https://ingest.aforo.ai`. |
| `emitDeliverEvents` | `boolean` | `false` | When `true`, `recordDeliver` emits `DELIVER` events. Off by default. |
| `flushCount` | `int` | `200` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `long` | `2000` | Background flush cadence (ms). |

Every required field is validated at build time — a blank value throws `IllegalArgumentException`.

## QoS / retain in rate plans

Every event carries `mqttQos` (0/1/2) and `mqttRetained`. Use them in descriptor filter conditions to differentiate pricing — e.g. charge only QoS ≥ 1 with `filterCondition: { mqtt_qos: ['1', '2'] }`, or a premium tier for retained messages with `filterCondition: { mqtt_retained: ['true'] }`.

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Broker-side metering.** This is a client-mode SDK — it meters what your client code reports. For broker-level metering on EMQ X 5.x, use the companion Erlang plugin (`aforo-emqx-plugin/`), which sees all traffic without per-client wiring.
- **Automatic Paho interception.** There's no Paho callback the SDK auto-installs; you add the `record*` calls. Frames you don't report aren't metered.
- **Guaranteed delivery.** Events buffer in memory; a hard crash or a flush exhausting all 3 retries drops that batch (logged at `WARNING`). There is no on-disk spool.
