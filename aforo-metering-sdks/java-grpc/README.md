# com.aforo:grpc-metering

Meter every RPC on a `grpc-java` server without editing your service implementations. Add one `ServerInterceptor` and each call — unary or streaming — emits a billing event with timing, status code, and call type.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>grpc-metering</artifactId>
  <version>1.0.0</version>
</dependency>
```

**Not yet on Maven Central — build from source for now:**

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java-grpc
mvn clean install
```

Java 17+. `io.grpc:grpc-api` 1.60+ is a `provided` peer dependency — your application brings its own gRPC version.

## Quickstart

```java
import com.aforo.grpc.AforoGrpcBilling;
import io.grpc.Server;
import io.grpc.ServerBuilder;

AforoGrpcBilling billing = AforoGrpcBilling.newBuilder()
        .tenantId("tenant_acme")
        .productId("prod_grpc_user_svc")
        .apiKey(System.getenv("AFORO_API_KEY"))
        .ingestorUrl("https://ingest.aforo.ai")
        .serviceName("acme.v1.UserService")
        .build();

Server server = ServerBuilder.forPort(50051)
        .addService(new UserServiceImpl())
        .intercept(billing.interceptor())
        .build()
        .start();

Runtime.getRuntime().addShutdownHook(new Thread(billing::close));
```

The interceptor records one event when each call closes, so it never delays the RPC. Events POST to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer <apiKey>` and `X-Tenant-Id: <tenantId>`; the buffer flushes every 5 seconds or once 50 events queue, with 3× exponential retry (1s / 2s / 4s).

> ⚠ Calls without a resolved customer id are not metered. The default extractor reads the `x-customer-id` gRPC metadata header. Override it with `.customerIdExtractor(...)` to decode a JWT from the `authorization` metadata instead — resolve from verified credentials, never from a request message field a client controls.

## Configuration

Builder options on `AforoGrpcBilling.newBuilder()`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | Sent as the `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | Stamped into `metadata.productId` and the idempotency key. |
| `apiKey` | `String` | *(required)* | Bearer token. |
| `ingestorUrl` | `String` | *(required)* | Ingestion host. The SDK appends `/v1/ingest/events`. Use `https://ingest.aforo.ai`. |
| `serviceName` | `String` | *(required)* | Logical service name stamped as `grpcService` and into the idempotency key. |
| `flushCount` | `int` | `50` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `long` | `5000` | Background flush cadence (ms). |
| `customerIdExtractor` | `Function<Metadata, String>` | reads `x-customer-id` metadata | How the per-call customer id is resolved. |

Every required field is validated at build time — a blank value throws `IllegalArgumentException`.

## Call types and each event

The interceptor maps gRPC method types automatically:

| gRPC method type | `grpcCallType` emitted |
|---|---|
| Unary | `UNARY` |
| Client-streaming | `CLIENT_STREAM` |
| Server-streaming | `SERVER_STREAM` |
| Bidi-streaming | `BIDI_STREAM` |

Each event carries `metricName = "grpc_api.rpc_calls"`, `quantity = 1`, `productType = "GRPC_API"`, plus `grpcService`, `grpcMethod`, `grpcStatusCode` (the gRPC `Status.Code` name, e.g. `OK` / `UNAVAILABLE` / `DEADLINE_EXCEEDED`), `grpcCallType`, `messageCount`, and `executionDurationMs`.

> ⚠ The interceptor emits `messageCount = 1` per call. For exact streaming message counts, call `billing.record(method, callType, customerId, status, durationMs)` directly inside your streaming handler instead of relying on the interceptor's default.

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Exact per-message streaming counts.** The interceptor counts one event per call. Call `record(...)` yourself for true message-level counts.
- **Client-side metering.** This is a `ServerInterceptor`. To meter outbound calls, attach it on the server you call, or use a different integration.
- **Guaranteed delivery.** Events buffer in memory; a hard crash or a flush exhausting all 3 retries drops that batch (logged at `WARNING`). There is no on-disk spool.
