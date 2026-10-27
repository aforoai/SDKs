# @aforoai/ws-metering

Meter WebSocket connections into Aforo — open, close, bytes, frame counts, and duration — by wrapping a `ws` server, or by tracking any connection that exposes the standard WebSocket event surface (Fastify-WebSocket, Socket.io, Deno, Bun).

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install (once published):

```bash
npm i @aforoai/ws-metering ws
```

> **Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on npm yet, install from source with the steps below. `ws` (`^8`) is an **optional** peer dependency — needed only if you use `wrapServer`. `trackConnection` works with any compatible socket.

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
  // Who is billed: from identity your app verified on the upgrade request.
  customerResolver: (req) => sessions.customerIdFor(req),
});

// The SDK installs no signal handlers. Flush from your own:
process.once('SIGTERM', async () => {
  await billing.shutdown();
  process.exit(0);
});
```

For frameworks that don't expose a `ws`-style server, track each socket directly:

```ts
billing.trackConnection(socket, { customerId: 'cust_001', metadata: { feed: 'market' } });
```

By default the SDK emits two events per connection — `CONNECTION_OPENED` on connect and `CONNECTION_CLOSED` on close (the billing anchor, carrying aggregated sent/recv counts + bytes + duration). The open event uses `metricName: "websocket_api.connection_opened"` with `wsFrameType: "OPEN"`, the close event `websocket_api.connection_closed`, and per-frame events `websocket_api.message`. A connection still open at `shutdown()` is billed a `CONNECTION_CLOSED` (`GOING_AWAY`, `closedBy: "sdk_shutdown"`), and one with no frame for `connectionIdleTimeoutMs` (default 1 hour) is closed by a sweep (`ABNORMAL_CLOSURE`, `closedBy: "sdk_idle_timeout"`), so every billed open has a close. Events ship to `POST https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`.

> **Per-frame metering is off by default.** Set `perFrameEvents: true` to emit one event per inbound and outbound frame — high volume, so size your batching accordingly. With it off, individual frames are still counted and rolled into the `CONNECTION_CLOSED` event.

## Configuration

`new AforoWsBilling(config)` — `tenantId`, `productId`, `apiKey`, and `ingestorUrl` are required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. Never read from a client header. |
| `productId` | `string` | — (required) | Aforo product id; into each event's `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent only as `X-API-Key: <apiKey>`; never logged or shown by `inspect()` / `JSON.stringify`. |
| `ingestorUrl` | `string` | — (required) | Ingestion base URL, `https://` (see `allowInsecureHttp`). SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `productType` | `string` | `'WEBSOCKET_API'` | Aforo product type sent as top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override via `wrapServer(wss, { productType })` or `trackConnection(ws, { customerId, productType })`. |
| `perFrameEvents` | `boolean` | `false` | Emit one event per frame (each direction). Off → frames are aggregated into the close event only. |
| `connectionIdleTimeoutMs` | `number` | `3600000` | Close (and bill `CONNECTION_CLOSED` for) a connection with no frame for this long, so a socket that died without a close event is not tracked forever. Must be positive. |
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

`wrapServer(wss, options)` / `trackConnection(ws, opts)` take the customer:

| Option | Where | Type | What it does |
|---|---|---|---|
| `customerResolver` | `wrapServer` | `(req) => string \| undefined` | Required (or `trustCustomerHeader`). The Aforo customer id from identity your app verified on the upgrade request. Returning nothing: the connection is not metered and one `invalid` drop is counted; the connection itself is not affected. `extractCustomerId` is a deprecated alias. |
| `trustCustomerHeader` | `wrapServer` | `boolean` | Bill the `x-customer-id` header of the upgrade request. Any client can send that header, so only turn this on behind a proxy you control that sets it. Default `false`; `wrapServer` throws when neither this nor `customerResolver` is given. |
| `extractMetadata` | `wrapServer` | `(req) => Record<string, unknown> \| undefined` | Optional per-connection tags. |
| `customerId` | `trackConnection` | `string` | Customer to attribute all traffic on this socket to. |
| `metadata` | `trackConnection` | `Record<string, unknown>` | Optional per-connection tags. |
| `productType` | both | `string` | Product type for this server's / socket's events. Default: the client-level `productType`. |

Close codes map to labels via `WS_CLOSE_REASONS` — `1000 → NORMAL_CLOSURE`, `1006 → ABNORMAL_CLOSURE`, `1009 → MESSAGE_TOO_BIG`, `4000 → IDLE_TIMEOUT`, etc. A socket `error` emits a synthetic `CONNECTION_CLOSED` with `wsCloseReason: INTERNAL_ERROR` and `metadata.event: CONNECTION_ERROR`; the `close` that follows it is not billed again (one closing event per connection).

Exported symbols: `AforoWsBilling` (with `wrapServer` / `trackConnection` / `flush` / `shutdown` / `droppedCount` / `queuedCount`), the `WS_CLOSE_REASONS` map, `DEFAULT_PRODUCT_TYPE`, and the `AforoWsConfig` / `WrapServerOptions` / `TrackConnectionOptions` / `WsUsageEvent` / `DropReason` types.

## Delivery

One background sender per client sends one request at a time; recording an event only queues it. If the ingestor is unreachable, keeps answering 408/429/5xx after the retries, or answers 401/403 (a wrong or revoked key — logged as an error), the batch goes back to the front of the queue with its idempotency keys and sending pauses (5 s, doubling to 5 min, randomized). New events keep queueing up to `maxQueueSize`; the first successful request resumes sending, and the ingestor deduplicates the re-sent keys. A 413 splits the batch. Request bodies are plain JSON (the ingestor does not decode gzip). `flush()` sends what is queued now; `shutdown()` sends for at most `shutdownTimeoutMs` — call it from your own SIGTERM handler.

## Execution status

Outcome-based pricing bills each event at the weight set for its `executionStatus`; events without one bill at full price. The SDK trims and upper-cases the value and leaves the key out of the event when it is unset or blank. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or a Promise returned by an async resolver) is reported through `onError` and left off the event — the event itself is still sent — because the server would reject the event. Resolvers must be synchronous.

`executionStatus` is the outcome of the **connection**: it is set on the closing event only — `CONNECTION_CLOSED`, and the synthetic close emitted on a socket error. `CONNECTION_OPENED` and per-frame `MESSAGE` events never carry it, so a status such as `ERROR` for an abnormal close doesn't make every frame bill at the `ERROR` weight. (This matches the Python SDK; Go and Java take a status per call.)

WebSocket frames carry no success or failure signal, so the SDK never sets `executionStatus` on its own — not even for abnormal closes or socket errors. Pass it yourself, as a string or as a synchronous function called with the closing event:

```typescript
billing.wrapServer(wss, {
  customerResolver: (req) => sessions.customerIdFor(req),
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
| `invalid` | The customer resolver returned nothing (one event per connection), or the event failed a client-side check and was never queued or sent: `customerId` longer than 64 characters or `productType` longer than 20 (every event of that connection is counted). Values are never truncated. The warning names the field, the limit and the value (first 80 characters); it is logged for the first invalid event and for every 1000th after that. |
| `rejected` | The ingestor refused the batch with a 4xx other than 408 / 429 (not retried), or named individual events in the `errors[]` of a 2xx response — then only those events are dropped. When a 2xx reports `failed > 0` without a usable `index`, the count is added to `droppedCount` and `onDrop` is not called. |
| `overflow` | The queue (`maxQueueSize`) was full and the oldest event was evicted. |
| `shutdown` | Still queued when `shutdownTimeoutMs` ran out (also reported through `onError`). |
| `closed` | Recorded after `shutdown()`. |
| `retry_exhausted` | Not produced by 2.x (kept in the type): an outage keeps events queued instead of dropping them. |

A connection with no resolvable customer is not metered and is counted as one `invalid` drop.

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
- **No persistent buffer.** Events are in memory until sent; a hard crash loses what is queued. `shutdown()` covers graceful exit only.
- **Connection identity is per-process.** `wsConnectionId` is a fresh UUID per `trackConnection` call; it does not survive reconnects or correlate across processes.
- **The SDK does not enforce or read pricing.** It emits usage; rating/billing happens in Aforo.
