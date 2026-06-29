# com.aforo:grpc-metering

Aforo gRPC Metering SDK for Java. A `ServerInterceptor` that meters every RPC call (unary + streaming) and ships billing events to Aforo's usage ingestor in batches.

## Install

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>grpc-metering</artifactId>
  <version>1.0.0</version>
</dependency>
```

Peer dep: `io.grpc:grpc-api ^1.60` (provided by your application).

## Usage

```java
import com.aforo.grpc.AforoGrpcBilling;
import io.grpc.Server;
import io.grpc.ServerBuilder;

AforoGrpcBilling billing = AforoGrpcBilling.newBuilder()
    .tenantId("tenant_acme")
    .productId("prod_grpc_user_svc")
    .apiKey(System.getenv("AFORO_API_KEY"))
    .ingestorUrl("https://ingestor.aforo.ai")
    .serviceName("acme.v1.UserService")
    .build();

Server server = ServerBuilder.forPort(50051)
    .addService(new UserServiceImpl())
    .intercept(billing.interceptor())
    .build()
    .start();

Runtime.getRuntime().addShutdownHook(new Thread(billing::close));
```

The interceptor handles all 4 RPC types automatically:

| Method type | callType emitted |
|-------------|------------------|
| Unary       | `UNARY` |
| Client-stream | `CLIENT_STREAM` |
| Server-stream | `SERVER_STREAM` |
| Bidi-stream | `BIDI_STREAM` |

For exact streaming message counts, call `billing.record(...)` manually inside your handler instead of relying on the interceptor's `messageCount=1` default.

## Customer-ID resolution

Default extractor reads the `x-customer-id` gRPC metadata header. Override with a custom function:

```java
.customerIdExtractor(headers -> {
    String auth = headers.get(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER));
    return decodeJwt(auth);  // your JWT logic
})
```

Calls without a resolved customer ID are not metered.

## Status code mapping

`Status.Code` → descriptor enum: `OK`, `CANCELLED`, `UNKNOWN`, `INVALID_ARGUMENT`, `DEADLINE_EXCEEDED`, `NOT_FOUND`, `ALREADY_EXISTS`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `FAILED_PRECONDITION`, `ABORTED`, `OUT_OF_RANGE`, `UNIMPLEMENTED`, `INTERNAL`, `UNAVAILABLE`, `DATA_LOSS`, `UNAUTHENTICATED`.

## Batching & retry

Buffers 50 events / 5 s by default (configurable via `flushCount` / `flushIntervalMs`). 3× exponential retry on ingestor failure (1 s / 2 s / 4 s). Daemon flush thread, AutoCloseable for graceful shutdown.

## License

MIT
