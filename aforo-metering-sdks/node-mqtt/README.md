# @aforo/mqtt-metering

Meter MQTT traffic into Aforo two ways: hook an Aedes broker you operate to meter every PUBLISH/SUBSCRIBE/CONNECT/DISCONNECT, or wrap an `mqtt.js` client to meter what it publishes and receives against a third-party broker (AWS IoT, HiveMQ Cloud, EMQ X Cloud).

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

| Mode | When to use | Entry point |
|---|---|---|
| **Broker hook** | You run the broker (Aedes) and want to meter every client's events | `wrapAedesBroker(broker, options)` |
| **Client proxy** | You consume a third-party broker and want client-side billing | `wrapMqttClient(client, options)` |

## Install

Intended public install (once published):

```bash
npm i @aforo/mqtt-metering aedes   # broker mode
# or
npm i @aforo/mqtt-metering mqtt    # client mode
```

> **Not yet on the public npm registry — install from source for now.** `aedes` and `mqtt` are **optional** peer dependencies — install only the one your mode needs.

```bash
# from the SDKs repo root
cd aforo-metering-sdks/node-mqtt
npm install
npm run build          # tsc → dist/

# then, from YOUR app
npm install /absolute/path/to/aforo-metering-sdks/node-mqtt
npm install aedes      # broker mode, OR:
npm install mqtt       # client mode
```

## Quickstart

**Broker mode (Aedes):**

```ts
import aedes from 'aedes';
import { createServer } from 'net';
import { AforoMqttBilling } from '@aforo/mqtt-metering';

const billing = new AforoMqttBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_mqtt_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingest.aforo.ai', // SDK appends /v1/ingest/events
});

const broker = aedes();
billing.wrapAedesBroker(broker, {
  resolveCustomerId: async (clientId, username) => customerStore.byClientId(clientId),
  resolveMetadata: (clientId) => ({ deviceClass: deviceRegistry.classOf(clientId) }),
});

createServer(broker.handle).listen(1883);
process.on('SIGTERM', async () => { await billing.shutdown(); });
```

**Client mode (`mqtt.js`):**

```ts
import mqtt from 'mqtt';
import { AforoMqttBilling } from '@aforo/mqtt-metering';

const billing = new AforoMqttBilling({ tenantId: 'tenant_acme', productId: 'prod_mqtt_001', apiKey: process.env.AFORO_API_KEY!, ingestorUrl: 'https://ingest.aforo.ai' });
const client = mqtt.connect('mqtts://broker.example.com', { clientId: `device-${deviceId}` });

billing.wrapMqttClient(client, { customerId: 'cust_acme_001' });
```

Each event uses `metricName: "mqtt_broker.<event>"` (`mqtt_broker.publish`, `mqtt_broker.subscribe`, …) with `quantity: 1`, and carries `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttClientId`, and `dataBytes`. Events ship to `POST https://ingest.aforo.ai/v1/ingest/events` with `Authorization: Bearer <api_key>` and `X-Tenant-Id: <tenant_id>`.

> **`DELIVER` (fan-out) events are dropped unless `emitDeliverEvents: true`.** This gate applies in **both** modes — client-mode inbound `message` deliveries and any broker delivery path are skipped by default because fan-out is high-volume. `PUBLISH`, `SUBSCRIBE`, `UNSUBSCRIBE`, `CONNECT`, and `DISCONNECT` are always metered.

## Configuration

`new AforoMqttBilling(config)` — `tenantId`, `productId`, `apiKey`, and `ingestorUrl` are required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. Never read from a client header. |
| `productId` | `string` | — (required) | Aforo product id; into each event's `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent as `Authorization: Bearer <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Ingestion base URL. SDK appends `/v1/ingest/events`. Use `https://ingest.aforo.ai`. |
| `emitDeliverEvents` | `boolean` | `false` | Emit a `DELIVER` event per fan-out delivery. Off → `DELIVER` events are dropped (both modes). |
| `flushCount` | `number` | `200` | Buffered events that trigger an immediate flush. Highest default of the SDKs — MQTT is very high-volume. |
| `flushIntervalMs` | `number` | `2000` | Max ms before a partial batch is flushed. |
| `onError` | `(error: Error) => void` | logs to `console.error` | Called when a flush fails terminally (after 3 retries). |

Mode-specific options:

| Option | Mode | Type | What it does |
|---|---|---|---|
| `resolveCustomerId` | broker | `(clientId, username?) => string \| undefined \| Promise<…>` | Required. Map an MQTT client id to a customer. `undefined` → that client's events are not metered. |
| `resolveMetadata` | broker | `(clientId) => Record<string, unknown> \| undefined` | Optional per-client tags. |
| `customerId` | client | `string` | Customer to attribute all traffic on this client to. |
| `clientId` | client | `string` | Fixed client id (defaults to `client.options.clientId`, then `'mqtt-client'`). |

Every event carries `mqttQos` (0/1/2) and `mqttRetained` — use them in Aforo rate-plan filter conditions to price QoS ≥ 1 or retained messages separately.

Exported symbols: `AforoMqttBilling` (with `wrapAedesBroker` / `wrapMqttClient` / `shutdown`) and the `AforoMqttConfig` / `AedesBrokerOptions` / `MqttClientOptions` types.

## Walk me through it

Step-by-step from install to a verified event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Fan-out billing is opt-in.** `DELIVER` events are dropped unless `emitDeliverEvents: true`. Default metering counts the PUBLISH, not the per-subscriber fan-out.
- **Client-mode CONNECT/DISCONNECT use socket lifecycle.** `wrapMqttClient` maps `connect`/`close`; a client that reconnects emits a CONNECT each time.
- **No persistent buffer.** Events are in memory until flushed; a hard crash before flush drops the buffered batch. `shutdown()` covers graceful exit only.
- **The SDK does not enforce or read pricing.** It emits usage; rating/billing happens in Aforo.
