# com.aforo:graphql-metering

Meter every GraphQL operation without touching your resolvers. Install one `Instrumentation` on your `graphql-java` schema and each query/mutation/subscription emits a billing event with AST-accurate complexity scoring (`field_count + 5 × max_depth`).

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>graphql-metering</artifactId>
  <version>1.0.0</version>
</dependency>
```

**Not yet on Maven Central — build from source for now:**

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java-graphql
mvn clean install
```

Java 17+. `com.graphql-java:graphql-java` 21+ is a `provided` peer dependency — your application brings its own version.

## Quickstart

```java
import com.aforo.graphql.AforoGraphQlBilling;
import graphql.GraphQL;

AforoGraphQlBilling billing = AforoGraphQlBilling.newBuilder()
        .tenantId("tenant_acme")
        .productId("prod_graphql_unified_gateway")
        .apiKey(System.getenv("AFORO_API_KEY"))
        .ingestorUrl("https://ingest.aforo.ai")
        .schemaVersion("v2.1")
        .build();

GraphQL gql = GraphQL.newGraphQL(schema)
        .instrumentation(billing.instrumentation())
        .build();

// On shutdown, flush the buffer:
Runtime.getRuntime().addShutdownHook(new Thread(billing::close));
```

Events POST to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer <apiKey>` and `X-Tenant-Id: <tenantId>`. The buffer flushes every 5 seconds or once 50 events queue, with 3× exponential retry (1s / 2s / 4s).

> ⚠ Operations without a resolved customer id are not metered — safe for introspection and health queries. The default extractor reads `x-customer-id` (or `customerId`) from the GraphQL execution context `Map`. Override it with `.customerIdExtractor(...)` if your customer id lives elsewhere (e.g. a JWT claim).

## Configuration

Builder options on `AforoGraphQlBilling.newBuilder()`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | Sent as the `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | Stamped into each event's `metadata.productId` and the idempotency key. |
| `apiKey` | `String` | *(required)* | Bearer token. |
| `ingestorUrl` | `String` | *(required)* | Ingestion host. The SDK appends `/v1/ingest/events`. Use `https://ingest.aforo.ai`. |
| `schemaVersion` | `String` | *(none)* | Optional; added to `metadata.schemaVersion` when set. |
| `flushCount` | `int` | `50` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `long` | `5000` | Background flush cadence (ms). |
| `customerIdExtractor` | `Function<InstrumentationExecutionParameters, String>` | reads `x-customer-id` / `customerId` from the execution context | How the per-operation customer id is resolved. |

Every required field is validated at build time — a blank value throws `IllegalArgumentException`.

## Each event

Emitted with `metricName = "graphql_api.operations"`, `quantity = 1`, `productType = "GRAPHQL_API"`, plus: `gqlOperationType` (`QUERY` / `MUTATION` / `SUBSCRIPTION`), `gqlOperationName` (`anonymous` when unnamed), `gqlComplexity`, `gqlFieldCount`, `gqlHasErrors`, and `executionDurationMs`. `gqlHasErrors` is `true` when the result has a non-empty errors array **or** the execution threw.

To plug in your own complexity number instead of the default formula, call `billing.record(customerId, query, operationName, durationMs, hasErrors)` directly — it parses the query and computes complexity itself, but you can bypass the `Instrumentation` entirely and shape events your way.

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Per-field / per-resolver metering.** One event is emitted per top-level operation, not per field. Complexity scoring is the proxy for field-level cost.
- **Guaranteed delivery.** Events are buffered in memory; a hard crash or a flush that exhausts all 3 retries drops that batch (logged at `WARNING`). There is no on-disk spool.
- **Custom complexity weights via config.** The `field_count + 5 × max_depth` formula is fixed in `instrumentation()`. For a different weighting, call `record(...)` with your own number.
