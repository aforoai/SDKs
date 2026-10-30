# @aforoai/grpc-metering

Wrap your `@grpc/grpc-js` server handlers and get one Aforo usage event per RPC — unary, server-stream, client-stream, or bidi — with status code, call type, message count, and duration attached. Your handler logic stays untouched.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install (once published):

```bash
npm i @aforoai/grpc-metering @grpc/grpc-js
```

> **Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on npm yet, install from source with the steps below. `@grpc/grpc-js` (`^1.9`) is a peer dependency; install it in your app.

```bash
# from the SDKs repo root
cd SDKs/aforo-metering-sdks/node-grpc
npm install
npm run build          # tsc → dist/

# then, from YOUR app
npm install /absolute/path/to/aforo-metering-sdks/node-grpc
npm install @grpc/grpc-js   # peer dependency, in your app
```

## Quickstart

```ts
import * as grpc from '@grpc/grpc-js';
import { AforoGrpcBilling } from '@aforoai/grpc-metering';
import { UserServiceService } from './generated/user_grpc_pb';

const billing = new AforoGrpcBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_grpc_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai', // SDK appends /v1/ingest/batch
  serviceName: 'acme.v1.UserService',
  // Who is billed: from identity your server verified (mTLS peer, a checked token).
  customerResolver: (call) => customerFromVerifiedToken(call.metadata.get('authorization')[0]),
});

const server = new grpc.Server();
server.addService(UserServiceService, {
  getUser:     billing.wrapUnary('GetUser', async (call) => ({ id: call.request.getId(), name: 'Jane' })),
  listUsers:   billing.wrapServerStream('ListUsers', async (call) => { call.write({ id: '1' }); call.write({ id: '2' }); }),
  uploadBatch: billing.wrapClientStream('UploadBatch', async (call) => { let n = 0; for await (const _ of call) n++; return { accepted: n }; }),
  chat:        billing.wrapBidiStream('Chat', async (call) => { for await (const m of call) call.write({ reply: `echo: ${m.text}` }); }),
});

// The SDK installs no signal handlers. Flush from your own:
process.once('SIGTERM', async () => {
  await billing.shutdown();
  process.exit(0);
});
```

Each wrapped handler emits one event with `metricName: "grpc_api.rpc_calls"`, `quantity: 1`. Streams emit a single event on stream close carrying the aggregated `messageCount`. The gRPC status code is mapped to a label (`OK`, `NOT_FOUND`, `UNAVAILABLE`, …). Events ship to `POST https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`.

## Configuration

`new AforoGrpcBilling(config)` — `tenantId`, `productId`, `apiKey`, `ingestorUrl`, and `serviceName` are required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. Never read from a client header. |
| `productId` | `string` | — (required) | Aforo product id; into each event's `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent only as `X-API-Key: <apiKey>`; never logged or shown by `inspect()` / `JSON.stringify`. |
| `ingestorUrl` | `string` | — (required) | Ingestion base URL, `https://` (see `allowInsecureHttp`). SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `productType` | `string` | `'GRPC_API'` | Aforo product type sent as top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override via the wrappers' last argument, e.g. `wrapUnary('GetUser', handler, { productType })`. |
| `serviceName` | `string` | — (required) | Fully-qualified gRPC service name (e.g. `acme.v1.UserService`); stamped on every event as `grpcService`. |
| `customerResolver` | `(call) => string \| undefined` | — (required unless `trustCustomerHeader`) | The Aforo customer for a call, from identity your server verified (mTLS peer, a checked token). Receives the gRPC call. Returning nothing, or throwing, drops that call's event as `invalid` (counted); the RPC is never affected. The constructor throws when neither this nor `trustCustomerHeader` is given. `customerIdExtractor(metadataMap)` still works as a deprecated alias. |
| `trustCustomerHeader` | `boolean` | `false` | Bill the `x-customer-id` call metadata. Any client can set metadata, so only turn this on behind a proxy you control that sets it. |
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

Exported symbols: `AforoGrpcBilling` (with `wrapUnary` / `wrapServerStream` / `wrapClientStream` / `wrapBidiStream` / `flush` / `shutdown` / `droppedCount` / `queuedCount`), `outcomeFromGrpcStatus`, the `GRPC_STATUS` numeric-code map, `DEFAULT_PRODUCT_TYPE`, and the `AforoGrpcConfig` / `GrpcWrapOptions` (alias `WrapOptions`) / `GrpcCallOutcome` / `GrpcUsageEvent` / `DropReason` types.

> gRPC metadata values are `string | Buffer`. `trustCustomerHeader` string-coerces `x-customer-id`; a `customerResolver` that reads metadata must do the same.

## Delivery

One background sender per client sends one request at a time; recording an event only queues it. If the ingestor is unreachable, keeps answering 408/429/5xx after the retries, or answers 401/403 (a wrong or revoked key — logged as an error), the batch goes back to the front of the queue with its idempotency keys and sending pauses (5 s, doubling to 5 min, randomized). New events keep queueing up to `maxQueueSize`; the first successful request resumes sending, and the ingestor deduplicates the re-sent keys. A 413 splits the batch. Batches of 1 KiB or more are sent gzip-encoded (`Content-Encoding: gzip`, needs usage-ingestor wave 8 or later); set `compression: 'none'` to always send plain JSON. `flush()` sends what is queued now; `shutdown()` sends for at most `shutdownTimeoutMs` — call it from your own SIGTERM handler.

## Event fields

Each wrapped handler emits one event per call (for streams: one event on stream close, with aggregated `messageCount`):

```json
{
  "productType": "GRPC_API",
  "grpcService": "acme.v1.UserService",
  "grpcMethod": "GetUser",
  "grpcStatusCode": "OK",
  "executionStatus": "SUCCESS",
  "grpcCallType": "UNARY",
  "messageCount": 1,
  "executionDurationMs": 12
}
```

## Execution status

Outcome-based pricing bills each event at the weight set for its `executionStatus`; events without one bill at full price. The SDK trims and upper-cases the value and leaves the key out of the event when it is unset or blank. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or a Promise returned by an async resolver) is reported through `onError` and ignored — the event gets the status derived from the gRPC code instead — because the server would reject the event. Resolvers must be synchronous.

Each event gets an `executionStatus` derived from the gRPC status code (the same mapping the Aforo gateway plugins use; exported as `outcomeFromGrpcStatus`):

| gRPC code | executionStatus |
|---|---|
| `OK` (0) | `SUCCESS` |
| `CANCELLED` (1) | `CANCELLED` |
| `INVALID_ARGUMENT` (3), `FAILED_PRECONDITION` (9), `OUT_OF_RANGE` (11) | `VALIDATION_FAILED` |
| `DEADLINE_EXCEEDED` (4) | `TIMEOUT` |
| `PERMISSION_DENIED` (7), `RESOURCE_EXHAUSTED` (8), `UNAUTHENTICATED` (16) | `BLOCKED` |
| any other code | `ERROR` |

A thrown error without a numeric `code` counts as `UNKNOWN` (2) → `ERROR`. To set the value yourself, pass `executionStatus` as the third argument of any `wrap*` call — a string, or a function that receives `{ call, code, error }`. Your value wins; return `undefined` to keep the derived one.

```typescript
billing.wrapUnary('Summarize', handler, {
  executionStatus: ({ call }) => (call.request.needsReview ? 'HITL_REQUIRED' : undefined),
});
```

## Dropped events

The SDK does not throw into your RPC handlers for event content. An event that cannot be delivered is counted in `billing.droppedCount`, logged with `console.warn`, and passed to the optional `onDrop(events, reason)` hook. Events handed to the hook keep their `idempotencyKey`, so storing them and re-submitting later is dedup-safe. Exceptions thrown by the hook are swallowed.

| Reason | When |
|---|---|
| `invalid` | The customer resolver returned nothing (or threw), or the event failed a client-side check and was never queued or sent: `customerId` longer than 64 characters, a blank `grpcService` (`serviceName`) or `grpcMethod`, `grpcService` longer than 255, or `productType` longer than 20. These are never truncated. A `grpcMethod` longer than 128 characters is not a drop: it is cut to 128 and the event is sent (one warning per label). The warning names the field, the limit and the value (first 80 characters); it is logged for the first invalid event and for every 1000th after that. |
| `rejected` | The ingestor refused the batch with a 4xx other than 408 / 429 (not retried), or named individual events in the `errors[]` of a 2xx response — then only those events are dropped. When a 2xx reports `failed > 0` without a usable `index`, the count is added to `droppedCount` and `onDrop` is not called. |
| `overflow` | The queue (`maxQueueSize`) was full and the oldest event was evicted. |
| `shutdown` | Still queued when `shutdownTimeoutMs` ran out (also reported through `onError`). |
| `closed` | Recorded after `shutdown()`. |
| `retry_exhausted` | Not produced by 2.x (kept in the type): an outage keeps events queued instead of dropping them. |

A call with no resolvable customer is not metered and is counted as an `invalid` drop; the RPC itself is unaffected.

```ts
const billing = new AforoGrpcBilling({
  // …
  onDrop: (events, reason) => deadLetterQueue.push({ reason, events }),
});
```

## Walk me through it

Step-by-step from install to a verified event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Per-message billing on streams.** Streams emit one event on close with the aggregated count, not one event per message. If you need per-message events, emit them from inside your handler with a custom path.
- **Client-side interception.** This wraps **server** handlers. Outbound client calls are not metered.
- **No persistent buffer.** Events are in memory until sent; a hard crash loses what is queued. `shutdown()` covers graceful exit only.
- **No automatic customer resolution.** You supply `customerResolver` (decode your token there), or opt in to `x-customer-id` with `trustCustomerHeader`.
