# ai.aforo:grpc-metering

Meter every RPC on a `grpc-java` server without editing your service implementations. Add one `ServerInterceptor` and each call — unary or streaming — emits a billing event with timing, status code, and call type.

**Version:** 1.2.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>ai.aforo</groupId>
  <artifactId>grpc-metering</artifactId>
  <version>1.2.2</version>
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
        .ingestorUrl("https://api.aforo.ai")
        .serviceName("acme.v1.UserService")
        .build();

Server server = ServerBuilder.forPort(50051)
        .addService(new UserServiceImpl())
        .intercept(billing.interceptor())
        .build()
        .start();

Runtime.getRuntime().addShutdownHook(new Thread(billing::close));
```

The interceptor records one event when each call closes, so it never delays the RPC. Events POST to `<ingestorUrl>/v1/ingest/batch` as `{"events": [...]}` (at most 1000 events per request; larger flushes are split) with `X-API-Key: <apiKey>` and `X-Tenant-Id: <tenantId>`; the buffer flushes every 5 seconds or once 50 events queue, with 3× exponential retry (1s / 2s / 4s).

> ⚠ Calls without a resolved customer id are not metered. The default extractor reads the `x-customer-id` gRPC metadata header. Override it with `.customerIdExtractor(...)` to decode a JWT from the `authorization` metadata instead — resolve from verified credentials, never from a request message field a client controls.

## Configuration

Builder options on `AforoGrpcBilling.newBuilder()`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | Sent as the `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | Stamped into `metadata.productId` and the idempotency key. |
| `apiKey` | `String` | *(required)* | Aforo API key, sent as `X-API-Key`. |
| `ingestorUrl` | `String` | *(required)* | Ingestion host. The SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `serviceName` | `String` | *(required)* | Logical service name stamped as `grpcService` and into the idempotency key. |
| `productType` | `String` | `GRPC_API` | Top-level `productType` on every event (required by the ingestor). Trimmed and uppercased; unknown values are passed through. Per call: `record(method, callType, customerId, status, durationMs, executionStatus, productType)` (a null/blank override uses the client value). |
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

Each event carries `metricName = "grpc_api.rpc_calls"`, `quantity = 1`, `productType` (default `"GRPC_API"`, see the `productType` option), plus `grpcService`, `grpcMethod`, `grpcStatusCode` (the gRPC `Status.Code` name, e.g. `OK` / `UNAVAILABLE` / `DEADLINE_EXCEEDED`), `grpcCallType`, `messageCount`, and `executionDurationMs`.

> ⚠ The interceptor emits `messageCount = 1` per call. For exact streaming message counts, call `billing.record(method, callType, customerId, status, durationMs)` directly inside your streaming handler instead of relying on the interceptor's default.

## Execution status (outcome-based pricing)

Every event carries an `executionStatus`, which OUTCOME_BASED rate plans use to bill each call at the weight set for its outcome. The interceptor derives it from the call's `Status.Code`:

| `Status.Code` | `executionStatus` |
|---------------|-------------------|
| `OK` | `SUCCESS` |
| `CANCELLED` | `CANCELLED` |
| `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `OUT_OF_RANGE` | `VALIDATION_FAILED` |
| `DEADLINE_EXCEEDED` | `TIMEOUT` |
| `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `UNAUTHENTICATED` | `BLOCKED` |
| anything else | `ERROR` |

`grpcStatusCode` is still sent unchanged. When you call `record(...)` yourself, the 5-argument form derives the status the same way (if the status argument is a `Status.Code` name; otherwise none is sent). Pass a sixth argument to set it explicitly — it wins over the derived value (a seventh sets a per-call `productType`):

```java
billing.record("Search", "SERVER_STREAM", customerId, "OK", durationMs, "PARTIAL");
```

The value is trimmed and upper-cased; blank means "not set". Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value is logged and ignored, and the derived status is sent instead — the ingestor would reject an event carrying an unknown status. The mapping is available as `AforoGrpcBilling.outcomeFromGrpcStatus(code)`.

## Dropped events

Events the SDK cannot deliver are counted, logged at `WARNING`, and passed to an optional hook. Nothing is thrown from the `record*` / `openConnection` calls for event content.

```java
AforoGrpcBilling billing = AforoGrpcBilling.newBuilder()
        // ...
        .onDrop((events, reason) -> deadLetter.save(events, reason))
        .build();

long lost = billing.droppedCount();
```

| `DropReason` | When |
|---|---|
| `RETRY_EXHAUSTED` | The batch failed all 3 attempts (network error, 5xx, 408, 429). |
| `REJECTED` | The ingestor answered a non-retryable 4xx for the batch, or accepted the batch (2xx) but refused individual events in `errors[]`. Only the events the response identifies by index are passed to the hook. |
| `INVALID` | The event breaks an ingestor field limit and was never sent: a blank `method`, `customerId` over 64 characters, `serviceName` over 255, `productType` over 20. These values are never truncated. |

The method name originates from the incoming call (in `interceptor()` and when passed to `record(...)`): one over 128 characters is cut to 128 on `grpcMethod` and the call is still metered, with one `WARNING` per instance.

Dropped events keep their `idempotencyKey`, so storing them and re-sending later is dedup-safe. An exception thrown by the hook is swallowed.

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Exact per-message streaming counts.** The interceptor counts one event per call. Call `record(...)` yourself for true message-level counts.
- **Client-side metering.** This is a `ServerInterceptor`. To meter outbound calls, attach it on the server you call, or use a different integration.
- **Guaranteed delivery.** Events buffer in memory; a hard crash or a flush exhausting all 3 retries drops that batch (logged at `WARNING`). There is no on-disk spool.
