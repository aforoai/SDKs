# com.aforo:mqtt-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Java engineers running an MQTT client (Eclipse Paho or other) who need per-message usage metering. For broker-side metering, see the EMQ X plugin instead.

## What you'll build

An MQTT client that reports one Aforo event per PUBLISH / SUBSCRIBE / CONNECT / DISCONNECT (and optionally per DELIVER), carrying topic, QoS, retain flag, and byte size. By the end you'll have a metered publish confirmed as landed in Aforo.

## Prerequisites

- JDK 17 or newer.
- An MQTT client. The examples use Eclipse Paho MQTT 5 (`org.eclipse.paho.mqttv5.client` 1.2.5+), supplied by your app.
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id` for this MQTT surface.
- A device-id → customer-id mapping you control (the SDK takes `customerId` as an argument).

## Step 1 — Build the SDK into your local Maven repo

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java-mqtt
mvn clean install
```

Add to your service's `pom.xml`:

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>mqtt-metering</artifactId>
  <version>1.0.0</version>
</dependency>
```

## Step 2 — Export your credentials

```bash
export AFORO_API_KEY="sk_live_xxxxxxxxxxxxxxxxxxxx"
```

## Step 3 — Build one shared billing instance

```java
import com.aforo.mqtt.AforoMqttBilling;

AforoMqttBilling billing = AforoMqttBilling.newBuilder()
        .tenantId("tenant_acme")
        .productId("prod_mqtt_iot_telemetry")
        .apiKey(System.getenv("AFORO_API_KEY"))
        .ingestorUrl("https://ingest.aforo.ai")
        // .emitDeliverEvents(true)   // opt in to bill inbound DELIVER too
        .build();
```

> ⚠ `ingestorUrl` is the host only — the SDK appends `/v1/ingest/events`. Pass `https://ingest.aforo.ai`, not the full path.

## Step 4 — Report each MQTT primitive

The SDK can't see your MQTT traffic, so call the matching method right beside each client operation:

```java
client.setCallback(new MqttCallback() {
    public void connectComplete(boolean reconnect, String serverURI) {
        billing.recordConnect("cust_acme_001", "device-001");
    }
    public void disconnected(MqttDisconnectResponse r) {
        billing.recordDisconnect("cust_acme_001", "device-001");
    }
    public void messageArrived(String topic, MqttMessage msg) {
        // DELIVER is dropped unless emitDeliverEvents(true)
        billing.recordDeliver("cust_acme_001", "device-001",
                topic, msg.getQos(), msg.isRetained(), msg.getPayload().length);
    }
    /* ...other callbacks... */
});

client.subscribe("sensors/+/temperature", 1);
billing.recordSubscribe("cust_acme_001", "device-001", "sensors/+/temperature", 1);

client.publish("devices/001/status", new MqttMessage("{\"online\": true}".getBytes()));
billing.recordPublish("cust_acme_001", "device-001", "devices/001/status", 0, false, 17);
```

> ⚠ Resolve `customerId` from your device-to-customer mapping (provisioning record, auth), not from the topic or payload — those are client-controlled. `recordDeliver` is silently a no-op unless you build with `emitDeliverEvents(true)`; inbound volume is high, so turn it on only if you bill per receipt.

## Step 5 — Publish, then flush and verify

Publish a message (with its `recordPublish` beside it), then flush the buffer:

```java
billing.close();   // flushes synchronously, then shuts down the daemon thread
```

Then confirm on the Aforo side:

- Aforo console → **Ingestion → Recent Events**, filter by your `customerId` and `metricName = mqtt_broker.publish`. The event shows `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttClientId`, and `dataBytes`.

For a long-running client, register the flush on shutdown:

```java
Runtime.getRuntime().addShutdownHook(new Thread(billing::close));
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | `metadata.productId`. |
| `apiKey` | `String` | *(required)* | Bearer token. |
| `ingestorUrl` | `String` | *(required)* | Host; SDK appends `/v1/ingest/events`. |
| `emitDeliverEvents` | `boolean` | `false` | `true` = emit `DELIVER` events for inbound messages. |
| `flushCount` | `int` | `200` | Events per immediate flush. |
| `flushIntervalMs` | `long` | `2000` | Background flush cadence (ms). |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `IllegalArgumentException: <field> is required` at build | A required builder field (`tenantId` / `productId` / `apiKey` / `ingestorUrl`) is blank | Set all four; they're validated in the constructor. |
| Inbound messages not metered | `DELIVER` is off by default | Build with `.emitDeliverEvents(true)` if you bill on receipt. |
| `metricName` is `mqtt_broker.<x>` not what you expected | The metric name is derived as `mqtt_broker.<eventType-lowercased>` | Define metrics in Aforo matching `mqtt_broker.publish`, `mqtt_broker.subscribe`, etc. |
| Events POST to a 404 | `ingestorUrl` already includes the path | Pass the host only; the SDK appends `/v1/ingest/events`. |
| `flush exhausted retries — dropped N events` in logs | Ingestor returned non-2xx on all 3 attempts | Verify the key + `X-Tenant-Id`; ensure the `mqtt_broker.*` metrics exist in Aforo. |
| Want to bill differently by QoS / retain | Filtering happens in the Aforo rate plan, not the SDK | Use descriptor `filterCondition` on `mqtt_qos` / `mqtt_retained` (every event carries both). |

## What this guide does NOT cover

- **Broker-side metering.** This SDK meters client code. For EMQ X 5.x broker-level metering, use the Erlang plugin at `aforo-emqx-plugin/` — it sees all traffic without per-client `record*` calls.
- **Automatic Paho hooks.** You add the `record*` calls yourself; the SDK installs nothing into Paho.
- **Reading metered usage back.** This SDK writes events only — retrieval and rating live in the Aforo platform.
