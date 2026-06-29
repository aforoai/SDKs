# @aforo/ws-metering

Meter WebSocket connections into Aforo — open, close, bytes, frame counts, and duration — by wrapping a `ws` server, or by tracking any connection that exposes the standard WebSocket event surface (Fastify-WebSocket, Socket.io, Deno, Bun).

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install (once published):

```bash
npm i @aforo/ws-metering ws
```

> **Not yet on the public npm registry — install from source for now.** `ws` (`^8`) is an **optional** peer dependency — needed only if you use `wrapServer`. `trackConnection` works with any compatible socket.

```bash
# from the SDKs repo root
cd aforo-metering-sdks/node-ws
npm install
npm run build          # tsc → dist/

# then, from YOUR app
npm install /absolute/path/to/aforo-metering-sdks/node-ws
npm install ws         # only if you use wrapServer
```

## Quickstart

```ts
import { WebSocketServer } from 'ws';
import { AforoWsBilling } from '@aforo/ws-metering';

const billing = new AforoWsBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_ws_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingest.aforo.ai', // SDK appends /v1/ingest/events
});

const wss = new WebSocketServer({ port: 8080 });
billing.wrapServer(wss, {
  extractCustomerId: (req) => req.headers['x-customer-id'] as string,
});

process.on('SIGTERM', async () => { await billing.shutdown(); });
```

For frameworks that don't expose a `ws`-style server, track each socket directly:

```ts
billing.trackConnection(socket, { customerId: 'cust_001', metadata: { feed: 'market' } });
```

By default the SDK emits two events per connection — `CONNECTION_OPENED` on connect and `CONNECTION_CLOSED` on close (the billing anchor, carrying aggregated sent/recv counts + bytes + duration). The close event uses `metricName: "websocket_api.connection_closed"`; open and per-frame events use `websocket_api.message`. Events ship to `POST https://ingest.aforo.ai/v1/ingest/events` with `Authorization: Bearer <api_key>` and `X-Tenant-Id: <tenant_id>`.

> **Per-frame metering is off by default.** Set `perFrameEvents: true` to emit one event per inbound and outbound frame — high volume, so size your batching accordingly. With it off, individual frames are still counted and rolled into the `CONNECTION_CLOSED` event.

## Configuration

`new AforoWsBilling(config)` — `tenantId`, `productId`, `apiKey`, and `ingestorUrl` are required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. Never read from a client header. |
| `productId` | `string` | — (required) | Aforo product id; into each event's `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent as `Authorization: Bearer <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Ingestion base URL. SDK appends `/v1/ingest/events`. Use `https://ingest.aforo.ai`. |
| `perFrameEvents` | `boolean` | `false` | Emit one event per frame (each direction). Off → frames are aggregated into the close event only. |
| `flushCount` | `number` | `100` | Buffered events that trigger an immediate flush. Higher default than the base SDK — WS is high-volume. |
| `flushIntervalMs` | `number` | `3000` | Max ms before a partial batch is flushed. |
| `onError` | `(error: Error) => void` | logs to `console.error` | Called when a flush fails terminally (after 3 retries). |

`wrapServer(wss, options)` / `trackConnection(ws, opts)` take the customer resolver:

| Option | Where | Type | What it does |
|---|---|---|---|
| `extractCustomerId` | `wrapServer` | `(req) => string \| undefined` | Resolve the customer from the upgrade request. `undefined` → connection is not metered. |
| `extractMetadata` | `wrapServer` | `(req) => Record<string, unknown> \| undefined` | Optional per-connection tags. |
| `customerId` | `trackConnection` | `string` | Customer to attribute all traffic on this socket to. |
| `metadata` | `trackConnection` | `Record<string, unknown>` | Optional per-connection tags. |

Close codes map to labels via `WS_CLOSE_REASONS` — `1000 → NORMAL_CLOSURE`, `1006 → ABNORMAL_CLOSURE`, `1009 → MESSAGE_TOO_BIG`, `4000 → IDLE_TIMEOUT`, etc. A socket `error` emits a synthetic `CONNECTION_CLOSED` with `wsCloseReason: INTERNAL_ERROR` and `metadata.event: CONNECTION_ERROR`.

Exported symbols: `AforoWsBilling` (with `wrapServer` / `trackConnection` / `shutdown`), the `WS_CLOSE_REASONS` map, and the `AforoWsConfig` / `WrapServerOptions` types.

## Walk me through it

Step-by-step from install to a verified event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **`send()` is wrapped by reference.** `trackConnection` reassigns `ws.send` to count outbound frames. If another layer wraps `send` afterward, ordering matters.
- **No persistent buffer.** Events are in memory until flushed; a hard crash before flush drops the buffered batch. `shutdown()` covers graceful exit only.
- **Connection identity is per-process.** `wsConnectionId` is a fresh UUID per `trackConnection` call; it does not survive reconnects or correlate across processes.
- **The SDK does not enforce or read pricing.** It emits usage; rating/billing happens in Aforo.
