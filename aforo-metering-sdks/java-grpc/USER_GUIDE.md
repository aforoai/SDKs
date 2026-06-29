# com.aforo:grpc-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Java engineers running a `grpc-java` server who need per-RPC usage metering.

## What you'll build

A gRPC server where every RPC — unary or streaming — emits one Aforo billing event with its status code, call type, and duration. By the end you'll have a metered RPC confirmed as landed in Aforo.

## Prerequisites

- JDK 17 or newer.
- A `grpc-java` 1.60+ server you can add an interceptor to.
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id` for this gRPC service.
- A way to put the customer id on call metadata (the default extractor reads the `x-customer-id` header).

## Step 1 — Build the SDK into your local Maven repo

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java-grpc
mvn clean install
```

Add to your service's `pom.xml`:

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>grpc-metering</artifactId>
  <version>1.0.0</version>
</dependency>
```

## Step 2 — Export your credentials

```bash
export AFORO_API_KEY="sk_live_xxxxxxxxxxxxxxxxxxxx"
```

## Step 3 — Build the billing instance and intercept the server

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
```

> ⚠ `ingestorUrl` is the host only — the SDK appends `/v1/ingest/events`. Pass `https://ingest.aforo.ai`, not the full path.

## Step 4 — Make the customer id reachable from metadata

The default extractor reads the `x-customer-id` gRPC metadata header. Have your client send it, or resolve it from the `authorization` header with a custom extractor:

```java
import io.grpc.Metadata;

AforoGrpcBilling billing = AforoGrpcBilling.newBuilder()
        // ... required fields ...
        .customerIdExtractor(headers -> {
            String auth = headers.get(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER));
            return decodeJwt(auth);   // your verified-JWT logic
        })
        .build();
```

> ⚠ Resolve the customer from verified metadata (a server-validated header or JWT) — not from a field inside the request message. A call with no resolvable customer id is silently not metered.

## Step 5 — Make a call, then flush and verify

Issue any RPC against the server. The interceptor records the event when the call closes. Flush the buffer before you check:

```java
billing.close();   // flushes synchronously, then shuts down the daemon thread
```

Then confirm on the Aforo side:

- Aforo console → **Ingestion → Recent Events**, filter by your `customerId` and `metricName = grpc_api.rpc_calls`. The event shows `grpcService`, `grpcMethod`, `grpcStatusCode`, `grpcCallType`, and `executionDurationMs`.

For long-running servers, register the flush on shutdown instead:

```java
Runtime.getRuntime().addShutdownHook(new Thread(billing::close));
```

## Step 6 — (Streaming only) count messages exactly

The interceptor emits `messageCount = 1` per call. For real per-message counts on a streaming method, skip the interceptor's default and record yourself:

```java
// inside your StreamObserver.onNext / onCompleted
billing.record("ListUsers", "SERVER_STREAM", customerId, "OK", durationMs);
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | `metadata.productId` + idempotency key. |
| `apiKey` | `String` | *(required)* | Bearer token. |
| `ingestorUrl` | `String` | *(required)* | Host; SDK appends `/v1/ingest/events`. |
| `serviceName` | `String` | *(required)* | `grpcService` field + idempotency key. |
| `flushCount` | `int` | `50` | Events per immediate flush. |
| `flushIntervalMs` | `long` | `5000` | Background flush cadence (ms). |
| `customerIdExtractor` | `Function<Metadata, String>` | `x-customer-id` metadata | Per-call customer-id resolution. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `IllegalArgumentException: <field> is required` at build | A required builder field (`tenantId` / `productId` / `apiKey` / `ingestorUrl` / `serviceName`) is blank | Set all five; they're validated in the constructor. |
| No events appear, no errors logged | Customer id not on metadata, so every call is skipped | Have the client send `x-customer-id`, or supply a `customerIdExtractor`. |
| Events POST to a 404 | `ingestorUrl` already includes the path | Pass the host only; the SDK appends `/v1/ingest/events`. |
| `flush exhausted retries — dropped N events` in logs | Ingestor returned non-2xx on all 3 attempts (bad key, unknown metric, network) | Verify the key + `X-Tenant-Id`; ensure the `grpc_api.rpc_calls` metric exists in Aforo. |
| Streaming calls all show `messageCount = 1` | The interceptor counts one event per call, not per message | Call `billing.record(...)` inside the streaming handler for exact counts. |
| `grpcStatusCode` is `UNKNOWN` for errors you expected to classify | Your handler threw a raw exception rather than setting a `Status` | Map errors to gRPC `Status` codes in your service; the SDK reports whatever code the call closes with. |

## What this guide does NOT cover

- **Client-side / outbound RPC metering.** This is a `ServerInterceptor`. Meter on the receiving server, or integrate differently for client metering.
- **Reading metered usage back.** This SDK writes events only — retrieval and rating live in the Aforo platform.
- **Exact streaming message counts via the interceptor.** Use `record(...)` directly (Step 6).
