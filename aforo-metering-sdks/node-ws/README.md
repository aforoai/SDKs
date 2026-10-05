# @aforoai/ws-metering

Meter WebSocket connections into Aforo — open, close, bytes, frame counts, and duration — by wrapping a `ws` server, or by tracking any connection that exposes the standard WebSocket event surface (Fastify-WebSocket, Socket.io, Deno, Bun).

**Version:** 1.2.1 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install (once published):

```bash
npm i @aforoai/ws-metering ws
```

> **Install `1.2.1` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `1.2.1` is not on npm yet, install from source with the steps below. `ws` (`^8`) is an **optional** peer dependency — needed only if you use `wrapServer`. `trackConnection` works with any compatible socket.

```bash
# from the SDKs repo root
cd SDKs/aforo-metering-sdks/node-ws
npm install
npm run build          # tsc → dist/

# then, from YOUR app
npm install /absolute/path/to/aforo-metering-sdks/node-ws
npm install ws         # only if you use wrapServer
```

## Quickstart

```ts
import { WebSocketServer } from 'ws';
import { AforoWsBilling } from '@aforoai/ws-metering';

const billing = new AforoWsBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_ws_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai', // SDK appends /v1/ingest/batch
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

By default the SDK emits two events per connection — `CONNECTION_OPENED` on connect and `CONNECTION_CLOSED` on close (the billing anchor, carrying aggregated sent/recv counts + bytes + duration). The close event uses `metricName: "websocket_api.connection_closed"`; open and per-frame events use `websocket_api.message`. Events ship to `POST https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`.

> **Per-frame metering is off by default.** Set `perFrameEvents: true` to emit one event per inbound and outbound frame — high volume, so size your batching accordingly. With it off, individual frames are still counted and rolled into the `CONNECTION_CLOSED` event.

## Configuration

`new AforoWsBilling(config)` — `tenantId`, `productId`, `apiKey`, and `ingestorUrl` are required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. Never read from a client header. |
| `productId` | `string` | — (required) | Aforo product id; into each event's `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent as `X-API-Key: <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Ingestion base URL. SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `productType` | `string` | `'WEBSOCKET_API'` | Aforo product type sent as top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override via `wrapServer(wss, { productType })` or `trackConnection(ws, { customerId, productType })`. |
| `perFrameEvents` | `boolean` | `false` | Emit one event per frame (each direction). Off → frames are aggregated into the close event only. |
| `flushCount` | `number` | `100` | Buffered events that trigger an immediate flush. Higher default than the base SDK — WS is high-volume. |
| `flushIntervalMs` | `number` | `3000` | Max ms before a partial batch is flushed. |
| `onError` | `(error: Error) => void` | logs to `console.error` | Called once per delivery problem: a batch dropped after 3 attempts (network errors / 408 / 429 honouring `Retry-After` / 5xx), a batch refused with any other 4xx (not retried; the message includes the ingestor's `errors[].message`), per-event failures reported in a 2xx response, and an unusable `executionStatus`. Exceptions it throws are swallowed. |
| `onDrop` | `(events, reason) => void` | none | Receives events that were permanently dropped, with reason `invalid`, `rejected` or `retry_exhausted`. See [Dropped events](#dropped-events). |

`wrapServer(wss, options)` / `trackConnection(ws, opts)` take the customer resolver:

| Option | Where | Type | What it does |
|---|---|---|---|
| `extractCustomerId` | `wrapServer` | `(req) => string \| undefined` | Resolve the customer from the upgrade request. `undefined` → connection is not metered. |
| `extractMetadata` | `wrapServer` | `(req) => Record<string, unknown> \| undefined` | Optional per-connection tags. |
| `customerId` | `trackConnection` | `string` | Customer to attribute all traffic on this socket to. |
| `metadata` | `trackConnection` | `Record<string, unknown>` | Optional per-connection tags. |
| `productType` | both | `string` | Product type for this server's / socket's events. Default: the client-level `productType`. |

Close codes map to labels via `WS_CLOSE_REASONS` — `1000 → NORMAL_CLOSURE`, `1006 → ABNORMAL_CLOSURE`, `1009 → MESSAGE_TOO_BIG`, `4000 → IDLE_TIMEOUT`, etc. A socket `error` emits a synthetic `CONNECTION_CLOSED` with `wsCloseReason: INTERNAL_ERROR` and `metadata.event: CONNECTION_ERROR`.

Exported symbols: `AforoWsBilling` (with `wrapServer` / `trackConnection` / `shutdown` / `droppedCount`), the `WS_CLOSE_REASONS` map, `DEFAULT_PRODUCT_TYPE`, and the `AforoWsConfig` / `WrapServerOptions` / `TrackConnectionOptions` / `WsUsageEvent` / `DropReason` types.

## Execution status

Outcome-based pricing bills each event at the weight set for its `executionStatus`; events without one bill at full price. The SDK trims and upper-cases the value and leaves the key out of the event when it is unset or blank. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or a Promise returned by an async resolver) is reported through `onError` and left off the event — the event itself is still sent — because the server would reject the event. Resolvers must be synchronous.

`executionStatus` is the outcome of the **connection**: it is set on the closing event only — `CONNECTION_CLOSED`, and the synthetic close emitted on a socket error. `CONNECTION_OPENED` and per-frame `MESSAGE` events never carry it, so a status such as `ERROR` for an abnormal close doesn't make every frame bill at the `ERROR` weight. (This matches the Python SDK; Go and Java take a status per call.)

WebSocket frames carry no success or failure signal, so the SDK never sets `executionStatus` on its own — not even for abnormal closes or socket errors. Pass it yourself, as a string or as a synchronous function called with the closing event:

```typescript
billing.wrapServer(wss, {
  extractCustomerId: (req) => req.headers['x-customer-id'] as string,
  // (event, req) => status | undefined
  executionStatus: (event, req) =>
    event.wsFrameType === 'CLOSE' && event.wsCloseReason !== 'NORMAL_CLOSURE' ? 'ERROR' : undefined,
});

billing.trackConnection(socket, { customerId: 'cust_42', executionStatus: 'SUCCESS' });
```

## Dropped events

The SDK does not throw into your socket handlers for event content. An event that cannot be delivered is counted in `billing.droppedCount`, logged with `console.warn`, and passed to the optional `onDrop(events, reason)` hook. Events handed to the hook keep their `idempotencyKey`, so storing them and re-submitting later is dedup-safe. Exceptions thrown by the hook are swallowed.

| Reason | When |
|---|---|
| `invalid` | The event failed a client-side check and was never buffered or sent: `customerId` longer than 64 characters or `productType` longer than 20 (every event of that connection is counted). Values are never truncated. The warning names the field, the limit and the value (first 80 characters); it is logged for the first occurrence per field and for every 1000th after that. |
| `rejected` | The ingestor refused the batch with a 4xx other than 408 / 429 (not retried), or named individual events in the `errors[]` of a 2xx response — then only those events are dropped. When a 2xx reports `failed > 0` without a usable `index`, the count is added to `droppedCount` and `onDrop` is not called. |
| `retry_exhausted` | Network errors, 408, 429 or 5xx persisted through 3 attempts (1s / 2s / 4s backoff; `Retry-After` honoured up to 30 s). |

A call with no resolvable customer id is not billable; it is skipped and is not counted as a drop.

```ts
const billing = new AforoWsBilling({
  // …
  onDrop: (events, reason) => deadLetterQueue.push({ reason, events }),
});
```

## Walk me through it

Step-by-step from install to a verified event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **`send()` is wrapped by reference.** `trackConnection` reassigns `ws.send` to count outbound frames. If another layer wraps `send` afterward, ordering matters.
- **No persistent buffer.** Events are in memory until flushed; a hard crash before flush drops the buffered batch. `shutdown()` covers graceful exit only.
- **Connection identity is per-process.** `wsConnectionId` is a fresh UUID per `trackConnection` call; it does not survive reconnects or correlate across processes.
- **The SDK does not enforce or read pricing.** It emits usage; rating/billing happens in Aforo.
