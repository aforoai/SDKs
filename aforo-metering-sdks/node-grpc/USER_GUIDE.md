# @aforoai/grpc-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Node.js engineers running a `@grpc/grpc-js` server who need per-RPC usage metered into Aforo.

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
npm i @aforoai/grpc-metering @grpc/grpc-js
```

Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog. If `2.0.0` is not on npm yet, install from source:

```bash
cd SDKs/aforo-metering-sdks/node-grpc
npm install
npm run build      # produces dist/

cd /path/to/your-app
npm install /absolute/path/to/aforo-metering-sdks/node-grpc
npm install @grpc/grpc-js
```

## Step 2 — Create the billing instance

Construct it once at startup. It starts a background flush timer immediately.

```ts
import { AforoGrpcBilling } from '@aforoai/grpc-metering';

const billing = new AforoGrpcBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_grpc_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai', // SDK appends /v1/ingest/batch
  serviceName: 'acme.v1.UserService',
  customerResolver: (call) => customerFromVerifiedToken(call.metadata.get('authorization')[0]), // Step 4
});
```

> ⚠ `ingestorUrl` is the **base** URL — the SDK appends `/v1/ingest/batch`. Don't include the path.

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

`customerResolver` is required: it receives the gRPC call and returns the Aforo customer id from identity your server verified — an auth token you checked, the mTLS peer certificate. Creating `AforoGrpcBilling` without it throws.

```ts
const billing = new AforoGrpcBilling({
  // …
  customerResolver: (call) => {
    const auth = call.metadata.get('authorization')[0];
    return customerFromVerifiedToken(typeof auth === 'string' ? auth : String(auth ?? ''));
  },
});
```

A call your resolver returns nothing for (health checks, reflection) is not metered: it is counted as one `invalid` drop in `billing.droppedCount`, and the RPC is unaffected. A resolver that throws is reported through `onError` and treated the same way.

> ⚠ Behind a proxy that sets `x-customer-id` metadata and strips any client copy, `trustCustomerHeader: true` bills that value instead. Without such a proxy any caller could bill another customer.

## Step 5 — Call a metered RPC

Call it the way your resolver authenticates. With `grpcurl` and a bearer token:

```bash
grpcurl -plaintext \
  -H "authorization: Bearer $DEMO_TOKEN" \
  -d '{"id":"1"}' \
  localhost:50051 acme.v1.UserService/GetUser
```

The SDK records one event:
- `metricName`: `grpc_api.rpc_calls`, `quantity`: 1
- `grpcService`: `acme.v1.UserService`, `grpcMethod`: `GetUser`
- `grpcCallType`: `UNARY`, `grpcStatusCode`: `OK`
- `messageCount`, `executionDurationMs`

## Step 6 — Flush and verify it landed in Aforo

Events queue until `flushCount` (500) are waiting or `flushIntervalMs` (5000) passes; one background sender ships them. The SDK installs no signal handlers — call `shutdown()` from yours. It sends what is queued for at most `shutdownTimeoutMs` (5 s) and reports anything left with reason `shutdown`:

```ts
process.once('SIGTERM', async () => {
  await billing.shutdown();
  process.exit(0);
});
```

> ⚠ Without `shutdown()`, a process killed by a signal loses what is queued. A process that ends on its own sends it on `beforeExit`.

The batch is POSTed to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <your api key>` and `X-Tenant-Id: tenant_acme`. Confirm in the Aforo console under the product's usage events (filter `productType = GRPC_API`). Network errors, timeouts, 408, 429 (honouring `Retry-After`) and 5xx are retried 3× with randomized backoff; after that — or on 401/403 — the batch stays queued and is re-sent when the ingestor recovers. Any other 4xx is not retried. `onError` fires on refused batches, on an outage (once), on resolver failures and on events lost at the shutdown deadline — log it:

```ts
const billing = new AforoGrpcBilling({
  // …
  onError: (err) => myLogger.error('aforo grpc flush failed', err),
});
```

## Outcomes and dropped events

- **`executionStatus`** — the outcome used by outcome-based pricing. How this SDK sets it, the accepted values and how to override it: [README → Execution status](README.md#execution-status).
- **Dropped events** — the SDK does not throw into your RPC handlers for event content. Events it cannot deliver are counted in `billing.droppedCount`, logged with `console.warn`, and passed to `onDrop(events, reason)`. The reasons (`invalid`, `rejected`, `overflow`, `shutdown`, `closed`) and what triggers each: [README → Dropped events](README.md#dropped-events).

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. |
| `productId` | `string` | — (required) | Aforo product id; into `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent only as `X-API-Key: <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Base URL, `https://`; SDK appends `/v1/ingest/batch`. |
| `productType` | `string` | `'GRPC_API'` | Top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override via the wrappers' last argument, e.g. `wrapUnary('GetUser', handler, { productType })`. |
| `serviceName` | `string` | — (required) | FQ service name; stamped as `grpcService`. |
| `customerResolver` | `(call) => string \| undefined` | — (required unless `trustCustomerHeader`) | The customer per call from verified identity; nothing → `invalid` drop. `customerIdExtractor` is a deprecated alias. |
| `trustCustomerHeader` | `boolean` | `false` | Bill `x-customer-id` metadata. Only behind a proxy you control. |
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

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events, `droppedCount` rises (`invalid`) | `customerResolver` returned nothing | Make it return the customer for authenticated calls. |
| `AforoGrpcBilling needs a customerResolver` at startup | 2.0 removed the default `x-customer-id` lookup | Pass `customerResolver`, or `trustCustomerHeader: true` behind a proxy you control. |
| `must use https://` at startup | `ingestorUrl` is plain http to a remote host | Use https, or `allowInsecureHttp: true` on a private network. |
| Stream emits zero events | Handler threw before resolving, or never resolved | The event records on resolve/reject — ensure the handler promise settles. |
| Events stop after a deploy | Process was killed before the queue was sent | Call `await billing.shutdown()` from your `SIGTERM`/`SIGINT` handler. |
| `…/v1/ingest/batch/v1/ingest/batch` in logs | `ingestorUrl` already includes the path | Set `ingestorUrl` to the base host only. |
| `grpcStatusCode` always `UNKNOWN` on errors | Thrown error has no numeric `code` | Throw a gRPC error with a `code` (use the exported `GRPC_STATUS` map). |
| `Aforo ingestor unavailable` in `onError` | Ingestor unreachable, or 401/403 (wrong key) | Events stay queued and are sent on recovery; fix the key for 401/403. Raise `maxQueueSize` for long outages. |
| `droppedCount` rises and the warning says `invalid` | An event failed a client-side check (`customerId` longer than 64 characters, a blank `grpcService`) | Fix the value named in the warning; these values are not truncated. (A method name over 128 characters is cut to 128 and the event is still sent.) `onDrop` receives the event. |
| `droppedCount` rises and the warning says `rejected` | The ingestor refused the batch (4xx) or specific events | Read the `onError` message — it carries the ingestor's `errors[].message`. |

## What this guide does NOT cover

- **Per-message stream events.** Streams emit one aggregated event on close, not per message.
- **Client-side metering.** This wraps server handlers only.
- **Interceptor-style registration.** You wrap handlers explicitly; there's no global server interceptor in this SDK.
- **Rating, invoicing, plan config.** Those live in the Aforo console.
- **Durable delivery.** The queue is in memory: an ingestor outage is ridden out up to `maxQueueSize`, but a crash loses what is queued; see Step 6.
