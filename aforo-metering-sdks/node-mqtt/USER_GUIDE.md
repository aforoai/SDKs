# @aforo/mqtt-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Node.js engineers running an Aedes MQTT broker, or an `mqtt.js` client against a third-party broker, who need MQTT usage metered into Aforo.

## What you'll build

A metered MQTT pipeline: either a broker that emits an Aforo event for every client PUBLISH/SUBSCRIBE/CONNECT/DISCONNECT, or a client that meters what it publishes and (optionally) receives. By the end you'll have published a metered message and confirmed the event reached Aforo.

## Prerequisites

- Node.js ≥ 18 (the SDK uses the global `fetch`).
- An Aforo API key, a tenant id (`tenant_…`), and a product id.
- Broker mode: `aedes` ^0.51 + a way to map a client id → customer id. Client mode: `mqtt` ^5 + the customer id this client bills to.

## Step 1 — Install the SDK

Once published:

```bash
npm i @aforo/mqtt-metering aedes   # broker mode
# or
npm i @aforo/mqtt-metering mqtt    # client mode
```

It isn't on npm yet. Build from source and link it:

```bash
cd aforo-metering-sdks/node-mqtt
npm install
npm run build      # produces dist/

cd /path/to/your-app
npm install /absolute/path/to/aforo-metering-sdks/node-mqtt
npm install aedes  # broker mode, OR: npm install mqtt
```

## Step 2 — Create the billing instance

Construct it once at startup. It starts a background flush timer immediately.

```ts
import { AforoMqttBilling } from '@aforo/mqtt-metering';

const billing = new AforoMqttBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_mqtt_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingest.aforo.ai', // SDK appends /v1/ingest/events
});
```

> ⚠ `ingestorUrl` is the **base** URL — the SDK appends `/v1/ingest/events`. Don't include the path.

## Step 3 — Hook the broker (or wrap the client)

**Broker mode** — `wrapAedesBroker` listens for `publish`, `subscribe`, `unsubscribe`, `client` (connect), and `clientDisconnect`. You must map the MQTT client id to a customer:

```ts
import aedes from 'aedes';
import { createServer } from 'net';

const broker = aedes();
billing.wrapAedesBroker(broker, {
  resolveCustomerId: async (clientId, username) => customerStore.byClientId(clientId),
  resolveMetadata: (clientId) => ({ deviceClass: deviceRegistry.classOf(clientId) }),
});
createServer(broker.handle).listen(1883);
```

> ⚠ `resolveCustomerId` may be async and runs on every event. A client whose id resolves to `undefined` has its events **silently skipped**. Broker-originated publishes (no `client`) are skipped too.

**Client mode** — `wrapMqttClient` wraps `publish` and listens for `connect`/`close`/`message`. All traffic bills to the one `customerId`:

```ts
import mqtt from 'mqtt';

const client = mqtt.connect('mqtts://broker.example.com', { clientId: `device-${deviceId}` });
billing.wrapMqttClient(client, { customerId: 'cust_acme_001' });

client.on('connect', () => {
  client.subscribe('sensors/+/temperature');
  client.publish('devices/status', JSON.stringify({ online: true }));
});
```

## Step 4 — Decide on DELIVER (fan-out) events

By default, `DELIVER` events are **dropped** — in both modes — because fan-out (one publish → many subscribers, or a client receiving a stream) can be tens of thousands of events/sec. `PUBLISH`, `SUBSCRIBE`, `UNSUBSCRIBE`, `CONNECT`, and `DISCONNECT` are always metered.

Turn fan-out on only if your pricing needs per-delivery counts — and raise the batch ceiling:

```ts
new AforoMqttBilling({ /* … */, emitDeliverEvents: true, flushCount: 1000 });
```

> ⚠ In client mode, inbound `message` events map to `DELIVER` — so without `emitDeliverEvents: true`, a subscribe-only client meters CONNECT/SUBSCRIBE/DISCONNECT but **no message events**. That's intentional; flip the flag if you bill on received messages.

## Step 5 — Publish a metered message

```bash
# requires `npm i -g mqtt`  (provides the `mqtt` CLI)
mqtt pub -h localhost -p 1883 -i device-abc -t 'sensors/room1/temperature' -m '{"c":21.4}'
```

In broker mode this fires a `mqtt_broker.publish` event for the customer that `device-abc` resolves to, with `mqttTopic: sensors/room1/temperature`, `mqttQos`, `mqttRetained`, and `dataBytes` = payload size.

## Step 6 — Flush and verify it landed in Aforo

Events buffer until `flushCount` (200) or `flushIntervalMs` (2000) is hit. Force a flush on graceful shutdown:

```ts
process.on('SIGTERM', async () => { await billing.shutdown(); });
process.on('SIGINT',  async () => { await billing.shutdown(); process.exit(0); });
```

> ⚠ Without `shutdown()`, a process that exits inside the 2-second window drops the buffered batch.

The batch is POSTed to `https://ingest.aforo.ai/v1/ingest/events` with `Authorization: Bearer <your api key>` and `X-Tenant-Id: tenant_acme`. Confirm in the Aforo console under the product's usage events (filter `productType = MQTT_BROKER`). On 3 consecutive failures (1s/2s/4s backoff) the batch is dropped and `onError` fires — log it:

```ts
new AforoMqttBilling({ /* … */, onError: (err) => myLogger.error('aforo mqtt flush failed', err) });
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. |
| `productId` | `string` | — (required) | Aforo product id; into `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent as `Authorization: Bearer <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Base URL; SDK appends `/v1/ingest/events`. |
| `emitDeliverEvents` | `boolean` | `false` | Emit `DELIVER` (fan-out) events. Off → dropped, both modes. |
| `flushCount` | `number` | `200` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `number` | `2000` | Max ms before a partial batch is flushed. |
| `onError` | `(error: Error) => void` | `console.error` | Terminal flush-failure callback. |
| `resolveCustomerId` | `(clientId, username?) => string \| undefined \| Promise<…>` | — (broker, required) | Map client id → customer; `undefined` → skip. |
| `resolveMetadata` | `(clientId) => Record<string, unknown> \| undefined` | `undefined` (broker) | Optional per-client tags. |
| `customerId` | `string` | — (client, required) | Customer for all traffic on this client. |
| `clientId` | `string` | `client.options.clientId` → `'mqtt-client'` | Fixed client id for client mode. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events from a device | `resolveCustomerId` returned `undefined` for that client id | Confirm the client id → customer mapping; unmapped clients are skipped by design. |
| Subscribe-only client meters nothing on receive | Inbound `message` maps to `DELIVER`, dropped by default | Set `emitDeliverEvents: true` if you bill on received messages. |
| Publishes counted but fan-out missing | `DELIVER` events off | Set `emitDeliverEvents: true`. |
| Events stop after a deploy | Process exited before the 2s timer flushed | Call `await billing.shutdown()` on `SIGTERM`/`SIGINT`. |
| `…/v1/ingest/events/v1/ingest/events` in logs | `ingestorUrl` already includes the path | Set `ingestorUrl` to the base host only. |
| `mqttClientId` is `mqtt-client` for every client-mode event | No `clientId` configured and `client.options.clientId` unset | Pass `clientId` in the `wrapMqttClient` options, or set it on the mqtt.js connection. |
| `onError` firing repeatedly | Wrong `apiKey`/`tenantId`, or ingestor unreachable | Verify credentials and that the host accepts `POST /v1/ingest/events`. |

## What this guide does NOT cover

- **Mosquitto / non-Aedes brokers.** Broker mode targets the Aedes event surface. A different broker needs the client-proxy mode, or your own adapter calling the same event shape.
- **Per-subscriber fan-out by default.** See Step 4 — opt in with `emitDeliverEvents`.
- **Rating, invoicing, plan config.** Those live in the Aforo console (use `mqttQos` / `mqttRetained` in filter conditions for tiered pricing).
- **Durable delivery.** The buffer is in-memory; see Step 6 for the crash-window caveat.
