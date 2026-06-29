# com.aforo:graphql-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Java engineers running a `graphql-java` server who need per-operation usage metering.

## What you'll build

A GraphQL server where every operation emits one Aforo billing event carrying its complexity score, operation type, and duration. By the end you'll have a metered GraphQL query confirmed as landed in Aforo.

## Prerequisites

- JDK 17 or newer.
- A `graphql-java` 21+ server you can attach an `Instrumentation` to.
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id` for this GraphQL surface.
- A way to put the customer id on the GraphQL execution context (the default extractor reads `x-customer-id` / `customerId` from the context `Map`).

## Step 1 — Build the SDK into your local Maven repo

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java-graphql
mvn clean install
```

Add to your service's `pom.xml`:

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>graphql-metering</artifactId>
  <version>1.0.0</version>
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
        .ingestorUrl("https://ingest.aforo.ai")
        .schemaVersion("v2.1")           // optional
        .build();

GraphQL gql = GraphQL.newGraphQL(schema)
        .instrumentation(billing.instrumentation())
        .build();
```

> ⚠ `ingestorUrl` is the host only — the SDK appends `/v1/ingest/events` itself. Pass `https://ingest.aforo.ai`, not `https://ingest.aforo.ai/v1/ingest/events`.

## Step 4 — Put the customer id on the execution context

The default extractor looks for `x-customer-id` (then `customerId`) in the execution context `Map`. Set it when you build the `ExecutionInput`:

```java
import graphql.ExecutionInput;

ExecutionInput input = ExecutionInput.newExecutionInput()
        .query(requestQuery)
        .graphQLContext(java.util.Map.of("x-customer-id", authenticatedCustomerId))
        .build();

gql.execute(input);
```

> ⚠ Resolve `authenticatedCustomerId` from your auth layer (session, verified JWT) — not from a client-supplied request field. An operation with no resolvable customer id is silently not metered, which is the desired behavior for introspection and health queries.

If your customer id lives somewhere else, override the extractor at build time:

```java
.customerIdExtractor(params -> {
    Map<String, Object> ctx = (Map<String, Object>) params.getContext();
    return (String) ctx.get("authenticatedUserId");
})
```

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
| `apiKey` | `String` | *(required)* | Bearer token. |
| `ingestorUrl` | `String` | *(required)* | Host; SDK appends `/v1/ingest/events`. |
| `schemaVersion` | `String` | *(none)* | Optional `metadata.schemaVersion`. |
| `flushCount` | `int` | `50` | Events per immediate flush. |
| `flushIntervalMs` | `long` | `5000` | Background flush cadence (ms). |
| `customerIdExtractor` | `Function<InstrumentationExecutionParameters, String>` | `x-customer-id` / `customerId` from context | Per-operation customer-id resolution. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `IllegalArgumentException: <field> is required` at build | A required builder field (`tenantId` / `productId` / `apiKey` / `ingestorUrl`) is blank | Set all four; they're validated in the constructor. |
| No events appear, no errors logged | Customer id not on the execution context, so every op is skipped | Put `x-customer-id` on the `graphQLContext` map, or supply a `customerIdExtractor`. |
| Events POST to a 404 | `ingestorUrl` already includes the path | Pass the host only (`https://ingest.aforo.ai`); the SDK appends `/v1/ingest/events`. |
| `flush exhausted retries — dropped N events` in logs | Ingestor returned non-2xx on all 3 attempts (bad key, unknown metric, network) | Verify the key + `X-Tenant-Id`; ensure the `graphql_api.operations` metric exists in Aforo. |
| `gqlComplexity` looks too low | Query is anonymous / aliased in a way the parser counts differently | Complexity is `field_count + 5 × max_depth` over the parsed AST; name your operations and inspect `gqlFieldCount` to sanity-check. |
| Subscriptions not metered | A persistent subscription completes only when it closes; the instrumentation records on completion | For long-lived subscriptions, call `billing.record(...)` at your own checkpoints. |

## What this guide does NOT cover

- **Federated / stitched gateways.** This meters the `graphql-java` engine it's attached to. In a federation, attach it on each subgraph or meter at the gateway.
- **Reading metered usage back.** This SDK writes events only — usage retrieval and rating live in the Aforo platform.
- **Tuning the complexity formula via config.** It's fixed; call `record(...)` with your own number to override.
