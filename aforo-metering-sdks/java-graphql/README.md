# ai.aforo:graphql-metering

Meter every GraphQL operation without touching your resolvers. Install one `Instrumentation` on your `graphql-java` schema and each query/mutation/subscription emits a billing event with AST-accurate complexity scoring (`field_count + 5 × max_depth`).

**Version:** 1.2.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>ai.aforo</groupId>
  <artifactId>graphql-metering</artifactId>
  <version>1.2.2</version>
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
        .ingestorUrl("https://api.aforo.ai")
        .schemaVersion("v2.1")
        .build();

GraphQL gql = GraphQL.newGraphQL(schema)
        .instrumentation(billing.instrumentation())
        .build();

// On shutdown, flush the buffer:
Runtime.getRuntime().addShutdownHook(new Thread(billing::close));
```

Events POST to `<ingestorUrl>/v1/ingest/batch` as `{"events": [...]}` (at most 1000 events per request; larger flushes are split) with `X-API-Key: <apiKey>` and `X-Tenant-Id: <tenantId>`. The buffer flushes every 5 seconds or once 50 events queue, with 3× exponential retry (1s / 2s / 4s).

> ⚠ Operations without a resolved customer id are not metered — safe for introspection and health queries. The default extractor reads `x-customer-id` (or `customerId`) from the GraphQL execution context `Map`. Override it with `.customerIdExtractor(...)` if your customer id lives elsewhere (e.g. a JWT claim).

## Configuration

Builder options on `AforoGraphQlBilling.newBuilder()`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | Sent as the `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | Stamped into each event's `metadata.productId` and the idempotency key. |
| `apiKey` | `String` | *(required)* | Aforo API key, sent as `X-API-Key`. |
| `ingestorUrl` | `String` | *(required)* | Ingestion host. The SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `schemaVersion` | `String` | *(none)* | Optional; added to `metadata.schemaVersion` when set. |
| `productType` | `String` | `GRAPHQL_API` | Top-level `productType` on every event (required by the ingestor). Trimmed and uppercased; unknown values are passed through. Per call: `record(customerId, query, operationName, durationMs, hasErrors, executionStatus, productType)` (a null/blank override uses the client value). |
| `flushCount` | `int` | `50` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `long` | `5000` | Background flush cadence (ms). |
| `customerIdExtractor` | `Function<InstrumentationExecutionParameters, String>` | reads `x-customer-id` / `customerId` from the execution context | How the per-operation customer id is resolved. |

Every required field is validated at build time — a blank value throws `IllegalArgumentException`.

## Each event

Emitted with `metricName = "graphql_api.operations"`, `quantity = 1`, `productType` (default `"GRAPHQL_API"`, see the `productType` option), plus: `gqlOperationType` (`QUERY` / `MUTATION` / `SUBSCRIPTION`), `gqlOperationName` (`anonymous` when unnamed), `gqlComplexity`, `gqlFieldCount`, `gqlHasErrors`, and `executionDurationMs`. `gqlHasErrors` is `true` when the result has a non-empty errors array **or** the execution threw.

To plug in your own complexity number instead of the default formula, call `billing.record(customerId, query, operationName, durationMs, hasErrors)` directly — it parses the query and computes complexity itself, but you can bypass the `Instrumentation` entirely and shape events your way.

## Execution status (outcome-based pricing)

OUTCOME_BASED rate plans bill each operation at the weight set for its `executionStatus`. The instrumentation derives it from the result:

| Result | `executionStatus` |
|--------|-------------------|
| No errors | `SUCCESS` |
| Errors, but some `data` returned | `PARTIAL` |
| Errors and `data` is `null` (failed during execution), or execution threw | `ERROR` |
| Errors and no `data` key (failed before execution: parse or validation error) | `VALIDATION_FAILED` |

`gqlHasErrors` is still sent unchanged. When calling `record(...)` yourself, pass the status as a sixth argument. The five-argument form sends none, because `hasErrors` alone can't tell a partial result from a failed one:

```java
billing.record(customerId, query, operationName, durationMs, hasErrors,
    AforoGraphQlBilling.outcomeFromGraphQlResult(result));

// If you only have the HTTP status code:
billing.record(customerId, query, operationName, durationMs, hasErrors,
    AforoGraphQlBilling.outcomeFromHttpStatus(httpStatus));
```

`outcomeFromHttpStatus` maps 2xx/3xx → `SUCCESS`, 408/504 → `TIMEOUT`, 499 → `CANCELLED`, 400/422 → `VALIDATION_FAILED`, 401/403/429 → `BLOCKED`, other 4xx/5xx → `ERROR`, anything else → not sent.

The value is trimmed and upper-cased; blank means "not set". Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value is logged and left off the event (the event is still sent) — the ingestor would reject an event carrying an unknown status.

## Dropped events

Events the SDK cannot deliver are counted, logged at `WARNING`, and passed to an optional hook. Nothing is thrown from the `record*` / `openConnection` calls for event content.

```java
AforoGraphQlBilling billing = AforoGraphQlBilling.newBuilder()
        // ...
        .onDrop((events, reason) -> deadLetter.save(events, reason))
        .build();

long lost = billing.droppedCount();
```

| `DropReason` | When |
|---|---|
| `RETRY_EXHAUSTED` | The batch failed all 3 attempts (network error, 5xx, 408, 429). |
| `REJECTED` | The ingestor answered a non-retryable 4xx for the batch, or accepted the batch (2xx) but refused individual events in `errors[]`. Only the events the response identifies by index are passed to the hook. |
| `INVALID` | The event breaks an ingestor field limit and was never sent: `customerId` over 64 characters, `productType` over 20. These values are never truncated. |

The operation name is read from the query, not set by you: one over 255 characters is cut to 255 on `gqlOperationName` and the event is still sent, with one `WARNING` per instance.

Dropped events keep their `idempotencyKey`, so storing them and re-sending later is dedup-safe. An exception thrown by the hook is swallowed.

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Per-field / per-resolver metering.** One event is emitted per top-level operation, not per field. Complexity scoring is the proxy for field-level cost.
- **Guaranteed delivery.** Events are buffered in memory; a hard crash or a flush that exhausts all 3 retries drops that batch (logged at `WARNING`). There is no on-disk spool.
- **Custom complexity weights via config.** The `field_count + 5 × max_depth` formula is fixed in `instrumentation()`. For a different weighting, call `record(...)` with your own number.
