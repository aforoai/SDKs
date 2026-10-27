# @aforoai/ws-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Node.js engineers running a WebSocket server (`ws`, Fastify-WebSocket, Socket.io, Deno, Bun) who need per-connection usage metered into Aforo.

## What you'll build

A WebSocket server that emits an Aforo usage event when a connection opens and a billing-anchor event when it closes — carrying total frames, bytes, and duration. By the end you'll have opened and closed a metered connection and confirmed the event reached Aforo.

## Prerequisites

- Node.js ≥ 18 (the SDK uses the global `fetch` and `node:crypto`).
- An Aforo API key, a tenant id (`tenant_…`), and a product id.
- A WebSocket server. `ws` is the smoothest path; anything exposing the standard `message`/`close`/`error` events works via `trackConnection`.
- `ws` ^8 installed only if you use `wrapServer` (optional peer dependency).

## Step 1 — Install the SDK

Once published:

```bash
npm i @aforoai/ws-metering ws
```

Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog. If `2.0.0` is not on npm yet, install from source:

```bash
cd SDKs/aforo-metering-sdks/node-ws
npm install
npm run build      # produces dist/

cd /path/to/your-app
npm install /absolute/path/to/aforo-metering-sdks/node-ws
npm install ws     # only if using wrapServer
```

## Step 2 — Create the billing instance

Construct it once at startup. It starts a background flush timer immediately.

```ts
import { AforoWsBilling } from '@aforoai/ws-metering';

const billing = new AforoWsBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_ws_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai', // SDK appends /v1/ingest/batch
});
```

> ⚠ `ingestorUrl` is the **base** URL — the SDK appends `/v1/ingest/batch`. Don't include the path.

## Step 3 — Wrap your server (or track a socket)

**`ws` server** — `wrapServer` hooks the `connection` event and asks your `customerResolver` who to bill. Resolve it from identity your app verified on the upgrade request (a session cookie, a token you checked) — not from a header the client sets:

```ts
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });
billing.wrapServer(wss, {
  customerResolver: (req) => sessions.customerIdFor(req),
  extractMetadata:  (req) => ({ userAgent: req.headers['user-agent'] }),
});

// your own handlers still attach normally
wss.on('connection', (ws) => {
  ws.on('message', (msg) => ws.send(`echo: ${msg}`));
});
```

**Other frameworks** — call `trackConnection` per socket. You resolve the customer yourself:

```ts
fastify.get('/ws', { websocket: true }, (connection, req) => {
  const customerId = resolveCustomerId(req);
  if (!customerId) return;            // skip metering for unauthenticated sockets
  billing.trackConnection(connection.socket, { customerId, metadata: { feed: 'market' } });
});
```

> ⚠ `wrapServer` throws when you give it neither `customerResolver` nor `trustCustomerHeader: true`. A connection your resolver returns nothing for is not metered; it is counted as one `invalid` drop (`billing.droppedCount`) and the socket is unaffected.
>
> Behind a proxy that sets `x-customer-id` and strips any client copy, `trustCustomerHeader: true` bills that header instead. Without such a proxy any client could bill another customer.

## Step 4 — Decide on per-frame metering

By default you get two events per connection: `CONNECTION_OPENED` and `CONNECTION_CLOSED`. The close event is the billing anchor — it carries `messageCount` (sent + recv), `dataBytes` (sent + recv), `executionDurationMs`, and `wsCloseReason`. Individual frames are still counted; they're rolled into that close event.

If you need an event per frame (for per-frame analytics or per-message pricing surfaced at frame granularity), turn it on — and raise your batch ceiling, because this is ~10× the volume:

```ts
new AforoWsBilling({ /* … */, perFrameEvents: true, flushCount: 1000, maxQueueSize: 50_000 });
```

## Step 5 — Open and exercise a connection

```bash
# requires `npm i -g wscat`
wscat -c ws://localhost:8080   # authenticate the way your resolver expects
# then type a message and press enter; you'll get the echo back
# close the connection (Ctrl-C) to fire CONNECTION_CLOSED
```

What lands:
- on open → `CONNECTION_OPENED` (`websocket_api.connection_opened`, `wsFrameType: "OPEN"`, `messageCount: 0`)
- on close → `CONNECTION_CLOSED` (`websocket_api.connection_closed`) with the aggregated counters and `wsCloseReason` (e.g. `NORMAL_CLOSURE`)

## Step 6 — Flush and verify it landed in Aforo

Events queue until `flushCount` (500) are waiting or `flushIntervalMs` (5000) passes; one background sender ships them. The SDK installs no signal handlers — call `shutdown()` from yours. It sends what is queued for at most `shutdownTimeoutMs` (5 s) and reports anything left with reason `shutdown`:

```ts
process.once('SIGTERM', async () => {
  await billing.shutdown();
  process.exit(0);
});
```

> ⚠ Without `shutdown()`, a process killed by a signal loses what is queued. A process that ends on its own sends it on `beforeExit`.

The batch is POSTed to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <your api key>` and `X-Tenant-Id: tenant_acme`. Confirm in the Aforo console under the product's usage events (filter `productType = WEBSOCKET_API`). Network errors, timeouts, 408, 429 (honouring `Retry-After`) and 5xx are retried 3× with randomized backoff; after that — or on 401/403 — the batch stays queued and is re-sent when the ingestor recovers. Any other 4xx is not retried. `onError` fires on refused batches, on an outage (once), and on events lost at the shutdown deadline — log it:

```ts
new AforoWsBilling({ /* … */, onError: (err) => myLogger.error('aforo ws flush failed', err) });
```

## Outcomes and dropped events

- **`executionStatus`** — the outcome used by outcome-based pricing. How this SDK sets it, the accepted values and how to override it: [README → Execution status](README.md#execution-status).
- **Dropped events** — the SDK does not throw into your socket handlers for event content. Events it cannot deliver are counted in `billing.droppedCount`, logged with `console.warn`, and passed to `onDrop(events, reason)`. The reasons (`invalid`, `rejected`, `overflow`, `shutdown`, `closed`) and what triggers each: [README → Dropped events](README.md#dropped-events).

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. |
| `productId` | `string` | — (required) | Aforo product id; into `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent only as `X-API-Key: <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Base URL, `https://`; SDK appends `/v1/ingest/batch`. |
| `productType` | `string` | `'WEBSOCKET_API'` | Top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override via `wrapServer(wss, { productType })` or `trackConnection(ws, { customerId, productType })`. |
| `perFrameEvents` | `boolean` | `false` | One event per frame vs. aggregate-on-close only. |
| `connectionIdleTimeoutMs` | `number` | `3600000` | Close a connection with no frame for this long (`ABNORMAL_CLOSURE`, `closedBy: "sdk_idle_timeout"`). |
| `allowInsecureHttp` | `boolean` | `false` | Accept a plain `http://` `ingestorUrl` on a non-local host. `https://` is required otherwise (plain http is fine for `localhost`, `127.0.0.1`, `::1`). |
| `flushCount` | `number` | `500` | Events per request (max 1000). Reaching it wakes the background sender; recording an event never sends by itself. |
| `flushIntervalMs` | `number` | `5000` | The background sender also runs this often. |
| `maxQueueSize` | `number` | `10000` | Queue capacity. When it is full — usually during a long outage — the oldest event is dropped with reason `overflow`. |
| `maxRetries` | `number` | `3` | Retries per batch on network errors, timeouts, 408, 429 and 5xx, with full-jitter backoff (`Retry-After` in seconds or as a date is honoured, capped at 60 s). |
| `timeoutMs` | `number` | `10000` | Total deadline per request. |
| `shutdownTimeoutMs` | `number` | `5000` | How long `shutdown()` keeps sending. Events still queued then are dropped with reason `shutdown`. |
| `flushOnExit` | `boolean` | `true` | Send queued events on the process `beforeExit` event, within `shutdownTimeoutMs`. The SDK installs no signal handlers. |
| `onError` | `(error: Error) => void` | logs to `console.error` | Called for delivery problems: a batch the ingestor refused (the message includes its `errors[].message`), an ingestor outage (once per outage), events lost at the shutdown deadline, and an unusable `executionStatus`. Exceptions it throws are caught. Delivery reports are a `CoreTransportError`: branch on `err.kind` (`outage`, `auth`, `rejected`, `shutdown`, `closed`) and read `err.events`, not the message. |
| `onDrop` | `(events, reason) => void` | none | Receives events lost for good. See [Dropped events](#dropped-events). |
| `customerResolver` | `(req) => string \| undefined` | — (`wrapServer`, required unless `trustCustomerHeader`) | The customer from identity you verified on the upgrade request. `extractCustomerId` is a deprecated alias. |
| `trustCustomerHeader` | `boolean` | `false` (`wrapServer`) | Bill the `x-customer-id` upgrade header. Only behind a proxy you control. |
| `extractMetadata` | `(req) => Record<string, unknown> \| undefined` | `undefined` (`wrapServer`) | Optional per-connection tags. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events for a connection, `droppedCount` rises (`invalid`) | `customerResolver` returned nothing | Make the resolver return the customer for authenticated sockets, or pass `customerId` to `trackConnection`. |
| `wrapServer needs a customerResolver` at startup | 2.0 removed the implicit customer lookup | Pass `customerResolver`, or `trustCustomerHeader: true` behind a proxy you control. |
| `must use https://` at startup | `ingestorUrl` is plain http to a remote host | Use https, or `allowInsecureHttp: true` on a private network. |
| Only seeing close events, never per-frame | `perFrameEvents` is off (default) | Set `perFrameEvents: true` and raise `flushCount`. |
| Events stop after a deploy | Process was killed before the queue was sent | Call `await billing.shutdown()` from your `SIGTERM`/`SIGINT` handler. |
| `…/v1/ingest/batch/v1/ingest/batch` in logs | `ingestorUrl` already includes the path | Set `ingestorUrl` to the base host only. |
| `wsCloseReason` is `NORMAL_CLOSURE` for an abnormal drop | Close code `1005`/`1006` maps that way, or no code arrived | Inspect `metadata.closeCode`; abnormal drops show `1006 → ABNORMAL_CLOSURE`. |
| Byte counts look low | `estimateBytes` only sizes strings/Buffers/typed arrays | Send standard frame payloads; exotic payload types size to 0. |
| `Aforo ingestor unavailable` in `onError` | Ingestor unreachable, or 401/403 (wrong key) | Events stay queued and are sent on recovery; fix the key for 401/403. Raise `maxQueueSize` for long outages. |
| `droppedCount` rises and the warning says `invalid` | An event failed a client-side check (`customerId` longer than 64 characters or `productType` longer than 20) | Fix the value named in the warning; over-limit values are not truncated. `onDrop` receives the event. |
| `droppedCount` rises and the warning says `rejected` | The ingestor refused the batch (4xx) or specific events | Read the `onError` message — it carries the ingestor's `errors[].message`. |

## What this guide does NOT cover

- **Reconnect correlation.** Each tracked connection gets a fresh `wsConnectionId`; reconnects are separate connections.
- **Cross-process aggregation.** Counters are per-process, per-connection.
- **Rating, invoicing, plan config.** Those live in the Aforo console.
- **Durable delivery.** The queue is in memory: an ingestor outage is ridden out up to `maxQueueSize`, but a crash loses what is queued; see Step 6.
