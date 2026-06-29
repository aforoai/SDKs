# @aforo/mqtt-metering

Aforo MQTT Metering SDK for Node.js. Two integration modes:

| Mode | When to use |
|------|-------------|
| **Broker hook** (`wrapAedesBroker`) | You operate the MQTT broker yourself (Aedes, Mosquitto with Node wrapper) and want to meter every PUBLISH, SUBSCRIBE, CONNECT, DISCONNECT event |
| **Client proxy** (`wrapMqttClient`) | You consume a third-party broker (AWS IoT, HiveMQ Cloud, EMQ X Cloud) and want to meter only what your client publishes + receives |

## Install

```bash
npm install @aforo/mqtt-metering aedes    # broker mode
# or
npm install @aforo/mqtt-metering mqtt     # client mode
```

## Usage — Aedes broker

```ts
import aedes from 'aedes';
import { createServer } from 'net';
import { AforoMqttBilling } from '@aforo/mqtt-metering';

const billing = new AforoMqttBilling({
  tenantId: process.env.AFORO_TENANT_ID!,
  productId: 'prod_mqtt_iot_telemetry',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingestor.aforo.ai',
});

const broker = aedes();
billing.wrapAedesBroker(broker, {
  resolveCustomerId: async (clientId, username) => {
    // Look up the customer for this device/user
    return customerStore.byClientId(clientId);
  },
  resolveMetadata: (clientId) => ({ deviceClass: deviceRegistry.classOf(clientId) }),
});

createServer(broker.handle).listen(1883);
```

Events emitted per MQTT action:

| Broker event | Aforo event | Topic | Bytes |
|--------------|-------------|-------|-------|
| PUBLISH | `mqtt_broker.publish` | packet.topic | payload size |
| SUBSCRIBE | `mqtt_broker.subscribe` | sub.topic | 0 |
| UNSUBSCRIBE | `mqtt_broker.unsubscribe` | unsub | 0 |
| CONNECT | `mqtt_broker.connect` | (empty) | 0 |
| DISCONNECT | `mqtt_broker.disconnect` | (empty) | 0 |

## Usage — mqtt.js client

```ts
import mqtt from 'mqtt';
import { AforoMqttBilling } from '@aforo/mqtt-metering';

const billing = new AforoMqttBilling({ /* ... */ });

const client = mqtt.connect('mqtts://broker.example.com', {
  clientId: `device-${deviceId}`,
  username: apiKey,
});

billing.wrapMqttClient(client, { customerId: 'cust_acme_001' });

client.on('connect', () => {
  client.subscribe('sensors/+/temperature');
  client.publish('devices/status', JSON.stringify({ online: true }));
});
```

Client-mode emits a `DELIVER` event per incoming message **only** when `emitDeliverEvents: true` is set on the config (off by default — high volume). `PUBLISH`, `CONNECT`, and `DISCONNECT` are always metered.

## QoS & retain flags

Every event carries `mqttQos` (0/1/2) and `mqttRetained`. Use these in rate plan filter conditions to differentiate pricing:

- Charge only for QoS ≥ 1 (guaranteed delivery): `filterCondition: { mqtt_qos: ['1', '2'] }`
- Separate tier for retained messages: `filterCondition: { mqtt_retained: ['true'] }`

## Batching & retry

Buffers up to 200 events / 2 seconds by default (most aggressive of all the SDKs — MQTT telemetry can be tens of thousands of events/sec). 3× exponential retry, then `onError`.

## License

MIT
