# @aforo/ws-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Node.js engineers running a WebSocket server (`ws`, Fastify-WebSocket, Socket.io, Deno, Bun) who need per-connection usage metered into Aforo.

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
npm i @aforo/ws-metering ws
```

It isn't on npm yet. Build from source and link it:

```bash
cd aforo-metering-sdks/node-ws
npm install
npm run build      # produces dist/

cd /path/to/your-app
npm install /absolute/path/to/aforo-metering-sdks/node-ws
npm install ws     # only if using wrapServer
```

## Step 2 — Create the billing instance

Construct it once at startup. It starts a background flush timer immediately.

```ts
import { AforoWsBilling } from '@aforo/ws-metering';

const billing = new AforoWsBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_ws_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingest.aforo.ai', // SDK appends /v1/ingest/events
});
```

> ⚠ `ingestorUrl` is the **base** URL — the SDK appends `/v1/ingest/events`. Don't include the path.

## Step 3 — Wrap your server (or track a socket)

**`ws` server** — `wrapServer` hooks the `connection` event and resolves the customer from the upgrade request:

```ts
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });
billing.wrapServer(wss, {
  extractCustomerId: (req) => req.headers['x-customer-id'] as string,
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

> ⚠ A connection with no resolvable customer id is **silently skipped** — `wrapServer` returns early when `extractCustomerId` yields `undefined`. That's correct for unauthenticated or health sockets.

## Step 4 — Decide on per-frame metering

By default you get two events per connection: `CONNECTION_OPENED` and `CONNECTION_CLOSED`. The close event is the billing anchor — it carries `messageCount` (sent + recv), `dataBytes` (sent + recv), `durationMs`, and `wsCloseReason`. Individual frames are still counted; they're rolled into that close event.

If you need an event per frame (for per-frame analytics or per-message pricing surfaced at frame granularity), turn it on — and raise your batch ceiling, because this is ~10× the volume:

```ts
new AforoWsBilling({ /* … */, perFrameEvents: true, flushCount: 500 });
```

## Step 5 — Open and exercise a connection

```bash
# requires `npm i -g wscat`
wscat -c ws://localhost:8080 -H 'x-customer-id: cust_demo_001'
# then type a message and press enter; you'll get the echo back
# close the connection (Ctrl-C) to fire CONNECTION_CLOSED
```

What lands:
- on open → `CONNECTION_OPENED` (`websocket_api.message`, `messageCount: 0`)
- on close → `CONNECTION_CLOSED` (`websocket_api.connection_closed`) with the aggregated counters and `wsCloseReason` (e.g. `NORMAL_CLOSURE`)

## Step 6 — Flush and verify it landed in Aforo

Events buffer until `flushCount` (100) or `flushIntervalMs` (3000) is hit. Force a flush on graceful shutdown:

```ts
process.on('SIGTERM', async () => { await billing.shutdown(); });
process.on('SIGINT',  async () => { await billing.shutdown(); process.exit(0); });
```

> ⚠ Without `shutdown()`, a process that exits inside the 3-second window drops the buffered batch.

The batch is POSTed to `https://ingest.aforo.ai/v1/ingest/events` with `Authorization: Bearer <your api key>` and `X-Tenant-Id: tenant_acme`. Confirm in the Aforo console under the product's usage events (filter `productType = WEBSOCKET_API`). On 3 consecutive failures (1s/2s/4s backoff) the batch is dropped and `onError` fires — log it:

```ts
new AforoWsBilling({ /* … */, onError: (err) => myLogger.error('aforo ws flush failed', err) });
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. |
| `productId` | `string` | — (required) | Aforo product id; into `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent as `Authorization: Bearer <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Base URL; SDK appends `/v1/ingest/events`. |
| `perFrameEvents` | `boolean` | `false` | One event per frame vs. aggregate-on-close only. |
| `flushCount` | `number` | `100` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `number` | `3000` | Max ms before a partial batch is flushed. |
| `onError` | `(error: Error) => void` | `console.error` | Terminal flush-failure callback. |
| `extractCustomerId` | `(req) => string \| undefined` | — (`wrapServer`) | Resolve the customer from the upgrade request. |
| `extractMetadata` | `(req) => Record<string, unknown> \| undefined` | `undefined` (`wrapServer`) | Optional per-connection tags. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events for a connection | `extractCustomerId` returned `undefined` | Send `x-customer-id` on the upgrade request, or resolve it inside `extractCustomerId` / `trackConnection`. |
| Only seeing close events, never per-frame | `perFrameEvents` is off (default) | Set `perFrameEvents: true` and raise `flushCount`. |
| Events stop after a deploy | Process exited before the 3s timer flushed | Call `await billing.shutdown()` on `SIGTERM`/`SIGINT`. |
| `…/v1/ingest/events/v1/ingest/events` in logs | `ingestorUrl` already includes the path | Set `ingestorUrl` to the base host only. |
| `wsCloseReason` is `NORMAL_CLOSURE` for an abnormal drop | Close code `1005`/`1006` maps that way, or no code arrived | Inspect `metadata.closeCode`; abnormal drops show `1006 → ABNORMAL_CLOSURE`. |
| Byte counts look low | `estimateBytes` only sizes strings/Buffers/typed arrays | Send standard frame payloads; exotic payload types size to 0. |
| `onError` firing repeatedly | Wrong `apiKey`/`tenantId`, or ingestor unreachable | Verify credentials and that the host accepts `POST /v1/ingest/events`. |

## What this guide does NOT cover

- **Reconnect correlation.** Each tracked connection gets a fresh `wsConnectionId`; reconnects are separate connections.
- **Cross-process aggregation.** Counters are per-process, per-connection.
- **Rating, invoicing, plan config.** Those live in the Aforo console.
- **Durable delivery.** The buffer is in-memory; see Step 6 for the crash-window caveat.
