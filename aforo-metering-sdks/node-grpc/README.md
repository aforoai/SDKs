# @aforo/grpc-metering

Wrap your `@grpc/grpc-js` server handlers and get one Aforo usage event per RPC — unary, server-stream, client-stream, or bidi — with status code, call type, message count, and duration attached. Your handler logic stays untouched.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install (once published):

```bash
npm i @aforo/grpc-metering @grpc/grpc-js
```

> **Not yet on the public npm registry — install from source for now.** `@grpc/grpc-js` (`^1.9`) is a peer dependency; install it in your app.

```bash
# from the SDKs repo root
cd aforo-metering-sdks/node-grpc
npm install
npm run build          # tsc → dist/

# then, from YOUR app
npm install /absolute/path/to/aforo-metering-sdks/node-grpc
npm install @grpc/grpc-js   # peer dependency, in your app
```

## Quickstart

```ts
import * as grpc from '@grpc/grpc-js';
import { AforoGrpcBilling } from '@aforo/grpc-metering';
import { UserServiceService } from './generated/user_grpc_pb';

const billing = new AforoGrpcBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_grpc_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingest.aforo.ai', // SDK appends /v1/ingest/events
  serviceName: 'acme.v1.UserService',
});

const server = new grpc.Server();
server.addService(UserServiceService, {
  getUser:     billing.wrapUnary('GetUser', async (call) => ({ id: call.request.getId(), name: 'Jane' })),
  listUsers:   billing.wrapServerStream('ListUsers', async (call) => { call.write({ id: '1' }); call.write({ id: '2' }); }),
  uploadBatch: billing.wrapClientStream('UploadBatch', async (call) => { let n = 0; for await (const _ of call) n++; return { accepted: n }; }),
  chat:        billing.wrapBidiStream('Chat', async (call) => { for await (const m of call) call.write({ reply: `echo: ${m.text}` }); }),
});

// Flush buffered events before the process exits.
process.on('SIGTERM', async () => { await billing.shutdown(); });
```

Each wrapped handler emits one event with `metricName: "grpc_api.rpc_calls"`, `quantity: 1`. Streams emit a single event on stream close carrying the aggregated `messageCount`. The gRPC status code is mapped to a label (`OK`, `NOT_FOUND`, `UNAVAILABLE`, …). Events ship to `POST https://ingest.aforo.ai/v1/ingest/events` with `Authorization: Bearer <api_key>` and `X-Tenant-Id: <tenant_id>`.

## Configuration

`new AforoGrpcBilling(config)` — `tenantId`, `productId`, `apiKey`, `ingestorUrl`, and `serviceName` are required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. Never read from a client header. |
| `productId` | `string` | — (required) | Aforo product id; into each event's `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent as `Authorization: Bearer <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Ingestion base URL. SDK appends `/v1/ingest/events`. Use `https://ingest.aforo.ai`. |
| `serviceName` | `string` | — (required) | Fully-qualified gRPC service name (e.g. `acme.v1.UserService`); stamped on every event as `grpcService`. |
| `customerIdExtractor` | `(metadata: Record<string, unknown>) => string \| undefined` | reads `x-customer-id` from `call.metadata.getMap()` | Resolve the customer per call. `undefined` → call is not metered. |
| `flushCount` | `number` | `50` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `number` | `5000` | Max ms before a partial batch is flushed. |
| `onError` | `(error: Error) => void` | logs to `console.error` | Called when a flush fails terminally (after 3 retries). |

Exported symbols: `AforoGrpcBilling` (with `wrapUnary` / `wrapServerStream` / `wrapClientStream` / `wrapBidiStream` / `shutdown`), the `GRPC_STATUS` numeric-code map, and the `AforoGrpcConfig` type.

> gRPC `Metadata.getMap()` returns `string | Buffer` per key. The default extractor string-coerces; a custom `customerIdExtractor` must do the same for non-string keys.

## Walk me through it

Step-by-step from install to a verified event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Per-message billing on streams.** Streams emit one event on close with the aggregated count, not one event per message. If you need per-message events, emit them from inside your handler with a custom path.
- **Client-side interception.** This wraps **server** handlers. Outbound client calls are not metered.
- **No persistent buffer.** Events are in memory until flushed; a hard crash before flush drops the buffered batch. `shutdown()` covers graceful exit only.
- **No automatic customer resolution beyond `x-customer-id` metadata.** JWT/token decoding requires a `customerIdExtractor`.
