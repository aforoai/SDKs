# ai.aforo:grpc-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Java engineers running a `grpc-java` server who need per-RPC usage metering.

## What you'll build

A gRPC server where every RPC — unary or streaming — emits one Aforo billing event with its status code, call type, and duration. By the end you'll have a metered RPC confirmed as landed in Aforo.

## Prerequisites

- JDK 17 or newer.
- A `grpc-java` 1.60+ server you can add an interceptor to.
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id` for this gRPC service.
- A way to find the Aforo customer for a call from an identity you verified (mTLS peer, validated token).

## Step 1 — Build the SDK into your local Maven repo

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java-grpc
mvn clean install
```

Add to your service's `pom.xml`:

```xml
<dependency>
  <groupId>ai.aforo</groupId>
  <artifactId>grpc-metering</artifactId>
  <version>2.0.0</version>
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
        .ingestorUrl("https://api.aforo.ai")
        .serviceName("acme.v1.UserService")
        .build();

Server server = ServerBuilder.forPort(50051)
        .addService(new UserServiceImpl())
        .intercept(billing.interceptor())
        .build()
        .start();
```

> ⚠ `ingestorUrl` is the host only — the SDK appends `/v1/ingest/batch`. Pass `https://api.aforo.ai`, not the full path.

## Step 4 — Tell the interceptor who the customer is

`build()` throws until you choose a customer source. Resolve it from credentials you verified:

```java
import io.grpc.Metadata;

AforoGrpcBilling billing = AforoGrpcBilling.newBuilder()
        // ... required fields ...
        .customerResolver((call, headers) -> {
            String auth = headers.get(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER));
            return verifiedCustomerId(auth);   // your JWT validation; null when unauthenticated
        })
        .build();
```

> ⚠ `trustCustomerHeader(true)` reads the `x-customer-id` metadata instead. Callers set that header, so use it only behind a proxy that authenticates the caller and overwrites it. A call with no customer is served as usual; its event is counted as `INVALID` and passed to `onDrop`.

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
| `apiKey` | `String` | *(required)* | Aforo API key, sent as `X-API-Key`. |
| `ingestorUrl` | `String` | *(required)* | Host; SDK appends `/v1/ingest/batch`. |
| `serviceName` | `String` | *(required)* | `grpcService` field + idempotency key. |
| `productType` | `String` | `GRPC_API` | Top-level `productType` on every event; trimmed + uppercased. Per call: `record(method, callType, customerId, status, durationMs, executionStatus, productType)` (a null/blank override uses the client value). |
| `flushCount` | `int` | `500` | Events per request (at most 1000); also how many queued events wake the sender. |
| `flushIntervalMs` | `long` | `5000` | How often queued events are sent when the batch is not full (ms). |
| `maxQueueSize` | `int` | `10000` | Queue capacity; when full, the oldest event is dropped as `OVERFLOW`. |
| `maxRetries` | `int` | `3` | Retries per request on a network error, timeout, 408, 429 or 5xx. |
| `retryBaseMs` | `long` | `500` | Base of the full-jitter backoff (each wait is random up to `min(30 s, base × 2^attempt)`). |
| `timeoutMs` | `long` | `10000` | Total deadline of one ingest request (ms). |
| `shutdownTimeoutMs` | `long` | `5000` | How long `close()` keeps sending; leftovers are reported as `SHUTDOWN`. |
| `breakerCooldownMs` | `long` | `5000` | Pause after a batch fails every retry or gets 401/403; doubles with jitter up to 5 minutes. |
| `allowInsecureHttp` | `boolean` | `false` | Accept a plain `http://` `ingestorUrl` on a host other than localhost / 127.0.0.1 / ::1. |
| `customerResolver` | `CustomerResolver` | *(required unless `trustCustomerHeader`)* | Per-call customer from your authentication. |
| `trustCustomerHeader` | `boolean` | `false` | Read `x-customer-id` metadata (only behind a proxy that sets it). |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `IllegalArgumentException: <field> is required` at build | A required builder field (`tenantId` / `productId` / `apiKey` / `ingestorUrl` / `serviceName`) is blank | Set all five; they're validated in the constructor. |
| `IllegalStateException: AforoGrpcBilling needs to know which customer each call belongs to` | No customer source | Add `.customerResolver(...)` (or `.trustCustomerHeader(true)` behind a trusted proxy). |
| No events appear; `Dropping invalid event: customerId is required` | Your resolver returned `null` | Check that the credentials reach the server and that your resolver maps them. |
| Events POST to a 404 | `ingestorUrl` already includes the path | Pass the host only; the SDK appends `/v1/ingest/batch`. |
| `Ingestor unreachable after retries; N event(s) put back in the queue` in logs | Network error, timeout, 5xx, 408 or 429 on every attempt | Check connectivity to `ingestorUrl`. Nothing is lost while the queue has room; events still queued when `close()` hits its deadline go to `onDrop` as `SHUTDOWN`. |
| `ingestor returned 4xx — not retrying` or `Dropped N event(s) — REJECTED` in logs | Bad key, unknown metric, or an event the ingestor refused; a 4xx other than 408/429 is sent once | Verify the key + `X-Tenant-Id`; ensure the `grpc_api.rpc_calls` metric exists in Aforo. The log line carries the ingestor's `errors[].message`. |
| `Dropping invalid event: ...` in logs, `droppedCount()` grows | The event breaks an ingestor field limit (`DropReason.INVALID`) and was not sent | The message names the field, the limit and the value. See [Dropped events](README.md#dropped-events). |
| Streaming calls all show `messageCount = 1` | The interceptor counts one event per call, not per message | Call `billing.record(...)` inside the streaming handler for exact counts. |
| `grpcStatusCode` is `UNKNOWN` for errors you expected to classify | Your handler threw a raw exception rather than setting a `Status` | Map errors to gRPC `Status` codes in your service; the SDK reports whatever code the call closes with. |

## What this guide does NOT cover

- **Client-side / outbound RPC metering.** This is a `ServerInterceptor`. Meter on the receiving server, or integrate differently for client metering.
- **Reading metered usage back.** This SDK writes events only — retrieval and rating live in the Aforo platform.
- **Exact streaming message counts via the interceptor.** Use `record(...)` directly (Step 6).
