# ai.aforo:graphql-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Java engineers running a `graphql-java` server who need per-operation usage metering.

## What you'll build

A GraphQL server where every operation emits one Aforo billing event carrying its complexity score, operation type, and duration. By the end you'll have a metered GraphQL query confirmed as landed in Aforo.

## Prerequisites

- JDK 17 or newer.
- A `graphql-java` 21+ server you can attach an `Instrumentation` to.
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id` for this GraphQL surface.
- A way to put the authenticated customer id on the `GraphQLContext` (your HTTP layer does this after it authenticates the request).

## Step 1 — Build the SDK into your local Maven repo

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java-graphql
mvn clean install
```

Add to your service's `pom.xml`:

```xml
<dependency>
  <groupId>ai.aforo</groupId>
  <artifactId>graphql-metering</artifactId>
  <version>2.0.0</version>
</dependency>
```

## Step 2 — Export your credentials

```bash
export AFORO_API_KEY="sk_live_xxxxxxxxxxxxxxxxxxxx"
```

## Step 3 — Build the billing instance and attach the instrumentation

```java
import com.aforo.graphql.AforoGraphQlBilling;
import graphql.GraphQL;

AforoGraphQlBilling billing = AforoGraphQlBilling.newBuilder()
        .tenantId("tenant_acme")
        .productId("prod_graphql_unified_gateway")
        .apiKey(System.getenv("AFORO_API_KEY"))
        .ingestorUrl("https://api.aforo.ai")
        .schemaVersion("v2.1")           // optional
        .build();

GraphQL gql = GraphQL.newGraphQL(schema)
        .instrumentation(billing.instrumentation())
        .build();
```

> ⚠ `ingestorUrl` is the host only — the SDK appends `/v1/ingest/batch` itself. Pass `https://api.aforo.ai`, not `https://api.aforo.ai/v1/ingest/batch`.

## Step 4 — Put the customer id on the execution context

`build()` throws until you choose a customer source. Put the authenticated customer on the `GraphQLContext` when you build the `ExecutionInput`:

```java
import graphql.ExecutionInput;

ExecutionInput input = ExecutionInput.newExecutionInput()
        .query(requestQuery)
        .graphQLContext(java.util.Map.of("aforoCustomerId", authenticatedCustomerId))
        .build();

gql.execute(input);
```

and read it with a resolver when you build the billing instance:

```java
.customerResolver(params -> params.getGraphQLContext().get("aforoCustomerId"))
```

> ⚠ Resolve `authenticatedCustomerId` from your auth layer (session, verified JWT) — not from a client-supplied request field. An operation with no customer id is answered as usual; its event is counted as `INVALID` and passed to `onDrop`. `trustCustomerHeader(true)` reads the `x-customer-id` / `customerId` entry of the `GraphQLContext` (or a legacy `Map` context) instead of a resolver.

## Step 5 — Run an operation, then flush and verify

Execute a query against your schema (any normal client request works). The instrumentation records one event when execution completes. Force the buffer out before you check:

```java
billing.close();   // flushes synchronously, then shuts down the daemon thread
```

Then confirm on the Aforo side:

- Aforo console → **Ingestion → Recent Events**, filter by your `customerId` and `metricName = graphql_api.operations`. The event shows `gqlOperationType`, `gqlComplexity`, `gqlFieldCount`, `gqlHasErrors`, and `executionDurationMs`.

For long-running servers, register the flush on shutdown instead of calling `close()` inline:

```java
Runtime.getRuntime().addShutdownHook(new Thread(billing::close));
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | `metadata.productId` + idempotency key. |
| `apiKey` | `String` | *(required)* | Aforo API key, sent as `X-API-Key`. |
| `ingestorUrl` | `String` | *(required)* | Host; SDK appends `/v1/ingest/batch`. |
| `schemaVersion` | `String` | *(none)* | Optional `metadata.schemaVersion`. |
| `productType` | `String` | `GRAPHQL_API` | Top-level `productType` on every event; trimmed + uppercased. Per call: `record(customerId, query, operationName, durationMs, hasErrors, executionStatus, productType)` (a null/blank override uses the client value). |
| `flushCount` | `int` | `500` | Events per request (at most 1000); also how many queued events wake the sender. |
| `flushIntervalMs` | `long` | `5000` | How often queued events are sent when the batch is not full (ms). |
| `maxQueueSize` | `int` | `10000` | Queue capacity; when full, the oldest event is dropped as `OVERFLOW`. |
| `maxRetries` | `int` | `3` | Retries per request on a network error, timeout, 408, 429 or 5xx. |
| `retryBaseMs` | `long` | `500` | Base of the full-jitter backoff (each wait is random up to `min(30 s, base × 2^attempt)`). |
| `timeoutMs` | `long` | `10000` | Total deadline of one ingest request (ms). |
| `shutdownTimeoutMs` | `long` | `5000` | How long `close()` keeps sending; leftovers are reported as `SHUTDOWN`. |
| `breakerCooldownMs` | `long` | `5000` | Pause after a batch fails every retry or gets 401/403; doubles with jitter up to 5 minutes. |
| `allowInsecureHttp` | `boolean` | `false` | Accept a plain `http://` `ingestorUrl` on a host other than localhost / 127.0.0.1 / ::1. |
| `customerResolver` | `CustomerResolver` | *(required unless `trustCustomerHeader`)* | Per-operation customer from your authentication. |
| `trustCustomerHeader` | `boolean` | `false` | Read the `x-customer-id` / `customerId` context entry. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `IllegalArgumentException: <field> is required` at build | A required builder field (`tenantId` / `productId` / `apiKey` / `ingestorUrl`) is blank | Set all four; they're validated in the constructor. |
| `IllegalStateException: AforoGraphQlBilling needs to know which customer each operation belongs to` | No customer source | Add `.customerResolver(...)`. |
| No events appear; `Dropping invalid event: customerId is required` | The resolver found no customer | Put the authenticated customer on the `GraphQLContext` before `execute(...)`. |
| Events POST to a 404 | `ingestorUrl` already includes the path | Pass the host only (`https://api.aforo.ai`); the SDK appends `/v1/ingest/batch`. |
| `Ingestor unreachable after retries; N event(s) put back in the queue` in logs | Network error, timeout, 5xx, 408 or 429 on every attempt | Check connectivity to `ingestorUrl`. Nothing is lost while the queue has room; events still queued when `close()` hits its deadline go to `onDrop` as `SHUTDOWN`. |
| `ingestor returned 4xx — not retrying` or `Dropped N event(s) — REJECTED` in logs | Bad key, unknown metric, or an event the ingestor refused; a 4xx other than 408/429 is sent once | Verify the key + `X-Tenant-Id`; ensure the `graphql_api.operations` metric exists in Aforo. The log line carries the ingestor's `errors[].message`. |
| `Dropping invalid event: ...` in logs, `droppedCount()` grows | The event breaks an ingestor field limit (`DropReason.INVALID`) and was not sent | The message names the field, the limit and the value. See [Dropped events](README.md#dropped-events). |
| `gqlComplexity` looks too low | Query is anonymous / aliased in a way the parser counts differently | Complexity is `field_count + 5 × max_depth` over the parsed AST; name your operations and inspect `gqlFieldCount` to sanity-check. |
| Subscriptions not metered | A persistent subscription completes only when it closes; the instrumentation records on completion | For long-lived subscriptions, call `billing.record(...)` at your own checkpoints. |

## What this guide does NOT cover

- **Federated / stitched gateways.** This meters the `graphql-java` engine it's attached to. In a federation, attach it on each subgraph or meter at the gateway.
- **Reading metered usage back.** This SDK writes events only — usage retrieval and rating live in the Aforo platform.
- **Tuning the complexity formula via config.** It's fixed; call `record(...)` with your own number to override.
