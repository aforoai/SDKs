# @aforo/ws-metering

Aforo WebSocket Metering SDK for Node.js. Wraps WebSocket server connections to meter the handshake, frames, bytes, and total connection duration. Works with `ws`, `fastify-websocket`, `@fastify/websocket`, `Socket.io`, `uWebSockets.js`, Deno, and Bun.

## Install

```bash
npm install @aforo/ws-metering ws
```

## Usage

### `ws` (standard Node.js)

```ts
import { WebSocketServer } from 'ws';
import { AforoWsBilling } from '@aforo/ws-metering';

const billing = new AforoWsBilling({
  tenantId: process.env.AFORO_TENANT_ID!,
  productId: 'prod_ws_market_feed',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingestor.aforo.ai',
});

const wss = new WebSocketServer({ port: 8080 });

billing.wrapServer(wss, {
  extractCustomerId: (req) => req.headers['x-customer-id'] as string,
  extractMetadata: (req) => ({ userAgent: req.headers['user-agent'] }),
});

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    ws.send(`echo: ${msg}`);
  });
});
```

### Fastify WebSocket / Socket.io / custom

Use the lower-level `trackConnection` directly:

```ts
import { AforoWsBilling } from '@aforo/ws-metering';
const billing = new AforoWsBilling({ /* ... */ });

fastify.get('/ws', { websocket: true }, (connection, req) => {
  const customerId = resolveCustomerId(req);
  if (!customerId) return;
  billing.trackConnection(connection.socket, { customerId });
});
```

## Event strategy

By default the SDK emits **one billing anchor per connection**:

- `CONNECTION_OPENED` — on upgrade complete, with `messageCount=0, dataBytes=0`
- `CONNECTION_CLOSED` — on close, with aggregated `messageCount` (sent + received), `dataBytes` (sent + received), `durationMs`, and `wsCloseReason` mapped from the standard close code

This is the recommended mode for most products — one billing event per connection is sufficient for per-connection-minute or per-message pricing, and avoids flooding the ingestor.

For per-frame analytics, set `perFrameEvents: true`:

```ts
new AforoWsBilling({ /* ... */, perFrameEvents: true });
```

This emits one event per frame (inbound and outbound) in addition to the open/close anchors — ~10× the event volume but enables per-frame filtering and analytics.

## Close reason mapping

Close codes → descriptor enum labels:

| Code | Label |
|------|-------|
| 1000 | NORMAL_CLOSURE |
| 1001 | GOING_AWAY |
| 1002 | PROTOCOL_ERROR |
| 1006 | ABNORMAL_CLOSURE |
| 1008 | POLICY_VIOLATION |
| 1009 | MESSAGE_TOO_BIG |
| 1011 | INTERNAL_ERROR |
| 4000+ | IDLE_TIMEOUT (app-defined range) |

Connections that throw an error (socket error, not clean close) emit a synthetic `CONNECTION_CLOSED` with `wsCloseReason=INTERNAL_ERROR` and `event: CONNECTION_ERROR` in metadata.

## Batching & retry

Buffers up to 100 events / 3 seconds by default (more aggressive than HTTP SDKs because WebSocket traffic is high-volume). 3× exponential retry, then `onError`.

## License

MIT
