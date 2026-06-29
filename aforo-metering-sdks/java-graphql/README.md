# com.aforo:graphql-metering

Aforo GraphQL Metering SDK for Java. A graphql-java `Instrumentation` that meters every operation (query/mutation/subscription) with AST-accurate complexity scoring.

## Install

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>graphql-metering</artifactId>
  <version>1.0.0</version>
</dependency>
```

Peer dep: `com.graphql-java:graphql-java ^21` (provided by your application).

## Usage

```java
import com.aforo.graphql.AforoGraphQlBilling;
import graphql.GraphQL;

AforoGraphQlBilling billing = AforoGraphQlBilling.newBuilder()
    .tenantId("tenant_acme")
    .productId("prod_graphql_unified_gateway")
    .apiKey(System.getenv("AFORO_API_KEY"))
    .ingestorUrl("https://ingestor.aforo.ai")
    .schemaVersion("v2.1")
    .build();

GraphQL gql = GraphQL.newGraphQL(schema)
    .instrumentation(billing.instrumentation())
    .build();
```

## Complexity scoring

Default formula: `field_count + 5 × max_depth`. Computed by walking the parsed AST with a `NodeVisitorStub` — no string parsing, no regex.

To plug in a custom scorer, call `billing.record(...)` directly with your own complexity number instead of relying on the instrumentation.

## Customer-ID resolution

Default extractor reads `x-customer-id` (or `customerId`) from the GraphQL execution `Map<String,Object>` context. Override via the builder:

```java
.customerIdExtractor(params -> {
    Map<String, Object> ctx = (Map<String, Object>) params.getContext();
    return (String) ctx.get("authenticatedUserId");
})
```

Operations without a customer ID are not metered (safe for introspection / health endpoints).

## Errors

`gqlHasErrors` is `true` when the response includes a non-empty errors array OR the execution threw.

## Batching & retry

50 events / 5 s. 3× exponential retry. AutoCloseable.

## License

MIT
