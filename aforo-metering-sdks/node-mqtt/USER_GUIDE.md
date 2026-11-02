# @aforoai/mqtt-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Node.js engineers running an Aedes MQTT broker, or an `mqtt.js` client against a third-party broker, who need MQTT usage metered into Aforo.

## What you'll build

A metered MQTT pipeline: either a broker that emits an Aforo event for every client PUBLISH/SUBSCRIBE/CONNECT/DISCONNECT, or a client that meters what it publishes and (optionally) receives. By the end you'll have published a metered message and confirmed the event reached Aforo.

## Prerequisites

- Node.js ≥ 18 (the SDK uses the global `fetch`).
- An Aforo API key, a tenant id (`tenant_…`), and a product id.
- Broker mode: `aedes` ^0.51 + a way to map a client id → customer id. Client mode: `mqtt` ^5 + the customer id this client bills to.

## Step 1 — Install the SDK

Once published:

```bash
npm i @aforoai/mqtt-metering aedes   # broker mode
# or
npm i @aforoai/mqtt-metering mqtt    # client mode
```

Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog. If `2.0.0` is not on npm yet, install from source:

```bash
cd SDKs/aforo-metering-sdks/node-mqtt
npm install
npm run build      # produces dist/

cd /path/to/your-app
npm install /absolute/path/to/aforo-metering-sdks/node-mqtt
npm install aedes  # broker mode, OR: npm install mqtt
```

## Step 2 — Create the billing instance

Construct it once at startup. It starts a background flush timer immediately.

```ts
import { AforoMqttBilling } from '@aforoai/mqtt-metering';

const billing = new AforoMqttBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_mqtt_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai', // SDK appends /v1/ingest/batch
});
```

> ⚠ `ingestorUrl` is the **base** URL — the SDK appends `/v1/ingest/batch`. Don't include the path.

## Step 3 — Hook the broker (or wrap the client)

**Broker mode** — `wrapAedesBroker` listens for `publish`, `subscribe`, `unsubscribe`, `client` (connect), and `clientDisconnect`. You must map the MQTT client id to a customer:

```ts
import aedes from 'aedes';
import { createServer } from 'net';

const broker = aedes();
billing.wrapAedesBroker(broker, {
  customerResolver: async (clientId, username) => customerStore.byClientId(clientId),
  resolveMetadata: (clientId) => ({ deviceClass: deviceRegistry.classOf(clientId) }),
});
createServer(broker.handle).listen(1883);
```

> ⚠ `customerResolver` is required, may be async, and runs on every event. Map the client your broker authenticated — not a value the device chose. An event whose client resolves to nothing is not metered and counts as an `invalid` drop; a resolver that throws is reported through `onError` and never becomes an unhandled rejection. Broker-originated publishes (no `client`) are skipped. If your `authenticate` hook verifies the username, `trustCustomerHeader: true` bills the username instead.

**Client mode** — `wrapMqttClient` wraps `publish` and listens for `connect`/`close`/`end`/`message`. All traffic bills to the one `customerId`. A publish is billed once mqtt.js reports it succeeded (the broker's PUBACK/PUBCOMP for QoS 1/2, the socket write for QoS 0), and a reconnect within `reconnectDebounceMs` (default 30 s) is the same session, so it bills no new CONNECT/DISCONNECT:

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

Events queue until `flushCount` (500) are waiting or `flushIntervalMs` (5000) passes; one background sender ships them. The SDK installs no signal handlers — call `shutdown()` from yours. It sends what is queued for at most `shutdownTimeoutMs` (5 s) and reports anything left with reason `shutdown`:

```ts
process.once('SIGTERM', async () => {
  await billing.shutdown();
  process.exit(0);
});
```

> ⚠ Without `shutdown()`, a process killed by a signal loses what is queued. A process that ends on its own sends it on `beforeExit`.

The batch is POSTed to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <your api key>` and `X-Tenant-Id: tenant_acme`. Confirm in the Aforo console under the product's usage events (filter `productType = MQTT_BROKER`). Network errors, timeouts, 408, 429 (honouring `Retry-After`) and 5xx are retried 3× with randomized backoff; after that — or on 401/403 — the batch stays queued and is re-sent when the ingestor recovers. Any other 4xx is not retried. `onError` fires on refused batches, on an outage (once), on resolver failures and on events lost at the shutdown deadline — log it:

```ts
new AforoMqttBilling({ /* … */, onError: (err) => myLogger.error('aforo mqtt flush failed', err) });
```

## Outcomes and dropped events

- **`executionStatus`** — the outcome used by outcome-based pricing. How this SDK sets it, the accepted values and how to override it: [README → Execution status](README.md#execution-status).
- **Dropped events** — the SDK does not throw into your broker or client handlers for event content. Events it cannot deliver are counted in `billing.droppedCount`, logged with `console.warn`, and passed to `onDrop(events, reason)`. The reasons (`invalid`, `rejected`, `overflow`, `shutdown`, `closed`) and what triggers each: [README → Dropped events](README.md#dropped-events).

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. |
| `productId` | `string` | — (required) | Aforo product id; into `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent only as `X-API-Key: <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Base URL, `https://`; SDK appends `/v1/ingest/batch`. |
| `productType` | `string` | `'MQTT_BROKER'` | Top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override via `wrapAedesBroker(broker, { productType })` or `wrapMqttClient(client, { customerId, productType })`. |
| `emitDeliverEvents` | `boolean` | `false` | Emit `DELIVER` (fan-out) events. Off → dropped, both modes. |
| `allowInsecureHttp` | `boolean` | `false` | Accept a plain `http://` `ingestorUrl` on a non-local host. `https://` is required otherwise (plain http is fine for `localhost`, `127.0.0.1`, `::1`). |
| `flushCount` | `number` | `500` | Events per request (max 1000). Reaching it wakes the background sender; recording an event never sends by itself. |
| `flushIntervalMs` | `number` | `5000` | The background sender also runs this often. |
| `maxQueueSize` | `number` | `10000` | Queue capacity. When it is full — usually during a long outage — the oldest event is dropped with reason `overflow`. |
| `maxRetries` | `number` | `3` | Retries per batch on network errors, timeouts, 408, 429 and 5xx, with full-jitter backoff (`Retry-After` in seconds or as a date is honoured, capped at 60 s). |
| `timeoutMs` | `number` | `10000` | Total deadline per request. |
| `shutdownTimeoutMs` | `number` | `5000` | How long `shutdown()` keeps sending. Events still queued then are dropped with reason `shutdown`. |
| `flushOnExit` | `boolean` | `true` | Send queued events on the process `beforeExit` event, within `shutdownTimeoutMs`. The SDK installs no signal handlers. |
| `onError` | `(error: Error) => void` | logs to `console.error` | Called for delivery problems: a batch the ingestor refused (the message includes its `errors[].message`), an ingestor outage (once per outage), a wrong or revoked API key, events lost at the shutdown deadline, and an unusable `executionStatus`. Delivery reports are a `CoreTransportError`: branch on `err.kind` (`outage`, `auth`, `rejected`, `shutdown`, `closed`) and read `err.events`, not the message. Exceptions it throws are caught. |
| `reconnectDebounceMs` | `number` | `30000` | A connection that drops and comes back within this window is one session: no new CONNECT/DISCONNECT pair is billed for the flap. A drop that does not come back is billed as DISCONNECT, stamped with the time it dropped, once the window passes; a clean disconnect is billed at once. `0` turns the window off. Overridable per `wrapAedesBroker` / `wrapMqttClient` call. |
| `onDrop` | `(events, reason) => void` | none | Receives events lost for good. See [Dropped events](#dropped-events). |
| `customerResolver` | `(clientId, username?) => string \| undefined \| Promise<…>` | — (broker, required unless `trustCustomerHeader`) | Map the authenticated client → customer; nothing → `invalid` drop. `resolveCustomerId` is a deprecated alias. |
| `trustCustomerHeader` | `boolean` | `false` (broker) | Bill the MQTT username. Only when your broker authenticates it. |
| `resolveMetadata` | `(clientId) => Record<string, unknown> \| undefined` | `undefined` (broker) | Optional per-client tags. |
| `customerId` | `string` | — (client, required) | Customer for all traffic on this client. |
| `clientId` | `string` | `client.options.clientId` → `'mqtt-client'` | Fixed client id for client mode. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events from a device, `droppedCount` rises (`invalid`) | `customerResolver` returned nothing for that client | Confirm the client → customer mapping. |
| `wrapAedesBroker needs a customerResolver` at startup | 2.0 requires an explicit customer source | Pass `customerResolver`, or `trustCustomerHeader: true` when the broker authenticates usernames. |
| `must use https://` at startup | `ingestorUrl` is plain http to a remote host | Use https, or `allowInsecureHttp: true` on a private network. |
| Subscribe-only client meters nothing on receive | Inbound `message` maps to `DELIVER`, dropped by default | Set `emitDeliverEvents: true` if you bill on received messages. |
| Publishes counted but fan-out missing | `DELIVER` events off | Set `emitDeliverEvents: true`. |
| Events stop after a deploy | Process was killed before the queue was sent | Call `await billing.shutdown()` from your `SIGTERM`/`SIGINT` handler. |
| `…/v1/ingest/batch/v1/ingest/batch` in logs | `ingestorUrl` already includes the path | Set `ingestorUrl` to the base host only. |
| `mqttClientId` is `mqtt-client` for every client-mode event | No `clientId` configured and `client.options.clientId` unset | Pass `clientId` in the `wrapMqttClient` options, or set it on the mqtt.js connection. |
| `onError` with `err.kind === 'outage'` (`Aforo ingestor unavailable`) | Ingestor unreachable | Events stay queued and are sent on recovery. Raise `maxQueueSize` for long outages. |
| `onError` with `err.kind === 'auth'` (`HTTP 401` / `HTTP 403`) | Wrong or revoked API key | Events stay queued; they are sent once a valid key is in place. |
| Publishes you made are missing | The publish failed (its callback got an error) — failed publishes are not billed | Check the error your own `publish` callback receives. |
| `droppedCount` rises and the warning says `invalid` | An event failed a client-side check (`customerId` longer than 64 characters, a missing or whitespace-only `mqttTopic`, or `productType` longer than 20) | Fix the value named in the warning; these values are not truncated. (A topic over 500 characters, or a client id over 128, is cut to the limit and the event is still sent.) `onDrop` receives the event. |
| `droppedCount` rises and the warning says `rejected` | The ingestor refused the batch (4xx) or specific events | Read the `onError` message — it carries the ingestor's `errors[].message`. |

## What this guide does NOT cover

- **Mosquitto / non-Aedes brokers.** Broker mode targets the Aedes event surface. A different broker needs the client-proxy mode, or your own adapter calling the same event shape.
- **Per-subscriber fan-out by default.** See Step 4 — opt in with `emitDeliverEvents`.
- **Rating, invoicing, plan config.** Those live in the Aforo console (use `mqttQos` / `mqttRetained` in filter conditions for tiered pricing).
- **Durable delivery.** The queue is in memory: an ingestor outage is ridden out up to `maxQueueSize`, but a crash loses what is queued; see Step 6.
