# @aforo/grpc-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Node.js engineers running a `@grpc/grpc-js` server who need per-RPC usage metered into Aforo.

## What you'll build

A gRPC server where every RPC — unary and all three stream shapes — emits one Aforo usage event tagged with method, status code, call type, message count, and duration. By the end you'll have called a metered RPC and confirmed the event reached Aforo.

## Prerequisites

- Node.js ≥ 18 (the SDK uses the global `fetch`).
- An Aforo API key, a tenant id (`tenant_…`), a product id, and your fully-qualified gRPC service name (e.g. `acme.v1.UserService`).
- `@grpc/grpc-js` ^1.9 installed in your app (peer dependency).
- A generated service definition + handlers you can wrap.

## Step 1 — Install the SDK

Once published:

```bash
npm i @aforo/grpc-metering @grpc/grpc-js
```

It isn't on npm yet. Build from source and link it:

```bash
cd aforo-metering-sdks/node-grpc
npm install
npm run build      # produces dist/

cd /path/to/your-app
npm install /absolute/path/to/aforo-metering-sdks/node-grpc
npm install @grpc/grpc-js
```

## Step 2 — Create the billing instance

Construct it once at startup. It starts a background flush timer immediately.

```ts
import { AforoGrpcBilling } from '@aforo/grpc-metering';

const billing = new AforoGrpcBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_grpc_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingest.aforo.ai', // SDK appends /v1/ingest/events
  serviceName: 'acme.v1.UserService',
});
```

> ⚠ `ingestorUrl` is the **base** URL — the SDK appends `/v1/ingest/events`. Don't include the path.

## Step 3 — Wrap your handlers

Each wrapper takes the gRPC method name (used in `grpcMethod` and the idempotency key) and your existing handler. Match the wrapper to the call shape:

```ts
const server = new grpc.Server();
server.addService(UserServiceService, {
  getUser:     billing.wrapUnary('GetUser', async (call) => ({ id: call.request.getId(), name: 'Jane' })),
  listUsers:   billing.wrapServerStream('ListUsers', async (call) => { call.write({ id: '1' }); call.write({ id: '2' }); }),
  uploadBatch: billing.wrapClientStream('UploadBatch', async (call) => { let n = 0; for await (const _ of call) n++; return { accepted: n }; }),
  chat:        billing.wrapBidiStream('Chat', async (call) => { for await (const m of call) call.write({ reply: `echo: ${m.text}` }); }),
});
```

> ⚠ Your handler must `return` the response (for unary/client-stream) or finish the promise (for server/bidi-stream). The wrapper records the event on resolve/reject and itself calls `callback(null, res)` or `call.end()`. Don't call the callback yourself.

What gets counted:
- **Unary** — `messageCount: 1`.
- **Server-stream** — counts each `call.write(...)`; one event on close.
- **Client-stream** — counts each inbound `data`; one event on completion.
- **Bidi-stream** — counts both inbound and outbound; one event on close.

On a thrown error, the wrapper records the event with the gRPC status label (from `err.code`, defaulting to `UNKNOWN`) and propagates the error to the caller.

## Step 4 — Make sure each call has a customer id

The default extractor reads `x-customer-id` from the gRPC call metadata. A call with no resolvable customer id is **silently skipped** — ideal for health checks and reflection. If your customer lives in an auth token, supply an extractor:

```ts
const billing = new AforoGrpcBilling({
  // …
  customerIdExtractor: (metadata) => {
    const auth = metadata['authorization'];
    return decodeCustomerIdFromToken(typeof auth === 'string' ? auth : String(auth ?? ''));
  },
});
```

## Step 5 — Call a metered RPC

Send the customer id in metadata. With `grpcurl`:

```bash
grpcurl -plaintext \
  -H 'x-customer-id: cust_demo_001' \
  -d '{"id":"1"}' \
  localhost:50051 acme.v1.UserService/GetUser
```

The SDK records one event:
- `metricName`: `grpc_api.rpc_calls`, `quantity`: 1
- `grpcService`: `acme.v1.UserService`, `grpcMethod`: `GetUser`
- `grpcCallType`: `UNARY`, `grpcStatusCode`: `OK`
- `messageCount`, `executionDurationMs`

## Step 6 — Flush and verify it landed in Aforo

Events buffer until `flushCount` (50) or `flushIntervalMs` (5000) is hit. Force a flush on graceful shutdown:

```ts
process.on('SIGTERM', async () => { await billing.shutdown(); });
process.on('SIGINT',  async () => { await billing.shutdown(); process.exit(0); });
```

> ⚠ Without `shutdown()`, a process that exits inside the 5-second window drops the buffered batch.

The batch is POSTed to `https://ingest.aforo.ai/v1/ingest/events` with `Authorization: Bearer <your api key>` and `X-Tenant-Id: tenant_acme`. Confirm in the Aforo console under the product's usage events (filter `productType = GRPC_API`). On 3 consecutive failures (1s/2s/4s backoff) the batch is dropped and `onError` fires — log it:

```ts
const billing = new AforoGrpcBilling({
  // …
  onError: (err) => myLogger.error('aforo grpc flush failed', err),
});
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. |
| `productId` | `string` | — (required) | Aforo product id; into `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent as `Authorization: Bearer <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Base URL; SDK appends `/v1/ingest/events`. |
| `serviceName` | `string` | — (required) | FQ service name; stamped as `grpcService`. |
| `customerIdExtractor` | `(metadata) => string \| undefined` | reads `x-customer-id` | Resolve the customer per call; `undefined` → skip. |
| `flushCount` | `number` | `50` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `number` | `5000` | Max ms before a partial batch is flushed. |
| `onError` | `(error: Error) => void` | `console.error` | Terminal flush-failure callback. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events at all | No customer id resolved | Send `x-customer-id` in metadata, or supply a `customerIdExtractor`. Calls without a customer are skipped by design. |
| Stream emits zero events | Handler threw before resolving, or never resolved | The event records on resolve/reject — ensure the handler promise settles. |
| Events stop after a deploy | Process exited before the 5s timer flushed | Call `await billing.shutdown()` on `SIGTERM`/`SIGINT`. |
| `…/v1/ingest/events/v1/ingest/events` in logs | `ingestorUrl` already includes the path | Set `ingestorUrl` to the base host only. |
| `grpcStatusCode` always `UNKNOWN` on errors | Thrown error has no numeric `code` | Throw a gRPC error with a `code` (use the exported `GRPC_STATUS` map). |
| `onError` firing repeatedly | Wrong `apiKey`/`tenantId`, or ingestor unreachable | Verify credentials and that the host accepts `POST /v1/ingest/events`. |

## What this guide does NOT cover

- **Per-message stream events.** Streams emit one aggregated event on close, not per message.
- **Client-side metering.** This wraps server handlers only.
- **Interceptor-style registration.** You wrap handlers explicitly; there's no global server interceptor in this SDK.
- **Rating, invoicing, plan config.** Those live in the Aforo console.
- **Durable delivery.** The buffer is in-memory; see Step 6 for the crash-window caveat.
