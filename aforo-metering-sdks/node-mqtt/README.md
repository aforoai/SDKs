# @aforoai/mqtt-metering

Meter MQTT traffic into Aforo two ways: hook an Aedes broker you operate to meter every PUBLISH/SUBSCRIBE/CONNECT/DISCONNECT, or wrap an `mqtt.js` client to meter what it publishes and receives against a third-party broker (AWS IoT, HiveMQ Cloud, EMQ X Cloud).

**Version:** 1.2.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

| Mode | When to use | Entry point |
|---|---|---|
| **Broker hook** | You run the broker (Aedes) and want to meter every client's events | `wrapAedesBroker(broker, options)` |
| **Client proxy** | You consume a third-party broker and want client-side billing | `wrapMqttClient(client, options)` |

## Install

Intended public install (once published):

```bash
npm i @aforoai/mqtt-metering aedes   # broker mode
# or
npm i @aforoai/mqtt-metering mqtt    # client mode
```

> **Install `1.2.2` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `1.2.2` is not on npm yet, install from source with the steps below. `aedes` and `mqtt` are **optional** peer dependencies — install only the one your mode needs.

```bash
# from the SDKs repo root
cd SDKs/aforo-metering-sdks/node-mqtt
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
import { AforoMqttBilling } from '@aforoai/mqtt-metering';

const billing = new AforoMqttBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_mqtt_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai', // SDK appends /v1/ingest/batch
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
import { AforoMqttBilling } from '@aforoai/mqtt-metering';

const billing = new AforoMqttBilling({ tenantId: 'tenant_acme', productId: 'prod_mqtt_001', apiKey: process.env.AFORO_API_KEY!, ingestorUrl: 'https://api.aforo.ai' });
const client = mqtt.connect('mqtts://broker.example.com', { clientId: `device-${deviceId}` });

billing.wrapMqttClient(client, { customerId: 'cust_acme_001' });
```

Each event uses `metricName: "mqtt_broker.<event>"` (`mqtt_broker.publish`, `mqtt_broker.subscribe`, …) with `quantity: 1`, and carries `mqttTopic`, `mqttQos`, `mqttRetained`, `mqttClientId`, and `dataBytes`. Events ship to `POST https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`.

> **`DELIVER` (fan-out) events are dropped unless `emitDeliverEvents: true`.** This gate applies in **both** modes — client-mode inbound `message` deliveries and any broker delivery path are skipped by default because fan-out is high-volume. `PUBLISH`, `SUBSCRIBE`, `UNSUBSCRIBE`, `CONNECT`, and `DISCONNECT` are always metered.

## Configuration

`new AforoMqttBilling(config)` — `tenantId`, `productId`, `apiKey`, and `ingestorUrl` are required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. Never read from a client header. |
| `productId` | `string` | — (required) | Aforo product id; into each event's `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent as `X-API-Key: <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Ingestion base URL. SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `productType` | `string` | `'MQTT_BROKER'` | Aforo product type sent as top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override via `wrapAedesBroker(broker, { productType })` or `wrapMqttClient(client, { customerId, productType })`. |
| `emitDeliverEvents` | `boolean` | `false` | Emit a `DELIVER` event per fan-out delivery. Off → `DELIVER` events are dropped (both modes). |
| `flushCount` | `number` | `200` | Buffered events that trigger an immediate flush. Highest default of the SDKs — MQTT is very high-volume. |
| `flushIntervalMs` | `number` | `2000` | Max ms before a partial batch is flushed. |
| `onError` | `(error: Error) => void` | logs to `console.error` | Called once per delivery problem: a batch dropped after 3 attempts (network errors / 408 / 429 honouring `Retry-After` / 5xx), a batch refused with any other 4xx (not retried; the message includes the ingestor's `errors[].message`), per-event failures reported in a 2xx response, and an unusable `executionStatus`. Exceptions it throws are swallowed. |
| `onDrop` | `(events, reason) => void` | none | Receives events that were permanently dropped, with reason `invalid`, `rejected` or `retry_exhausted`. See [Dropped events](#dropped-events). |

Mode-specific options:

| Option | Mode | Type | What it does |
|---|---|---|---|
| `resolveCustomerId` | broker | `(clientId, username?) => string \| undefined \| Promise<…>` | Required. Map an MQTT client id to a customer. `undefined` → that client's events are not metered. |
| `resolveMetadata` | broker | `(clientId) => Record<string, unknown> \| undefined` | Optional per-client tags. |
| `customerId` | client | `string` | Customer to attribute all traffic on this client to. |
| `clientId` | client | `string` | Fixed client id (defaults to `client.options.clientId`, then `'mqtt-client'`). |
| `productType` | both | `string` | Product type for this broker's / client's events. Default: the client-level `productType`. |

Every event carries `mqttQos` (0/1/2) and `mqttRetained` — use them in Aforo rate-plan filter conditions to price QoS ≥ 1 or retained messages separately.

Exported symbols: `AforoMqttBilling` (with `wrapAedesBroker` / `wrapMqttClient` / `shutdown` / `droppedCount`), `mqttConnectTopic` / `mqttDisconnectTopic`, `DEFAULT_PRODUCT_TYPE`, and the `AforoMqttConfig` / `AedesBrokerOptions` / `MqttClientOptions` / `MqttUsageEvent` / `DropReason` types.

## Execution status

Outcome-based pricing bills each event at the weight set for its `executionStatus`; events without one bill at full price. The SDK trims and upper-cases the value and leaves the key out of the event when it is unset or blank. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or a Promise returned by an async resolver) is reported through `onError` and left off the event — the event itself is still sent — because the server would reject the event. Resolvers must be synchronous.

The SDK never sets `executionStatus` on its own: the broker hook sees no success or failure signal, and client publishes are metered before the broker acknowledges them. Pass it yourself, as a string or as a function called for each event:

```typescript
billing.wrapAedesBroker(broker, {
  resolveCustomerId: (clientId) => customerIdLookup(clientId),
  // (event, clientId) => status | undefined
  executionStatus: (event) => (event.mqttTopic.startsWith('alerts/') ? 'SUCCESS' : undefined),
});

billing.wrapMqttClient(client, { customerId: 'cust_42', executionStatus: 'SUCCESS' });
```

## Dropped events

The SDK does not throw into your broker or client handlers for event content. An event that cannot be delivered is counted in `billing.droppedCount`, logged with `console.warn`, and passed to the optional `onDrop(events, reason)` hook. Events handed to the hook keep their `idempotencyKey`, so storing them and re-submitting later is dedup-safe. Exceptions thrown by the hook are swallowed.

| Reason | When |
|---|---|
| `invalid` | The event failed a client-side check and was never buffered or sent: `customerId` longer than 64 characters, a missing or whitespace-only `mqttTopic`, or `productType` longer than 20. These are never truncated. A topic longer than 500 characters, or a client id longer than 128, is not a drop: it is cut to the limit and the event is sent (one warning per label). The warning names the field, the limit and the value (first 80 characters); it is logged for the first occurrence per field and for every 1000th after that. |
| `rejected` | The ingestor refused the batch with a 4xx other than 408 / 429 (not retried), or named individual events in the `errors[]` of a 2xx response — then only those events are dropped. When a 2xx reports `failed > 0` without a usable `index`, the count is added to `droppedCount` and `onDrop` is not called. |
| `retry_exhausted` | Network errors, 408, 429 or 5xx persisted through 3 attempts (1s / 2s / 4s backoff; `Retry-After` honoured up to 30 s). |

A call with no resolvable customer id is not billable; it is skipped and is not counted as a drop.

```ts
const billing = new AforoMqttBilling({
  // …
  onDrop: (events, reason) => deadLetterQueue.push({ reason, events }),
});
```

## Walk me through it

Step-by-step from install to a verified event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Fan-out billing is opt-in.** `DELIVER` events are dropped unless `emitDeliverEvents: true`. Default metering counts the PUBLISH, not the per-subscriber fan-out.
- **CONNECT/DISCONNECT have no MQTT topic.** Because the ingestor requires `mqttTopic`, they are sent with `$SYS/clients/<clientId>/connected` and `$SYS/clients/<clientId>/disconnected`. `$SYS/` is reserved for brokers, so these topics can't collide with a real one.
- **Client-mode CONNECT/DISCONNECT use socket lifecycle.** `wrapMqttClient` maps `connect`/`close`; a client that reconnects emits a CONNECT each time.
- **No persistent buffer.** Events are in memory until flushed; a hard crash before flush drops the buffered batch. `shutdown()` covers graceful exit only.
- **The SDK does not enforce or read pricing.** It emits usage; rating/billing happens in Aforo.
