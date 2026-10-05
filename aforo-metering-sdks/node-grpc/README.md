# @aforoai/grpc-metering

Wrap your `@grpc/grpc-js` server handlers and get one Aforo usage event per RPC — unary, server-stream, client-stream, or bidi — with status code, call type, message count, and duration attached. Your handler logic stays untouched.

**Version:** 1.2.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install (once published):

```bash
npm i @aforoai/grpc-metering @grpc/grpc-js
```

> **Install `1.2.2` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `1.2.2` is not on npm yet, install from source with the steps below. `@grpc/grpc-js` (`^1.9`) is a peer dependency; install it in your app.

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

Each wrapped handler emits one event with `metricName: "grpc_api.rpc_calls"`, `quantity: 1`. Streams emit a single event on stream close carrying the aggregated `messageCount`. The gRPC status code is mapped to a label (`OK`, `NOT_FOUND`, `UNAVAILABLE`, …). Events ship to `POST https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`.

## Configuration

`new AforoGrpcBilling(config)` — `tenantId`, `productId`, `apiKey`, `ingestorUrl`, and `serviceName` are required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. Never read from a client header. |
| `productId` | `string` | — (required) | Aforo product id; into each event's `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent as `X-API-Key: <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Ingestion base URL. SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `productType` | `string` | `'GRPC_API'` | Aforo product type sent as top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override via the wrappers' last argument, e.g. `wrapUnary('GetUser', handler, { productType })`. |
| `serviceName` | `string` | — (required) | Fully-qualified gRPC service name (e.g. `acme.v1.UserService`); stamped on every event as `grpcService`. |
| `customerIdExtractor` | `(metadata: Record<string, unknown>) => string \| undefined` | reads `x-customer-id` from `call.metadata.getMap()` | Resolve the customer per call. `undefined` → call is not metered. |
| `flushCount` | `number` | `50` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `number` | `5000` | Max ms before a partial batch is flushed. |
| `onError` | `(error: Error) => void` | logs to `console.error` | Called once per delivery problem: a batch dropped after 3 attempts (network errors / 408 / 429 honouring `Retry-After` / 5xx), a batch refused with any other 4xx (not retried; the message includes the ingestor's `errors[].message`), per-event failures reported in a 2xx response, and an unusable `executionStatus`. Exceptions it throws are swallowed. |
| `onDrop` | `(events, reason) => void` | none | Receives events that were permanently dropped, with reason `invalid`, `rejected` or `retry_exhausted`. See [Dropped events](#dropped-events). |

Exported symbols: `AforoGrpcBilling` (with `wrapUnary` / `wrapServerStream` / `wrapClientStream` / `wrapBidiStream` / `shutdown` / `droppedCount`), `outcomeFromGrpcStatus`, the `GRPC_STATUS` numeric-code map, `DEFAULT_PRODUCT_TYPE`, and the `AforoGrpcConfig` / `GrpcWrapOptions` (alias `WrapOptions`) / `GrpcCallOutcome` / `GrpcUsageEvent` / `DropReason` types.

> gRPC `Metadata.getMap()` returns `string | Buffer` per key. The default extractor string-coerces; a custom `customerIdExtractor` must do the same for non-string keys.

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
| `invalid` | The event failed a client-side check and was never buffered or sent: `customerId` longer than 64 characters, a blank `grpcService` (`serviceName`) or `grpcMethod`, `grpcService` longer than 255, or `productType` longer than 20. These are never truncated. A `grpcMethod` longer than 128 characters is not a drop: it is cut to 128 and the event is sent (one warning per label). The warning names the field, the limit and the value (first 80 characters); it is logged for the first occurrence per field and for every 1000th after that. |
| `rejected` | The ingestor refused the batch with a 4xx other than 408 / 429 (not retried), or named individual events in the `errors[]` of a 2xx response — then only those events are dropped. When a 2xx reports `failed > 0` without a usable `index`, the count is added to `droppedCount` and `onDrop` is not called. |
| `retry_exhausted` | Network errors, 408, 429 or 5xx persisted through 3 attempts (1s / 2s / 4s backoff; `Retry-After` honoured up to 30 s). |

A call with no resolvable customer id is not billable; it is skipped and is not counted as a drop.

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
- **No persistent buffer.** Events are in memory until flushed; a hard crash before flush drops the buffered batch. `shutdown()` covers graceful exit only.
- **No automatic customer resolution beyond `x-customer-id` metadata.** JWT/token decoding requires a `customerIdExtractor`.
