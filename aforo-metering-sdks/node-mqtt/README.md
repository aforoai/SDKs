# @aforoai/mqtt-metering

Meter MQTT traffic into Aforo two ways: hook an Aedes broker you operate to meter every PUBLISH/SUBSCRIBE/CONNECT/DISCONNECT, or wrap an `mqtt.js` client to meter what it publishes and receives against a third-party broker (AWS IoT, HiveMQ Cloud, EMQ X Cloud).

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

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

> **Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on npm yet, install from source with the steps below. `aedes` and `mqtt` are **optional** peer dependencies — install only the one your mode needs.

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
  // Who is billed: the customer for the client your broker authenticated.
  customerResolver: async (clientId, username) => customerStore.byClientId(clientId),
  resolveMetadata: (clientId) => ({ deviceClass: deviceRegistry.classOf(clientId) }),
});

createServer(broker.handle).listen(1883);

// The SDK installs no signal handlers. Flush from your own:
process.once('SIGTERM', async () => {
  await billing.shutdown();
  process.exit(0);
});
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
| `apiKey` | `string` | — (required) | Sent only as `X-API-Key: <apiKey>`; never logged or shown by `inspect()` / `JSON.stringify`. |
| `ingestorUrl` | `string` | — (required) | Ingestion base URL, `https://` (see `allowInsecureHttp`). SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `productType` | `string` | `'MQTT_BROKER'` | Aforo product type sent as top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override via `wrapAedesBroker(broker, { productType })` or `wrapMqttClient(client, { customerId, productType })`. |
| `emitDeliverEvents` | `boolean` | `false` | Emit a `DELIVER` event per fan-out delivery. Off → `DELIVER` events are dropped (both modes). |
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

Mode-specific options:

| Option | Mode | Type | What it does |
|---|---|---|---|
| `customerResolver` | broker | `(clientId, username?) => string \| undefined \| Promise<…>` | Required (or `trustCustomerHeader`). Map the client your broker authenticated to an Aforo customer. Returning nothing: that event is not metered and is counted as an `invalid` drop. A throw or rejection is reported through `onError` and treated the same way — never an unhandled rejection. `resolveCustomerId` is a deprecated alias. |
| `trustCustomerHeader` | broker | `boolean` | Bill the MQTT username sent at CONNECT. A client chooses its own username, so only turn this on when your broker authenticates it. Default `false`; `wrapAedesBroker` throws when neither this nor `customerResolver` is given. |
| `resolveMetadata` | broker | `(clientId) => Record<string, unknown> \| undefined` | Optional per-client tags. |
| `customerId` | client | `string` | Customer to attribute all traffic on this client to. |
| `clientId` | client | `string` | Fixed client id (defaults to `client.options.clientId`, then `'mqtt-client'`). |
| `productType` | both | `string` | Product type for this broker's / client's events. Default: the client-level `productType`. |

Every event carries `mqttQos` (0/1/2) and `mqttRetained` — use them in Aforo rate-plan filter conditions to price QoS ≥ 1 or retained messages separately.

Exported symbols: `AforoMqttBilling` (with `wrapAedesBroker` / `wrapMqttClient` / `shutdown` / `droppedCount`), `mqttConnectTopic` / `mqttDisconnectTopic`, `DEFAULT_PRODUCT_TYPE`, `DEFAULT_RECONNECT_DEBOUNCE_MS`, `CoreTransportError` (with the `CoreErrorKind` type), and the `AforoMqttConfig` / `AedesBrokerOptions` / `MqttClientOptions` / `MqttUsageEvent` / `DropReason` types.

## Delivery

One background sender per client sends one request at a time; recording an event only queues it. If the ingestor is unreachable, keeps answering 408/429/5xx after the retries, or answers 401/403 (a wrong or revoked key — logged as an error), the batch goes back to the front of the queue with its idempotency keys and sending pauses (5 s, doubling to 5 min, randomized). New events keep queueing up to `maxQueueSize`; the first successful request resumes sending, and the ingestor deduplicates the re-sent keys. A 413 splits the batch. Batches of 1 KiB or more are sent gzip-encoded (`Content-Encoding: gzip`, needs usage-ingestor wave 8 or later); set `compression: 'none'` to always send plain JSON. `flush()` sends what is queued now; `shutdown()` sends for at most `shutdownTimeoutMs` — call it from your own SIGTERM handler.

## Execution status

Outcome-based pricing bills each event at the weight set for its `executionStatus`; events without one bill at full price. The SDK trims and upper-cases the value and leaves the key out of the event when it is unset or blank. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or a Promise returned by an async resolver) is reported through `onError` and left off the event — the event itself is still sent — because the server would reject the event. Resolvers must be synchronous.

The SDK never sets `executionStatus` on its own: the broker hook sees no success or failure signal, and a client publish is metered only after it succeeded, so there is no failure for the SDK to read. Pass it yourself, as a string or as a function called for each event:

```typescript
billing.wrapAedesBroker(broker, {
  customerResolver: (clientId) => customerIdLookup(clientId),
  // (event, clientId) => status | undefined
  executionStatus: (event) => (event.mqttTopic.startsWith('alerts/') ? 'SUCCESS' : undefined),
});

billing.wrapMqttClient(client, { customerId: 'cust_42', executionStatus: 'SUCCESS' });
```

## Dropped events

The SDK does not throw into your broker or client handlers for event content. An event that cannot be delivered is counted in `billing.droppedCount`, logged with `console.warn`, and passed to the optional `onDrop(events, reason)` hook. Events handed to the hook keep their `idempotencyKey`, so storing them and re-submitting later is dedup-safe. Exceptions thrown by the hook are swallowed.

| Reason | When |
|---|---|
| `invalid` | The customer resolver returned nothing or failed, or the event failed a client-side check and was never queued or sent: `customerId` longer than 64 characters, a missing or whitespace-only `mqttTopic`, or `productType` longer than 20. These are never truncated. A topic longer than 500 characters, or a client id longer than 128, is not a drop: it is cut to the limit and the event is sent (one warning per label). The warning names the field, the limit and the value (first 80 characters); it is logged for the first invalid event and for every 1000th after that. |
| `rejected` | The ingestor refused the batch with a 4xx other than 408 / 429 (not retried), or named individual events in the `errors[]` of a 2xx response — then only those events are dropped. When a 2xx reports `failed > 0` without a usable `index`, the count is added to `droppedCount` and `onDrop` is not called. |
| `overflow` | The queue (`maxQueueSize`) was full and the oldest event was evicted. |
| `shutdown` | Still queued when `shutdownTimeoutMs` ran out (also reported through `onError`). |
| `closed` | Recorded after `shutdown()`. |
| `retry_exhausted` | Not produced by 2.x (kept in the type): an outage keeps events queued instead of dropping them. |

An event with no resolvable customer is not metered and is counted as an `invalid` drop.

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
- **Client-mode PUBLISH is billed after success.** `wrapMqttClient` meters a publish when mqtt.js reports it succeeded: on the broker's PUBACK/PUBCOMP for QoS 1/2, after the socket write for QoS 0. A publish that throws or whose callback gets an error is not billed. `publishAsync()` is covered too.
- **Reconnects are one session.** mqtt.js reconnects on its own; a connection that comes back within `reconnectDebounceMs` (default 30 s) bills no new CONNECT and no DISCONNECT, and failed reconnect attempts bill nothing. A clean `client.end()` bills DISCONNECT at once. On the broker, the same rule applies per client id: a client that drops without a DISCONNECT packet and reconnects (or takes over its own session) inside the window is one session. `shutdown()` bills any DISCONNECT still waiting.
- **No persistent buffer.** Events are in memory until sent; a hard crash loses what is queued. `shutdown()` covers graceful exit only.
- **The SDK does not enforce or read pricing.** It emits usage; rating/billing happens in Aforo.
