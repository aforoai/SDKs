# ai.aforo:graphql-metering

Meter every GraphQL operation without touching your resolvers. Install one `Instrumentation` on your `graphql-java` schema and each query/mutation/subscription emits a billing event with AST-accurate complexity scoring (`field_count + 5 × max_depth`).

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>ai.aforo</groupId>
  <artifactId>graphql-metering</artifactId>
  <version>2.0.0</version>
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
        .customerResolver(params -> params.getGraphQLContext().get("aforoCustomerId"))
        .build();

GraphQL gql = GraphQL.newGraphQL(schema)
        .instrumentation(billing.instrumentation())
        .build();

// On shutdown, flush the buffer:
Runtime.getRuntime().addShutdownHook(new Thread(billing::close));
```

Events POST to `<ingestorUrl>/v1/ingest/batch` as `{"events": [...]}` (at most 1000 events per request; larger flushes are split) with `X-API-Key: <apiKey>` and `X-Tenant-Id: <tenantId>`. The SDK keeps events in a bounded queue (10 000 by default; overflow evicts the oldest as `OVERFLOW`). One background thread sends them every 5 seconds or as soon as 500 are queued. Retries use full-jitter backoff and honour `Retry-After` (seconds or HTTP-date, up to 60 s). If the ingestor stays unreachable, the batch goes back to the queue with the same idempotency keys and is resent after a cooldown, so an outage loses nothing while the queue has room. `close()` keeps sending for up to `shutdownTimeoutMs` (5 s) and reports what is left as `SHUTDOWN`.

> ⚠ `build()` throws unless you set `customerResolver(...)` or `trustCustomerHeader(true)`. Put the customer your HTTP layer authenticated into the `GraphQLContext` and read it with a resolver (see the quickstart). `trustCustomerHeader(true)` reads the `x-customer-id` / `customerId` context entry (from `GraphQLContext`, then a legacy `Map` context); use it only when that entry is set from an authenticated source, never copied from a request header. An operation with no customer is answered as usual and counted as `INVALID`.

## Configuration

Builder options on `AforoGraphQlBilling.newBuilder()`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | Sent as the `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | Stamped into each event's `metadata.productId` and the idempotency key. |
| `apiKey` | `String` | *(required)* | Aforo API key, sent as `X-API-Key`. |
| `ingestorUrl` | `String` | *(required)* | Ingestion host, `https://` (plain `http://` only for localhost or with `allowInsecureHttp`). The SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `schemaVersion` | `String` | *(none)* | Optional; added to `metadata.schemaVersion` when set. |
| `productType` | `String` | `GRAPHQL_API` | Top-level `productType` on every event (required by the ingestor). Trimmed and uppercased; unknown values are passed through. Per call: `record(customerId, query, operationName, durationMs, hasErrors, executionStatus, productType)` (a null/blank override uses the client value). |
| `flushCount` | `int` | `500` | Events per request (at most 1000); also how many queued events wake the sender. |
| `flushIntervalMs` | `long` | `5000` | How often queued events are sent when the batch is not full (ms). |
| `maxQueueSize` | `int` | `10000` | Queue capacity; when full, the oldest event is dropped as `OVERFLOW`. |
| `maxRetries` | `int` | `3` | Retries per request on a network error, timeout, 408, 429 or 5xx. |
| `retryBaseMs` | `long` | `500` | Base of the full-jitter backoff (each wait is random up to `min(30 s, base × 2^attempt)`). |
| `timeoutMs` | `long` | `10000` | Total deadline of one ingest request (ms). |
| `shutdownTimeoutMs` | `long` | `5000` | How long `close()` keeps sending; leftovers are reported as `SHUTDOWN`. |
| `breakerCooldownMs` | `long` | `5000` | Pause after a batch fails every retry or gets 401/403; doubles with jitter up to 5 minutes. |
| `allowInsecureHttp` | `boolean` | `false` | Accept a plain `http://` `ingestorUrl` on a host other than localhost / 127.0.0.1 / ::1. |
| `customerResolver` | `CustomerResolver` `params -> id` | *(required unless `trustCustomerHeader`)* | Reads the customer from your authentication, usually a `GraphQLContext` entry your HTTP layer set. |
| `trustCustomerHeader` | `boolean` | `false` | Read the `x-customer-id` / `customerId` context entry instead. |
| `customerIdExtractor` | `Function<InstrumentationExecutionParameters, String>` | — | Deprecated 1.x form of `customerResolver`. |

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
| `OVERFLOW` | The queue was full (usually during a long outage); the oldest event was evicted. |
| `SHUTDOWN` | Still queued when `close()` reached `shutdownTimeoutMs`. |
| `CLOSED` | Recorded after `close()`. Nothing is thrown. |
| `RETRY_EXHAUSTED` | Kept for compatibility. An outage no longer drops events: they wait in the queue and are resent with the same keys. |
| `REJECTED` | The ingestor answered a non-retryable 4xx for the batch, or accepted the batch (2xx) but refused individual events in `errors[]`. Only the events the response identifies by index are passed to the hook. |
| `INVALID` | The event breaks an ingestor field limit and was never sent: `customerId` over 64 characters, `productType` over 20. These values are never truncated. |

The operation name is read from the query, not set by you: one over 255 characters is cut to 255 on `gqlOperationName` and the event is still sent, with one `WARNING` per instance.

Dropped events keep their `idempotencyKey`, so storing them and re-sending later is dedup-safe. An exception thrown by the hook is swallowed.

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Per-field / per-resolver metering.** One event is emitted per top-level operation, not per field. Complexity scoring is the proxy for field-level cost.
- **Guaranteed delivery.** Events wait in an in-memory queue. A hard crash loses what is queued, and an overflow past `maxQueueSize` drops the oldest events (reported to `onDrop`). There is no on-disk spool. A `401` / `403` from the ingestor is treated as an outage and logged at `SEVERE`: fix the key and the queued events are delivered.
- **Custom complexity weights via config.** The `field_count + 5 × max_depth` formula is fixed in `instrumentation()`. For a different weighting, call `record(...)` with your own number.
