# ai.aforo:mqtt-metering

Meter MQTT client traffic — PUBLISH, SUBSCRIBE, CONNECT, DISCONNECT — from any Java MQTT client. Call one method per primitive from your Eclipse Paho (or other client) callbacks and Aforo handles batching and retry. For broker-side metering on EMQ X 5.x, use the companion Erlang plugin instead.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>ai.aforo</groupId>
  <artifactId>mqtt-metering</artifactId>
  <version>2.0.0</version>
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
        .ingestorUrl("https://api.aforo.ai")
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

Events POST to `<ingestorUrl>/v1/ingest/batch` as `{"events": [...]}` (at most 1000 events per request; larger flushes are split) with `X-API-Key: <apiKey>` and `X-Tenant-Id: <tenantId>`. The SDK keeps events in a bounded queue (10 000 by default; overflow evicts the oldest as `OVERFLOW`). One background thread sends them every 5 seconds or as soon as 500 are queued. Retries use full-jitter backoff and honour `Retry-After` (seconds or HTTP-date, up to 60 s). If the ingestor stays unreachable, the batch goes back to the queue with the same idempotency keys and is resent after a cooldown, so an outage loses nothing while the queue has room. `close()` keeps sending for up to `shutdownTimeoutMs` (5 s) and reports what is left as `SHUTDOWN`.

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
| `apiKey` | `String` | *(required)* | Aforo API key, sent as `X-API-Key`. |
| `ingestorUrl` | `String` | *(required)* | Ingestion host, `https://` (plain `http://` only for localhost or with `allowInsecureHttp`). The SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `emitDeliverEvents` | `boolean` | `false` | When `true`, `recordDeliver` emits `DELIVER` events. Off by default. |
| `productType` | `String` | `MQTT_BROKER` | Top-level `productType` on every event (required by the ingestor). Trimmed and uppercased; unknown values are passed through. |
| `flushCount` | `int` | `500` | Events per request (at most 1000); also how many queued events wake the sender. |
| `flushIntervalMs` | `long` | `5000` | How often queued events are sent when the batch is not full (ms). |
| `maxQueueSize` | `int` | `10000` | Queue capacity; when full, the oldest event is dropped as `OVERFLOW`. |
| `maxRetries` | `int` | `3` | Retries per request on a network error, timeout, 408, 429 or 5xx. |
| `retryBaseMs` | `long` | `500` | Base of the full-jitter backoff (each wait is random up to `min(30 s, base × 2^attempt)`). |
| `timeoutMs` | `long` | `10000` | Total deadline of one ingest request (ms). |
| `shutdownTimeoutMs` | `long` | `5000` | How long `close()` keeps sending; leftovers are reported as `SHUTDOWN`. |
| `breakerCooldownMs` | `long` | `5000` | Pause after a batch fails every retry or gets 401/403; doubles with jitter up to 5 minutes. |
| `allowInsecureHttp` | `boolean` | `false` | Accept a plain `http://` `ingestorUrl` on a host other than localhost / 127.0.0.1 / ::1. |

Every required field is validated at build time — a blank value throws `IllegalArgumentException`.

## QoS / retain in rate plans

Every event carries `mqttQos` (0/1/2) and `mqttRetained`. Use them in descriptor filter conditions to differentiate pricing — e.g. charge only QoS ≥ 1 with `filterCondition: { mqtt_qos: ['1', '2'] }`, or a premium tier for retained messages with `filterCondition: { mqtt_retained: ['true'] }`.

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## Execution status (outcome-based pricing)

OUTCOME_BASED rate plans bill each event at the weight set for its `executionStatus`. This SDK never derives one — only the value you pass is sent. Every `record*` method has an overload with a trailing `executionStatus` argument:

```java
billing.recordPublish(customerId, clientId, topic, qos, retained, bytes, "SUCCESS");
billing.recordConnect(customerId, clientId, "BLOCKED");   // e.g. broker refused the CONNECT
```

The value is trimmed and upper-cased; `null` or blank means "not set" and the field is left off the event. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value is logged and left off the event (the event is still sent) — the ingestor would reject an event carrying an unknown status.

## Dropped events

Events the SDK cannot deliver are counted, logged at `WARNING`, and passed to an optional hook. Nothing is thrown from the `record*` / `openConnection` calls for event content.

```java
AforoMqttBilling billing = AforoMqttBilling.newBuilder()
        // ...
        .onDrop((events, reason) -> deadLetter.save(events, reason))
        .build();

long lost = billing.droppedCount();
```

| `DropReason` | When |
|---|---|
| `OVERFLOW` | The queue was full (usually during a long outage); the oldest event was evicted. |
| `SHUTDOWN` | Still queued when `close()` reached `shutdownTimeoutMs`. |
| `CLOSED` | Recorded after `close()`. Nothing is thrown. |
| `RETRY_EXHAUSTED` | Kept for compatibility. An outage no longer drops events: they wait in the queue and are resent with the same keys. |
| `REJECTED` | The ingestor answered a non-retryable 4xx for the batch, or accepted the batch (2xx) but refused individual events in `errors[]`. Only the events the response identifies by index are passed to the hook. |
| `INVALID` | The event breaks an ingestor field limit and was never sent: a blank `customerId`, a blank or whitespace-only topic, `customerId` over 64 characters, `productType` over 20. These values are never truncated. |

The topic and client id originate from the MQTT packet: a topic over 500 characters or a `clientId` over 128 is cut to the limit on `mqttTopic` / `mqttClientId` and the event is still sent, with one `WARNING` per label per instance.

Dropped events keep their `idempotencyKey`, so storing them and re-sending later is dedup-safe. An exception thrown by the hook is swallowed.

## What this doesn't cover

- **Broker-side metering.** This is a client-mode SDK — it meters what your client code reports. For broker-level metering on EMQ X 5.x, use the companion Erlang plugin (`aforo-emqx-plugin/`), which sees all traffic without per-client wiring.
- **Automatic Paho interception.** There's no Paho callback the SDK auto-installs; you add the `record*` calls. Frames you don't report aren't metered.
- **Guaranteed delivery.** Events wait in an in-memory queue. A hard crash loses what is queued, and an overflow past `maxQueueSize` drops the oldest events (reported to `onDrop`). There is no on-disk spool. A `401` / `403` from the ingestor is treated as an outage and logged at `SEVERE`: fix the key and the queued events are delivered.
