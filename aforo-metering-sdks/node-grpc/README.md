# @aforo/grpc-metering

Aforo gRPC Metering SDK for Node.js. Wraps `@grpc/grpc-js` server handlers to automatically emit per-method billing events to Aforo's usage ingestor.

## Install

```bash
npm install @aforo/grpc-metering @grpc/grpc-js
```

## Usage

### Unary handler

```ts
import * as grpc from '@grpc/grpc-js';
import { AforoGrpcBilling } from '@aforo/grpc-metering';
import { UserServiceService } from './generated/user_grpc_pb';

const billing = new AforoGrpcBilling({
  tenantId: process.env.AFORO_TENANT_ID!,
  productId: 'prod_grpc_userservice',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingestor.aforo.ai',
  serviceName: 'acme.v1.UserService',
});

const server = new grpc.Server();

server.addService(UserServiceService, {
  getUser: billing.wrapUnary('GetUser', async (call) => {
    return { id: call.request.getId(), name: 'Jane' };
  }),
  listUsers: billing.wrapServerStream('ListUsers', async (call) => {
    call.write({ id: '1', name: 'Jane' });
    call.write({ id: '2', name: 'John' });
  }),
  uploadBatch: billing.wrapClientStream('UploadBatch', async (call) => {
    let total = 0;
    for await (const _chunk of call) total++;
    return { accepted: total };
  }),
  chat: billing.wrapBidiStream('Chat', async (call) => {
    for await (const msg of call) {
      call.write({ reply: `echo: ${msg.text}` });
    }
  }),
});

// Graceful shutdown — flushes any buffered events before process exit.
process.on('SIGTERM', async () => { await billing.shutdown(); });
```

## Billing event shape

Each wrapped handler emits one event per call (for streams: one event on stream close, with aggregated `messageCount`):

```json
{
  "productType": "GRPC_API",
  "grpcService": "acme.v1.UserService",
  "grpcMethod": "GetUser",
  "grpcStatusCode": "OK",
  "grpcCallType": "UNARY",
  "messageCount": 1,
  "executionDurationMs": 12
}
```

## Customer ID resolution

By default, the SDK extracts the customer ID from the `x-customer-id` gRPC metadata header. Override with a custom extractor:

```ts
const billing = new AforoGrpcBilling({
  // ...
  customerIdExtractor: (metadata) => {
    const auth = metadata['authorization'];
    // Decode JWT, return customer ID, etc.
    return /* ... */;
  },
});
```

Calls where no customer ID resolves are **not** metered (ideal for health checks, reflection calls, etc.).

## Batching & retry

Events are buffered in memory and flushed every 5 seconds or every 50 events (configurable). The SDK retries failed flushes 3× with exponential backoff (1s/2s/4s). Events dropped after exhausting retries invoke the `onError` callback.

## License

MIT
